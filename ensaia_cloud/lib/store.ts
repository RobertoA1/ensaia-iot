import {createClient} from 'redis';
import {get, put, list, del} from '@vercel/blob';
import type {Account, Command, Presence, Presentation} from './types.js';
import {hash,ipKey,passwordHash, randomToken, verifyPassword,seal,unseal} from './security.js';
import {buildLegacyReport, canViewLegacyReport, legacyArchiveId, type ArchiveIndex, type ArchiveManifest, type ArchiveSource, type LegacyReport} from './legacy-report.js';

function newClient(){return createClient({url:process.env.REDIS_URL,disableOfflineQueue:true,
  socket:{connectTimeout:8000,reconnectStrategy: (retries:number) => retries>3?new Error('Redis no disponible'):Math.min(retries*200,1500)}});}
let pending: Promise<ReturnType<typeof newClient>> | undefined;
export async function db():Promise<ReturnType<typeof newClient>> {
  if (!process.env.REDIS_URL) throw new Error('Falta la conexión de almacenamiento');
  if (!pending) {
    const client=newClient();
    client.on('error',()=>console.error('storage_connection_error'));
    pending=client.connect().then(()=>client).catch(e=>{pending=undefined;throw e;});
  }
  return pending!;
}
export const key=(name:string)=>`${process.env.REDIS_PREFIX||'ensaia:v1'}:${ipKey(name)}`;
const blobOptions=()=>({access:'private' as const,token:process.env.BLOB_READ_WRITE_TOKEN});
async function readJSON<T>(path:string):Promise<T|null> {
  const result=await get(path,{...blobOptions(),useCache:false});
  if(!result||result.statusCode!==200||!result.stream)return null;
  return JSON.parse(await new Response(result.stream).text()) as T;
}
async function writeJSON(path:string, value:unknown, overwrite=false) {
  await put(path,JSON.stringify(value),{...blobOptions(),contentType:'application/json',addRandomSuffix:false,
    allowOverwrite:overwrite,cacheControlMaxAge:60});
}
let historicalReport: Promise<LegacyReport> | undefined;
export function legacyReport(owner: Account): Promise<LegacyReport> {
  if (!canViewLegacyReport(owner)) throw new Error('Acceso administrativo requerido');
  const prefix = `legacy/${owner.username}/${legacyArchiveId}`;
  historicalReport ??= Promise.all([
    readJSON<ArchiveManifest>(`${prefix}/manifest.json`),
    readJSON<ArchiveSource>(`${prefix}/sessions.json`),
    readJSON<ArchiveIndex>(`${prefix}/index.json`),
  ]).then(([manifest, source, index]) => {
    if (!manifest || !source || !index) throw new Error('Archivo histórico no disponible');
    return buildLegacyReport(manifest, source, index);
  }).catch(error => {
    historicalReport = undefined;
    throw error;
  });
  return historicalReport;
}
export async function rateLimit(scope:string, limit:number, seconds:number) {
  const r=await db();
  const n=await r.incr(key(`rate:${scope}`));
  if(n===1)await r.expire(key(`rate:${scope}`),seconds);
  return n<=limit;
}
export async function account(username:string) {
  const r=await db();const cached=await r.get(key(`account:${username}`));
  if(cached)return JSON.parse(unseal(cached,`account:${username}`)) as Account;
  const value=await readJSON<Account>(`accounts/${username}.json`);
  if(value)await r.set(key(`account:${username}`),seal(JSON.stringify(value),`account:${username}`),{EX:3600});
  return value;
}
export async function enroll(deviceId:string,username:string,password:string) {
  const r=await db();const lock=key(`enroll:${deviceId}`),token=randomToken();
  if(!await r.set(lock,token,{NX:true,PX:15000}))throw new Error('El dispositivo se está registrando; vuelve a conectar');
  try {
    const known=await readJSON<Account>(`devices/${deviceId}.json`);
    if(known) {
      if(known.username!==username||!await verifyPassword(password,known.passwordHash))throw new Error('Las credenciales propuestas no coinciden con el registro del dispositivo');
      await r.set(key(`account:${username}`),seal(JSON.stringify(known),`account:${username}`),{EX:3600});
      return known;
    }
    let owner=await account(username);
    if(owner&&(owner.deviceId!==deviceId||!await verifyPassword(password,owner.passwordHash)))throw new Error('El nombre de usuario ya está ocupado');
    if(!owner){
      owner={deviceId,username,passwordHash:await passwordHash(password),createdAt:new Date().toISOString()};
      // Blob no permite sobrescritura: dos dispositivos no pueden apropiarse de un mismo usuario.
      await writeJSON(`accounts/${username}.json`,owner);
    }
    await writeJSON(`devices/${deviceId}.json`,owner);
    await r.set(key(`account:${username}`),seal(JSON.stringify(owner),`account:${username}`),{EX:3600});
    return owner;
  } finally {
    await r.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",{keys:[lock],arguments:[token]});
  }
}
export async function createLogin(username:string) {
  const token=randomToken();const r=await db();const owner=await account(username);
  if(!owner)throw new Error('Cuenta no disponible');
  const payload=JSON.stringify({username,authVersion:owner.authVersion||''});
  await r.set(key(`login:${hash(token)}`),seal(payload,`login:${hash(token)}`),{EX:28800});return token;
}
export async function loginOwner(token:string) {
  if(!/^[a-f0-9]{64}$/.test(token))return null;
  const r=await db();const value=await r.get(key(`login:${hash(token)}`));if(!value)return null;
  const raw=unseal(value,`login:${hash(token)}`);let username='',version='';
  try{const session=JSON.parse(raw);if(!session||typeof session.username!=='string'||typeof session.authVersion!=='string')return null;username=session.username;version=session.authVersion;}catch{username=raw;}
  const owner=await account(username);return owner&&(owner.authVersion||'')===version?username:null;
}
export async function logout(token:string){const r=await db();await r.del(key(`login:${hash(token)}`));}
export async function presence(value:Presence){const r=await db();await r.set(key(`presence:${value.deviceId}`),seal(JSON.stringify(value),`presence:${value.deviceId}`),{EX:20});}
export async function getPresence(deviceId:string):Promise<Presence|null>{const r=await db();const x=await r.get(key(`presence:${deviceId}`));return x?JSON.parse(unseal(x,`presence:${deviceId}`)):null;}
export async function claimDevice(deviceId:string,connectionId:string){const r=await db();return Boolean(await r.set(key(`lease:${deviceId}`),connectionId,{NX:true,PX:15000}));}
export async function renewDevice(deviceId:string,connectionId:string){
  const r=await db();return Boolean(await r.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],15000) else return 0 end",{keys:[key(`lease:${deviceId}`)],arguments:[connectionId]}));
}
export async function releaseDevice(deviceId:string,connectionId:string){
  const r=await db();return Boolean(await r.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",{keys:[key(`lease:${deviceId}`)],arguments:[connectionId]}));
}
export async function saveLive(p:Presentation){const r=await db();await r.set(key(`presentation:${p.id}`),seal(JSON.stringify(p),`presentation:${p.id}`),{EX:172800});}
export async function getPresentation(username:string,id:string) {
  if(!/^[a-f0-9]{16}$/.test(id))return null;
  const r=await db();const cached=await r.get(key(`presentation:${id}`));
  const value:Presentation|null=cached?JSON.parse(unseal(cached,`presentation:${id}`)):await readJSON<Presentation>(`sessions/${username}/${id}.json`);
  return value?.username===username?value:null;
}
export async function setActive(deviceId:string,sid:string){const r=await db();return Boolean(await r.set(key(`active:${deviceId}`),sid,{NX:true,EX:600}));}
/** Una toma larga no debe perder su marca de activa a los diez minutos. */
export async function touchActive(deviceId:string,sid:string){const r=await db();await r.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],600) else return 0 end",{keys:[key(`active:${deviceId}`)],arguments:[sid]});}
export async function activeSid(deviceId:string){const r=await db();return r.get(key(`active:${deviceId}`));}
export async function clearActive(deviceId:string,sid:string){const r=await db();await r.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",{keys:[key(`active:${deviceId}`)],arguments:[sid]});}
export async function sendCommand(deviceId:string,command:Command){
  const r=await db();await r.rPush(key(`commands:${deviceId}`),seal(JSON.stringify(command),`commands:${deviceId}`));
  await r.expire(key(`commands:${deviceId}`),300);await r.publish(key(`notify:${deviceId}`),'command');
}
export async function takeCommand(deviceId:string):Promise<Command|null>{const r=await db();const x=await r.lPop(key(`commands:${deviceId}`));return x?JSON.parse(unseal(x,`commands:${deviceId}`)):null;}
export async function checkpoint(p:Presentation){await writeJSON(`sessions/${p.username}/${p.id}.json`,p,true);}
export async function archive(p:Presentation,audio?:Buffer) {
  if(audio?.length){await put(`audio/${p.username}/${p.id}.wav`,audio,{...blobOptions(),addRandomSuffix:false,allowOverwrite:true,contentType:'audio/wav',cacheControlMaxAge:60});p.audioSaved=true;}
  p.archived=true;await checkpoint(p);await saveLive(p);
}
const partPath=(p:Presentation,i:number)=>`audio/${p.username}/${p.id}.part-${i}.pcm`;
/** PCM capturado por una conexión que va a renovarse; se une al WAV al terminar la toma. */
export async function saveAudioPart(p:Presentation,index:number,pcm:Buffer){
  await put(partPath(p,index),pcm,{...blobOptions(),addRandomSuffix:false,allowOverwrite:true,contentType:'application/octet-stream',cacheControlMaxAge:60});
}
export async function audioParts(p:Presentation):Promise<Buffer[]>{
  const parts:Buffer[]=[];
  for(let i=0;i<(p.audioParts??0);i++){
    const file=await get(partPath(p,i),{...blobOptions(),useCache:false});
    if(!file||file.statusCode!==200||!file.stream)throw new Error('Falta un segmento de audio');
    parts.push(Buffer.from(await new Response(file.stream).arrayBuffer()));
  }
  return parts;
}
export async function deleteAudioParts(p:Presentation){
  if(p.audioParts)await del(Array.from({length:p.audioParts},(_,i)=>partPath(p,i)),{token:process.env.BLOB_READ_WRITE_TOKEN});
}
export interface ResumeState {sid:string; meter:unknown; coach?:unknown}
/** Marca que una conexión está guardando la toma para que la siguiente la espere. */
export async function beginHandover(deviceId:string,sid:string){const r=await db();await r.set(key(`handover:${deviceId}`),sid,{EX:60});}
export async function cancelHandover(deviceId:string){const r=await db();await r.del(key(`handover:${deviceId}`));}
export async function saveResume(deviceId:string,state:ResumeState){
  const r=await db();await r.set(key(`resume:${deviceId}`),seal(JSON.stringify(state),`resume:${deviceId}`),{EX:120});await r.del(key(`handover:${deviceId}`));
}
export async function handoverPending(deviceId:string){const r=await db();return Boolean(await r.exists([key(`handover:${deviceId}`),key(`resume:${deviceId}`)]));}
/** Espera el estado que dejó la conexión anterior. Devuelve null si esa conexión no llegó a guardarlo. Sin `sid` acepta el de cualquier toma. */
export async function takeResume(deviceId:string,sid:string,waitMs=30000):Promise<ResumeState|null>{
  const r=await db();const until=Date.now()+waitMs;let last=false;
  for(;;){
    const raw=await r.getDel(key(`resume:${deviceId}`));
    if(raw){const state=JSON.parse(unseal(raw,`resume:${deviceId}`)) as ResumeState;return !sid||state.sid===sid?state:null;}
    if(last||Date.now()>until)return null;
    // Si la marca ya no existe, la conexión anterior terminó: se mira una vez más por si acaba de guardar.
    if(!await r.exists(key(`handover:${deviceId}`)))last=true;else await new Promise(done=>setTimeout(done,200));
  }
}
export async function history(username:string) {
  const result=await list({prefix:`sessions/${username}/`,limit:100,token:process.env.BLOB_READ_WRITE_TOKEN});
  const records=await Promise.all(result.blobs.map(x=>readJSON<Presentation>(x.pathname)));
  return records.filter((x):x is Presentation=>Boolean(x)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30)
    .map(({id,title,createdAt,phase,status,metrics,sourceComplete,assessments,assessmentError,mode})=>({id,title,createdAt,phase,status,metrics,sourceComplete,mode,scoreSource:assessments?.at(-1)?.source,score:assessmentError?null:(assessments?.at(-1)?.total??null)}));
}
export async function audioFile(username:string,sid:string) {
  return get(`audio/${username}/${sid}.wav`,blobOptions());
}
export async function subscriber(){const r=await db();const sub=r.duplicate();sub.on('error',()=>console.error('subscription_connection_error'));await sub.connect();return sub;}

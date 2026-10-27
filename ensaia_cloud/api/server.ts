import http, {type IncomingMessage, type ServerResponse} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {WebSocketServer} from 'ws';
import {DeviceConnection} from '../lib/device.js';
import {WhisperWorker,workerOnline} from '../lib/worker.js';
import * as store from '../lib/store.js';
import {ipKey,validUsername,verifyPassword} from '../lib/security.js';
import {SpeechMeter} from '../lib/metrics.js';
import {iso,terminal,type Presentation} from '../lib/types.js';

function json(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function token(req:IncomingMessage){return req.headers.cookie?.match(/(?:^|;\s*)ensaia_session=([a-f0-9]{64})(?:;|$)/)?.[1]??'';}
function sameOrigin(req:IncomingMessage){
  const origin=req.headers.origin;if(!origin)return false;
  try{return new URL(origin).host===(req.headers['x-forwarded-host']||req.headers.host);}catch{return false;}
}
async function body(req:IncomingMessage){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new Error('Usa JSON');
  let total=0;const chunks:Buffer[]=[];
  for await(const raw of req){const b=Buffer.from(raw);total+=b.length;if(total>4096)throw new Error('Solicitud demasiado grande');chunks.push(b);}
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
}
export async function handler(req:IncomingMessage,res:ServerResponse){
  const url=new URL(req.url||'/',`https://${req.headers.host||'localhost'}`);
  const action=url.searchParams.get('action')||'health';
  try {
    if(req.method==='GET'&&action==='health'){json(res,200,{ok:true,application:'ENSAIA',version:'1.0.0'});return;}
    if(req.method==='POST'&&!sameOrigin(req)){json(res,403,{error:'Origen no autorizado'});return;}
    if(action==='login'&&req.method==='POST'){
      const ip=String(req.headers['x-vercel-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0];
      if(!await store.rateLimit(`login:${ipKey(ip)}`,10,300)){json(res,429,{error:'Demasiados intentos. Espera cinco minutos.'});return;}
      const b=await body(req);
      if(!validUsername(b.username)||typeof b.password!=='string'||b.password.length>128){json(res,401,{error:'Usuario o contraseña incorrectos'});return;}
      const owner=await store.account(b.username);
      const ok=owner?await verifyPassword(b.password,owner.passwordHash):await verifyPassword(b.password,'scrypt:00000000000000000000000000000000:'+ '00'.repeat(64));
      if(!ok||!owner){json(res,401,{error:'Usuario o contraseña incorrectos'});return;}
      const session=await store.createLogin(owner.username);
      const secure=process.env.VERCEL?' Secure;':'';
      res.setHeader('Set-Cookie',`ensaia_session=${session}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=28800`);
      json(res,200,{username:owner.username});return;
    }
    const ownerName=await store.loginOwner(token(req));
    const owner=ownerName?await store.account(ownerName):null;
    if(!owner){json(res,401,{error:'Inicia sesión para acceder'});return;}
    if(action==='logout'&&req.method==='POST'){
      await store.logout(token(req));res.setHeader('Set-Cookie','ensaia_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');json(res,200,{ok:true});return;
    }
    if(action==='state'&&req.method==='GET'){
      const [device,sid]=await Promise.all([store.getPresence(owner.deviceId),store.activeSid(owner.deviceId)]);
      let presentation=sid?await store.getPresentation(owner.username,sid):null;
      if(presentation&&!terminal(presentation.status)&&(!device?.online||Date.now()-device.at>15000)&&Date.now()-Date.parse(presentation.createdAt)>30000){
        presentation.status='interrupted';presentation.sourceComplete=false;presentation.endedAt=iso();
        presentation.error='La conexión del dispositivo terminó. Se conservaron los registros disponibles.';
        await store.archive(presentation);await store.clearActive(owner.deviceId,presentation.id);
      }
      json(res,200,{username:owner.username,deviceId:owner.deviceId,device,
        presentation,aiConfigured:Boolean(process.env.OPENAI_API_KEY),workerOnline:await workerOnline(owner.deviceId),maxSeconds:180});return;
    }
    if(action==='history'&&req.method==='GET'){json(res,200,{sessions:await store.history(owner.username)});return;}
    if(['presentation','export','audio'].includes(action)&&req.method==='GET'){
      const id=url.searchParams.get('id')||'';const p=await store.getPresentation(owner.username,id);
      if(!p){json(res,404,{error:'Presentación no encontrada'});return;}
      if(action==='audio'){
        const file=p.audioSaved?await store.audioFile(owner.username,id):null;
        if(!file||file.statusCode!==200||!file.stream){json(res,404,{error:'Audio no disponible'});return;}
        res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'private, no-store','Content-Disposition':`attachment; filename="ENSAIA-${id}.wav"`});
        Readable.fromWeb(file.stream as never).pipe(res);return;
      }
      if(action==='export')res.setHeader('Content-Disposition',`attachment; filename="ENSAIA-${id}.json"`);
      json(res,200,p);return;
    }
    if(action==='start'&&req.method==='POST'){
      if(!await store.rateLimit(`start:${owner.username}`,10,300)){json(res,429,{error:'Espera antes de crear otra presentación'});return;}
      const b=await body(req);
      if(b.consent!==true){json(res,400,{error:'Confirma que aceptas grabar y procesar esta presentación'});return;}
      if(typeof b.title!=='string'||!b.title.trim()||b.title.length>120||!['pre','post','practice'].includes(String(b.phase))||
         !Number.isInteger(b.seconds)||Number(b.seconds)<15||Number(b.seconds)>180){json(res,400,{error:'Revisa el tema, la etapa y la duración (15 a 180 segundos)'});return;}
      if(b.audience!==undefined&&(typeof b.audience!=='string'||b.audience.length>120)){json(res,400,{error:'Revisa la descripción del público'});return;}
      const device=await store.getPresence(owner.deviceId);
      if(!device?.online||Date.now()-device.at>12000){json(res,409,{error:'El ESP32 está desconectado. Enciéndelo y espera la conexión.'});return;}
      if(!process.env.OPENAI_API_KEY){json(res,503,{error:'Configura la clave de IA en Vercel antes de grabar'});return;}
      const mode=b.mode==='whisper'?'whisper':'live';
      if(mode==='whisper'&&!await workerOnline(owner.deviceId)){json(res,409,{error:'Inicia Whisper en la laptop antes de grabar.'});return;}
      const id=randomBytes(8).toString('hex');
      if(!await store.setActive(owner.deviceId,id)){json(res,409,{error:'Ya hay una presentación activa'});return;}
      const p:Presentation={id,username:owner.username,deviceId:owner.deviceId,title:b.title.trim(),audience:typeof b.audience==='string'?b.audience.trim():'',phase:b.phase as Presentation['phase'],
        feedback:b.feedback!==false,mode,status:'pending',createdAt:iso(),durationLimit:Number(b.seconds),transcript:'',advice:'',summary:'',
        metrics:new SpeechMeter().metrics(''),events:[],providerFinalized:false,sourceComplete:false};
      try{await store.saveLive(p);await store.checkpoint(p);await store.sendCommand(owner.deviceId,{id:randomUUID(),op:'start',sid:id});}
      catch(e){await store.clearActive(owner.deviceId,id);throw e;}
      json(res,201,p);return;
    }
    if(action==='stop'&&req.method==='POST'){
      const b=await body(req);if(typeof b.id!=='string'){json(res,400,{error:'Sesión inválida'});return;}
      const p=await store.getPresentation(owner.username,b.id);
      if(!p){json(res,404,{error:'Presentación no encontrada'});return;}
      if(terminal(p.status)){json(res,200,p);return;}
      await store.sendCommand(owner.deviceId,{id:randomUUID(),op:'stop',sid:p.id});json(res,202,{ok:true});return;
    }
    json(res,404,{error:'Recurso no encontrado'});
  }catch(e){console.error('request_failed',{action,type:e instanceof Error?e.name:'unknown'});json(res,503,{error:'No se pudo completar la operación. Revisa la conexión e inténtalo nuevamente.'});}
}

const server=http.createServer((req,res)=>void handler(req,res));
const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
server.on('upgrade',(req,socket,head)=>{
  const url=new URL(req.url||'/',`https://${req.headers.host||'localhost'}`);
  const role=url.searchParams.get('role');
  if(url.pathname!=='/api/server'||!['device','worker'].includes(role||'')){
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');socket.destroy();return;
  }
  void(async()=>{
    const ip=String(req.headers['x-vercel-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0];
    if(!await store.rateLimit(`upgrade:${ipKey(ip)}`,25,60)){socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>{if(role==='worker')new WhisperWorker(ws);else new DeviceConnection(ws);});
  })().catch(()=>socket.destroy());
});
export default server;

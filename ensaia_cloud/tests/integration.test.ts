import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import {handler} from '../api/server.js';
import {DeviceConnection} from '../lib/device.js';
import {hash} from '../lib/security.js';
import * as store from '../lib/store.js';
import type {ProviderEvent} from '../lib/live.js';

const pause=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until<T>(fn:()=>Promise<T>,predicate:(x:T)=>boolean,seconds=20){const end=Date.now()+seconds*1000;let value:T;do{value=await fn();if(predicate(value))return value;await pause(150);}while(Date.now()<end);throw new Error('Tiempo de espera agotado');}

class FakeCoach {
  static delayClose=false;
  ready=false;failed=false;private frames=0;
  constructor(private event:(e:ProviderEvent)=>void){}
  async open(){this.ready=true;}
  audio(pcm:Buffer){if(pcm.length!==640)return;this.frames++;if(this.frames===1)this.event({type:'session.input_transcript.delta',delta:'Buenos días, eh, hoy hablaremos del tiempo. '});if(this.frames===15){this.event({type:'session.input_transcript.delta',delta:'Organizar nuestras ideas nos ayuda a comunicar mejor mejor. Por ejemplo podemos escribir una lista de tareas, elegir lo más importante y dejar tiempo para descansar. Así los estudiantes pueden reducir las prisas y terminar sus actividades con mayor tranquilidad. '});this.event({type:'session.output_transcript.delta',delta:'Haz una pausa breve antes de tu idea central.'});}}
  cue(){}
  summarize(){this.event({type:'session.output_transcript.delta',delta:'Fortalezas: presentaste un tema concreto. Tres aspectos por mejorar: revisar la muletilla, evitar la repetición involuntaria y separar ideas. Ejercicio: ensayar una introducción breve. [PROVEEDOR SIMULADO DE PRUEBA]'});}
  async close(){if(FakeCoach.delayClose)await pause(6000);return true;}
  abort(){this.failed=true;}
}

test('dispositivo autorizado → usuario → web → grabación → log → archivo privado; rechaza secreto inválido y acceso ajeno',async()=>{
  assert.ok(process.env.REDIS_URL&&process.env.BLOB_READ_WRITE_TOKEN,'Ejecuta con las variables de desarrollo del proyecto');
  const suffix=randomBytes(5).toString('hex'),deviceId=`qa-${suffix}`,username=`qa_${suffix}`,password=randomBytes(20).toString('hex'),secret=randomBytes(32).toString('hex');
  process.env.REDIS_PREFIX=`ensaia:qa:${suffix}`;process.env.DEVICE_SECRETS=JSON.stringify({[deviceId]:hash(secret)});
  const server=http.createServer((req,res)=>void handler(req,res));
  const wss=new WebSocketServer({server,maxPayload:4096});
  const assessmentCalls:{final:boolean;ideal:string}[]=[];let assessmentFail=false;
  wss.on('connection',ws=>new DeviceConnection(ws,event=>new FakeCoach(event),async(_text,seconds,final=false,_audience='',ideal='')=>{assessmentCalls.push({final,ideal});if(assessmentFail)throw new Error('fallo simulado');return ({seconds,at:new Date().toISOString(),total:80,dimensions:{clarity:{score:80,evidence:'Buenos días',suggestion:'Define la idea'},organization:{score:80,evidence:'Organizar',suggestion:'Ordena'},development:{score:80,evidence:'Por ejemplo',suggestion:'Ejemplifica'}},complexity:'Explica el término',next:'Añade un ejemplo.'});}));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const connect=async()=>{const ws=new WebSocket(base.replace('http','ws')+'/api/server?role=device');await new Promise<void>(r=>ws.once('open',r));return ws;};
  const request=async(action:string,method='GET',value?:unknown,cookie='')=>fetch(base+'/api/server?action='+action,{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:value?JSON.stringify(value):undefined});
  let node:WebSocket|undefined,capture:ReturnType<typeof setInterval>|undefined,frames=0,sid='',silent=false;
  const status=setInterval(()=>{if(node?.readyState===WebSocket.OPEN)node.send(JSON.stringify({type:'device.status',rssi:-45,peak:0}));},2000);
  try {
    const rejected=await connect();
    const rejection=new Promise<any>(r=>rejected.once('message',raw=>r(JSON.parse(raw.toString()))));
    rejected.send(JSON.stringify({type:'device.auth',deviceId,secret:'wrong'.repeat(20),username,password}));
    assert.equal((await rejection).type,'auth.error');await pause(50);assert.equal(await store.account(username),null);
    node=await connect();
    const authorized=new Promise<any>(r=>node!.once('message',raw=>r(JSON.parse(raw.toString()))));
    node.send(JSON.stringify({type:'device.auth',deviceId,secret,username,password}));
    assert.equal((await authorized).type,'auth.ok');
    node.on('message',raw=>{
      const event=JSON.parse(raw.toString());
      if(event.type==='capture.start'){
        sid=event.sid;frames=0;node!.send(JSON.stringify({type:'capture.started',sid}));
        capture=setInterval(()=>{const packet=Buffer.alloc(664);packet.write(sid);packet.writeUInt32LE(frames,16);packet.writeUInt32LE(frames*320,20);for(let i=24;i<664;i+=2)packet.writeInt16LE(silent?0:1000,i);node!.send(packet);frames++;},20);
      }else if(event.type==='capture.stop'){
        if(capture)clearInterval(capture);node!.send(JSON.stringify({type:'capture.ended',sid,frames,reason:'user'}));
      }
    });
    const badLogin=await request('login','POST',{username,password:'incorrecta'});assert.equal(badLogin.status,401);
    const login=await request('login','POST',{username,password});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie')!.split(';')[0];assert.match(login.headers.get('set-cookie')!,/HttpOnly/);
    const anonymous=await request('start','POST',{title:'QA',phase:'practice',seconds:15,consent:true});assert.equal(anonymous.status,401);
    const csrf=await fetch(base+'/api/server?action=start',{method:'POST',headers:{Origin:'https://otro.example','Content-Type':'application/json',Cookie:cookie},body:'{}'});assert.equal(csrf.status,403);
    const denied=await request('start','POST',{title:'QA',phase:'practice',seconds:15,consent:false},cookie);assert.equal(denied.status,400);
    const start=await request('start','POST',{title:'Prueba técnica sintética — no es participante humano',phase:'practice',seconds:15,consent:true,feedback:true,idealText:'Guion de prueba con ideas de referencia'},cookie);
    assert.equal(start.status,201);const created=await start.json();
    await until(async()=>frames,n=>n>=25);
    const stop=await request('stop','POST',{id:created.id},cookie);assert.equal(stop.status,202);
    const result=await until(async()=>{const r=await request('presentation&id='+created.id,'GET',undefined,cookie);return r.json();},p=>['completed','interrupted','error'].includes(p.status));
    assert.equal(result.status,'completed');assert.equal(result.sourceComplete,true);assert.equal(result.providerFinalized,true);assert.equal(result.archived,true);
    assert.equal(result.metrics.frames,frames);assert.equal(result.expectedFrames,frames);assert.match(result.transcript,/Buenos días/);assert.match(result.summary,/PROVEEDOR SIMULADO/);
    assert.ok(result.assessments.length>=1);assert.equal(result.assessments.at(-1).total,80);assert.equal(result.idealText,'Guion de prueba con ideas de referencia');assert.ok(assessmentCalls.some(call=>call.ideal===result.idealText));
    const history=await until(async()=>{const response=await request('history','GET',undefined,cookie);return response.json();},x=>x.sessions.some((v:any)=>v.id===created.id));
    assert.equal(history.sessions.find((v:any)=>v.id===created.id).score,80);
    assert.ok(result.events.some((x:any)=>x.kind==='advice'));assert.ok(result.events.some((x:any)=>x.kind==='transcript'));
    const audio=await request('audio&id='+created.id,'GET',undefined,cookie);assert.equal(audio.status,200);
    const bytes=Buffer.from(await audio.arrayBuffer());assert.equal(bytes.length,44+frames*640);assert.equal(bytes.readUInt32LE(24),16000);assert.equal(bytes.readInt16LE(44),1000);
    assert.equal(await store.getPresentation('otro_usuario',created.id),null);
    const otherName=`qa_otro_${suffix}`;await store.enroll(`qa-otro-${suffix}`,otherName,password);
    const foreignCookie='ensaia_session='+await store.createLogin(otherName);
    const foreign=await request('audio&id='+created.id,'GET',undefined,foreignCookie);assert.equal(foreign.status,404);
    await assert.rejects(()=>store.enroll(deviceId,otherName,password),/no coinciden/);
    const exported=await request('export&id='+created.id,'GET',undefined,cookie);assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition')!,/attachment/);
    // Una captura que contiene únicamente ceros no debe aparecer como grabación útil.
    silent=true;frames=0;const callsBeforeQuiet=assessmentCalls.length;
    const silentStart=await request('start','POST',{title:'QA sin señal',phase:'practice',seconds:15,consent:true,feedback:false},cookie);
    assert.equal(silentStart.status,201);const silentSession=await silentStart.json();
    await until(async()=>frames,n=>n>=25);
    assert.equal(assessmentCalls.length,callsBeforeQuiet,'Sin consejos no debe evaluarse durante la toma');
    await request('stop','POST',{id:silentSession.id},cookie);
    const silentResult=await until(async()=>{const r=await request('presentation&id='+silentSession.id,'GET',undefined,cookie);return r.json();},p=>['completed','interrupted','error'].includes(p.status));
    assert.equal(silentResult.status,'interrupted');assert.match(silentResult.error,/sin señal/);
    assert.equal(assessmentCalls.length,callsBeforeQuiet+1);assert.equal(assessmentCalls.at(-1)?.final,true);
    // Dos conexiones simultáneas no se aceptan, pero el dispositivo debe poder
    // reconectar cuando el socket anterior cerró, incluso mientras se archiva.
    const duplicate=await connect();const duplicateReply=new Promise<any>(r=>duplicate.once('message',raw=>r(JSON.parse(raw.toString()))));
    duplicate.send(JSON.stringify({type:'device.auth',deviceId,secret,username,password}));
    assert.equal((await duplicateReply).type,'auth.error');
    silent=false;frames=0;FakeCoach.delayClose=true;assessmentFail=true;
    const finalStart=await request('start','POST',{title:'QA reconexión',phase:'practice',seconds:15,consent:true},cookie);
    assert.equal(finalStart.status,201);const finalSession=await finalStart.json();
    await until(async()=>frames,n=>n>=25);if(capture)clearInterval(capture);
    const closed=new Promise<void>(r=>node!.once('close',()=>r()));node!.close();await closed;await pause(300);
    node=await connect();const reconnected=new Promise<any>(r=>node!.once('message',raw=>r(JSON.parse(raw.toString()))));
    node.send(JSON.stringify({type:'device.auth',deviceId,secret,username,password}));
    assert.equal((await reconnected).type,'auth.ok');
    const reconnectResult=await until(async()=>{const r=await request('presentation&id='+finalSession.id,'GET',undefined,cookie);return r.json();},p=>['completed','interrupted','error'].includes(p.status));
    assert.equal(reconnectResult.status,'interrupted');assert.match(reconnectResult.assessmentError,/No se pudo obtener la evaluación/);
    assert.equal((await store.getPresence(deviceId))?.online,true);
    assert.equal((await request('logout','POST',{},cookie)).status,200);assert.equal((await request('state','GET',undefined,cookie)).status,401);
  }finally{
    clearInterval(status);if(capture)clearInterval(capture);node?.close();await pause(500);
    for(const ws of wss.clients)ws.terminate();
    await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));
    const redis=await store.db();await redis.close();
  }
});

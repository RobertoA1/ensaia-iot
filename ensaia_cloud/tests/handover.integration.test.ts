// Relevo de conexión contra Redis y Blob reales. Tarda algo más de un minuto: espera el umbral de la plataforma.
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
async function until<T>(fn:()=>Promise<T>|T,ok:(x:T)=>boolean,seconds=30){const end=Date.now()+seconds*1000;let v:T;do{v=await fn();if(ok(v))return v;await pause(150);}while(Date.now()<end);throw new Error('Tiempo de espera agotado');}
class FakeCoach{
  static opened:any[]=[];ready=false;failed=false;
  constructor(private event:(e:ProviderEvent)=>void){}
  async open(_feedback:boolean,resume?:any){FakeCoach.opened.push(resume);this.ready=true;setTimeout(()=>this.event({type:'session.input_transcript.delta',delta:resume?'Segunda parte de la exposición. ':'Primera parte de la exposición. ',start_ms:0,end_ms:500}),300);}
  audio(){}cue(){}
  summarize(){this.event({type:'session.output_transcript.delta',delta:'Fortalezas: continuidad. Tres aspectos por mejorar: ritmo, pausas y ejemplos. Ejercicio: ensayar otra vez.'});}
  async close(){return true;}abort(){this.failed=true;}
}

test('relevo real: Redis conserva el estado, Blob los segmentos y el WAV queda completo',async()=>{
  assert.ok(process.env.REDIS_URL&&process.env.BLOB_READ_WRITE_TOKEN,'Ejecuta con las variables de desarrollo del proyecto');
  const suffix=randomBytes(5).toString('hex'),deviceId=`qa-h-${suffix}`,username=`qa_h_${suffix}`,password=randomBytes(20).toString('hex'),secret=randomBytes(32).toString('hex');
  process.env.REDIS_PREFIX=`ensaia:qa:${suffix}`;process.env.DEVICE_SECRETS=JSON.stringify({[deviceId]:hash(secret)});
  delete process.env.VERCEL;process.env.CONNECTION_MAX_SECONDS='120';   // relevo a los 60 s de conexión
  const server=http.createServer((req,res)=>void handler(req,res));
  const wss=new WebSocketServer({server,maxPayload:4096});
  wss.on('connection',ws=>new DeviceConnection(ws,event=>new FakeCoach(event) as any,async()=>null,async(_t,topic)=>({onTopic:true,detected:topic,confidence:90})));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const request=(action:string,method='GET',value?:unknown,cookie='')=>fetch(base+'/api/server?action='+action,{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:value?JSON.stringify(value):undefined});
  // Placa simulada con el mismo comportamiento que el firmware v2.
  const ring:Buffer[]=[];let sid='',sent=0,sending=false,capturing=false,node:WebSocket|undefined,connections=0,resumeFrom=-1,handoverAt=0,resumedAt=0;
  const capture=setInterval(()=>{if(!capturing)return;const b=Buffer.alloc(664);b.write(sid);b.writeUInt32LE(ring.length,16);b.writeUInt32LE(ring.length*320,20);for(let i=24;i<664;i+=2)b.writeInt16LE(1500+ring.length%11,i);ring.push(b);},20);
  const pump=setInterval(()=>{for(let i=0;i<8&&sending&&node?.readyState===WebSocket.OPEN&&sent<ring.length;i++)node.send(ring[sent++]);},10);
  const status=setInterval(()=>{if(node?.readyState===WebSocket.OPEN)node.send(JSON.stringify({type:'device.status',rssi:-50,peak:1500}));},2000);
  const connect=async(resume?:string)=>{
    const ws=new WebSocket(base.replace('http','ws')+'/api/server?role=device');await new Promise<void>(r=>ws.once('open',r));node=ws;connections++;
    ws.on('message',raw=>{
      const m=JSON.parse(raw.toString());
      if(m.type==='capture.start'){sid=m.sid;capturing=true;sending=true;ws.send(JSON.stringify({type:'capture.started',sid}));}
      else if(m.type==='capture.handover'){sending=false;handoverAt=Date.now();ws.close();void connect(sid);}
      else if(m.type==='capture.resume'){resumeFrom=m.frames;sent=m.frames;sending=true;resumedAt=Date.now();}
      else if(m.type==='capture.stop'){capturing=false;const flush=setInterval(()=>{if(sent<ring.length)return;clearInterval(flush);ws.send(JSON.stringify({type:'capture.ended',sid,frames:ring.length,reason:'user'}));},20);}
    });
    ws.send(JSON.stringify({type:'device.auth',deviceId,secret,username,password,handover:true,...(resume?{resume}:{})}));
  };
  try{
    await connect();
    const login=await until(async()=>request('login','POST',{username,password}),r=>r.status===200);
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const state=await until(async()=>(await request('state','GET',undefined,cookie)).json(),x=>Boolean(x.device?.online));
    assert.equal(state.device.handover,true);assert.equal(state.sessionCapSeconds,7200);
    const start=await request('start','POST',{title:'QA relevo — prueba sintética',phase:'practice',seconds:0,endWord:'cierre total',consent:true},cookie);
    assert.equal(start.status,201);const created=await start.json();
    await until(()=>resumeFrom,n=>n>=0,90);
    console.log(`relevo: ${resumedAt-handoverAt} ms sin envío; ${ring.length-resumeFrom} tramas retenidas al reanudar`);
    assert.equal(connections,2);assert.ok(resumeFrom>1000,'la primera conexión recibió cerca de un minuto de audio');
    const live=await until(async()=>(await request('state','GET',undefined,cookie)).json(),s=>/Segunda parte/.test(s.presentation?.transcript||''));
    assert.equal(live.presentation.status,'recording');assert.equal(live.presentation.handovers,1);assert.equal(live.presentation.audioParts,1);
    assert.match(FakeCoach.opened[1].transcript,/Primera parte/);
    const second=live.presentation.events.filter((e:any)=>e.kind==='transcript').at(-1);assert.equal(second.startMs,resumeFrom*20);
    await pause(1500);
    assert.equal((await request('stop','POST',{id:created.id},cookie)).status,202);
    const result=await until(async()=>(await request('presentation&id='+created.id,'GET',undefined,cookie)).json(),p=>['completed','interrupted','error'].includes(p.status),40);
    assert.equal(result.status,'completed',result.error);assert.equal(result.sourceComplete,true);assert.equal(result.endedBy,'user');
    assert.equal(result.metrics.frames,ring.length);assert.equal(result.metrics.missingFrames,0);
    assert.match(result.transcript,/Primera parte de la exposición\. Segunda parte de la exposición\./);
    const audio=Buffer.from(await(await request('audio&id='+created.id,'GET',undefined,cookie)).arrayBuffer());
    assert.equal(audio.length,44+ring.length*640);
    assert.ok(audio.subarray(44).equals(Buffer.concat(ring.map(f=>f.subarray(24)))),'el WAV coincide con lo capturado en ambas conexiones');
    // Los segmentos temporales se eliminan y no queda estado de relevo.
    assert.deepEqual(await store.audioParts({...result,audioParts:1}).catch(()=>'eliminado'),'eliminado');
    assert.equal(await store.handoverPending(deviceId),false);
  }finally{
    clearInterval(capture);clearInterval(pump);clearInterval(status);node?.close();await pause(500);
    for(const ws of wss.clients)ws.terminate();
    await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));
    await(await store.db()).close();delete process.env.CONNECTION_MAX_SECONDS;
  }
});

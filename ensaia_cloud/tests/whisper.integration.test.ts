import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {randomBytes} from 'node:crypto';import WebSocket,{WebSocketServer} from 'ws';
import {handler} from '../api/server.js';import {DeviceConnection} from '../lib/device.js';import {WhisperWorker} from '../lib/worker.js';import {hash} from '../lib/security.js';import * as store from '../lib/store.js';
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until<T>(fn:()=>Promise<T>,ok:(x:T)=>boolean){const end=Date.now()+45000;while(Date.now()<end){const v=await fn();if(ok(v))return v;await sleep(200);}throw Error('Tiempo de espera agotado');}

test('Whisper local recibe el audio y devuelve texto a la presentación; GPT-Live sigue independiente',async()=>{
 const suffix=randomBytes(5).toString('hex'),deviceId='qa-w-'+suffix,username='qa_w_'+suffix,password=randomBytes(20).toString('hex'),secret=randomBytes(32).toString('hex');
 process.env.REDIS_PREFIX='ensaia:qa:'+suffix;process.env.DEVICE_SECRETS=JSON.stringify({[deviceId]:hash(secret)});
 const realFetch=globalThis.fetch;globalThis.fetch=(async(input:any,init?:any)=>{if(String(input)==='https://api.openai.com/v1/responses'){const instructions=JSON.parse(init.body).instructions;const dimension=(score:number,evidence:string)=>({score,evidence,suggestion:'Añade un ejemplo.'});const text=instructions.startsWith('Eres evaluador')?JSON.stringify({clarity:dimension(80,'Hoy presento mi tema'),organization:dimension(75,'Primero'),development:dimension(85,'Por ejemplo'),complexity:'Explica el término.',next:'Añade un ejemplo.'}):'Fortalezas: tema claro. Mejora el ritmo, las pausas y la conclusión. Ejercicio: ensaya otra vez.';return new Response(JSON.stringify({output:[{content:[{type:'output_text',text}]}]}),{status:200,headers:{'Content-Type':'application/json'}});}return realFetch(input,init);}) as typeof fetch;
 const server=http.createServer((req,res)=>void handler(req,res));const wss=new WebSocketServer({server,maxPayload:4096});
 wss.on('connection',(ws,req)=>{if(req.url?.includes('role=worker'))new WhisperWorker(ws);else new DeviceConnection(ws);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const connect=async(role:string)=>{const ws=new WebSocket(base.replace('http','ws')+'/api/server?role='+role);await new Promise<void>(r=>ws.once('open',r));return ws;};
 const msg=(ws:WebSocket)=>new Promise<any>(r=>ws.once('message',x=>r(JSON.parse(x.toString()))));
 const request=(a:string,method='GET',body?:any,cookie='')=>fetch(base+'/api/server?action='+a,{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:body?JSON.stringify(body):undefined});
 let worker:WebSocket|undefined,device:WebSocket|undefined,timer:ReturnType<typeof setInterval>|undefined,frames=0;
 try{
  worker=await connect('worker');let wready=msg(worker);worker.send(JSON.stringify({type:'worker.auth',deviceId,secret}));assert.equal((await wready).type,'worker.ready');
  worker.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='audio')worker!.send(JSON.stringify({type:'transcript',sid:m.sid,text:'Hoy presento mi tema con claridad. Primero vamos a ordenar las ideas principales y luego mostraremos su utilidad. Por ejemplo una lista de tareas ayuda a un estudiante a encontrar tiempo para descansar, cumplir sus obligaciones y evitar dejar todo para el último momento.'}));if(m.type==='end')worker!.send(JSON.stringify({type:'ended',sid:m.sid}));});
  device=await connect('device');let ready=msg(device);device.send(JSON.stringify({type:'device.auth',deviceId,secret,username,password}));assert.equal((await ready).type,'auth.ok');
  device.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='capture.start'){frames=0;device!.send(JSON.stringify({type:'capture.started',sid:m.sid}));timer=setInterval(()=>{const p=Buffer.alloc(664);p.write(m.sid);p.writeUInt32LE(frames,16);p.writeUInt32LE(frames*320,20);for(let i=24;i<664;i+=2)p.writeInt16LE(900,i);device!.send(p);frames++;},20);}else if(m.type==='capture.stop'){if(timer)clearInterval(timer);device!.send(JSON.stringify({type:'capture.ended',sid:m.sid,frames,reason:'user'}));}});
  const login=await request('login','POST',{username,password});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const start=await request('start','POST',{title:'QA Whisper',phase:'practice',seconds:15,feedback:true,consent:true,mode:'whisper'},cookie);assert.equal(start.status,201);const session=await start.json();
  await until(async()=>frames,x=>x>=80);await request('stop','POST',{id:session.id},cookie);
  const result=await until(async()=>{const r=await request('presentation&id='+session.id,'GET',undefined,cookie);return r.json();},p=>['completed','interrupted','error'].includes(p.status));
  assert.equal(result.status,'completed');assert.equal(result.summarySource,'text-ai');assert.match(result.transcript,/Hoy presento/);assert.equal(result.sourceComplete,true);assert.ok(result.assessments.length>0);assert.equal(result.assessments.at(-1).total,80);
 }finally{if(timer)clearInterval(timer);device?.close();worker?.close();await sleep(1000);for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));await(await store.db()).close();globalThis.fetch=realFetch;}
});

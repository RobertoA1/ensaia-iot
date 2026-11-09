// Sesión completa del dispositivo con almacenamiento en memoria: no usa Redis, Blob ni la IA.
import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {Presentation,Command} from '../lib/types.js';
import type {ProviderEvent} from '../lib/live.js';

const presentations=new Map<string,Presentation>(),commands:Command[]=[];let archived:Presentation|undefined,touched=0;
const parts:Buffer[]=[];let archivedAudio:Buffer|undefined,resumeState:any,marker=false;
mock.module('../lib/store.js',{exports:{
  key:(x:string)=>x,enroll:async(deviceId:string,username:string)=>({deviceId,username,passwordHash:'',createdAt:''}),
  claimDevice:async()=>true,renewDevice:async()=>true,releaseDevice:async()=>true,
  subscriber:async()=>({subscribe:async()=>{},isOpen:true,close:async()=>{}}),
  presence:async()=>{},takeCommand:async()=>commands.shift()??null,
  getPresentation:async(_u:string,id:string)=>presentations.get(id)??null,
  saveLive:async()=>{},checkpoint:async()=>{},touchActive:async()=>{touched++;},clearActive:async()=>{},
  archive:async(p:Presentation,audio?:Buffer)=>{p.archived=true;archived=structuredClone(p);archivedAudio=audio;},
  saveAudioPart:async(_p:Presentation,i:number,pcm:Buffer)=>{parts[i]=Buffer.from(pcm);},audioParts:async(p:Presentation)=>parts.slice(0,p.audioParts??0),
  deleteAudioParts:async()=>{parts.length=0;},beginHandover:async()=>{marker=true;},cancelHandover:async()=>{marker=false;},
  saveResume:async(_d:string,state:any)=>{resumeState=structuredClone(state);marker=false;},handoverPending:async()=>marker||Boolean(resumeState),
  takeResume:async(_d:string,sid:string)=>{for(let i=0;i<200&&!resumeState&&marker;i++)await new Promise(r=>setTimeout(r,20));const x=resumeState;resumeState=undefined;return x?.sid===sid?x:null;},db:async()=>{throw new Error('sin redis');},activeSid:async()=>null,
}} as any);
const {DeviceConnection}=await import('../lib/device.js');
const {hash}=await import('../lib/security.js');
const {SpeechMeter}=await import('../lib/metrics.js');

const pause=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until(check:()=>boolean,ms=30000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('Tiempo de espera agotado');await pause(40);}}
class Socket extends EventEmitter{readyState=1;sent:any[]=[];send(x:string){this.sent.push(JSON.parse(x));this.emit('out',this.sent.at(-1));}close(){this.readyState=3;this.emit('close');}terminate(){this.close();}}
class Coach{ready=false;failed=false;cues:string[]=[];summary='';static last:Coach;
  constructor(public event:(e:ProviderEvent)=>void){Coach.last=this;}
  resumed?:any;audioFrames=0;closed=false;
  async open(_f:boolean,resume?:any){this.resumed=resume;this.ready=true;}audio(){this.audioFrames++;}cue(c:string){this.cues.push(c);}
  summarize(c:string){this.summary=c;this.event({type:'session.output_transcript.delta',delta:'Fortalezas: tema claro. Tres aspectos por mejorar: ritmo, pausas y ejemplos. Ejercicio: ensayar.'});}
  async close(){this.closed=true;await pause(300);return true;}abort(){this.failed=true;}
  say(delta:string,timing?:{start_ms:number;end_ms:number}){this.event({type:'session.input_transcript.delta',delta,...timing});}}

test('tema distinto, interrupción con silencio de escucha, toma sin límite y palabra de cierre',async()=>{
  process.env.DEVICE_SECRETS=JSON.stringify({'qa-s3':hash('s'.repeat(64))});delete process.env.VERCEL;delete process.env.CONNECTION_MAX_SECONDS;
  const sid='0123456789abcdef',socket=new Socket();
  const p:Presentation={id:sid,username:'qa_user',deviceId:'qa-s3',title:'La fotosíntesis',phase:'practice',feedback:true,mode:'live',status:'pending',createdAt:new Date().toISOString(),
    durationLimit:0,endWord:'ensaia finalizar',transcript:'',advice:'',summary:'',metrics:new SpeechMeter().metrics(''),events:[],providerFinalized:false,sourceComplete:false};
  presentations.set(sid,p);
  const topicCalls:string[]=[];let offTopic=false;
  new DeviceConnection(socket as any,event=>new Coach(event) as any,async()=>null,
    async(_text,topic)=>{topicCalls.push(topic);return offTopic&&topic==='La fotosíntesis'?{onTopic:false,detected:'el fútbol peruano',confidence:92}:{onTopic:true,detected:topic,confidence:90};});
  let frames=0,capture:ReturnType<typeof setInterval>|undefined;
  const packet=(loud:boolean)=>{const b=Buffer.alloc(664);b.write(sid);b.writeUInt32LE(frames,16);b.writeUInt32LE(frames*320,20);if(loud)for(let i=24;i<664;i+=2)b.writeInt16LE(3000,i);frames++;return b;};
  let loud=true;
  socket.on('out',(m:any)=>{
    if(m.type==='capture.start'){assert.equal(m.maxSeconds,14400);socket.emit('message',Buffer.from(JSON.stringify({type:'capture.started',sid})),false);
      capture=setInterval(()=>socket.emit('message',packet(loud),true),4);}
    if(m.type==='capture.stop'){clearInterval(capture);socket.emit('message',Buffer.from(JSON.stringify({type:'capture.ended',sid,frames,reason:'user'})),false);}
  });
  try{
    commands.push({id:'c1',op:'start',sid});
    socket.emit('message',Buffer.from(JSON.stringify({type:'device.auth',deviceId:'qa-s3',secret:'s'.repeat(64),username:'qa_user',password:'p'.repeat(20)})),false);
    await until(()=>p.status==='recording');
    const coach=Coach.last;
    // 1) Mientras el tema coincide no hay aviso.
    coach.say('Hoy voy a explicar cómo las plantas convierten la luz del sol en energía química dentro de sus hojas verdes usando agua y dióxido de carbono. ');
    await until(()=>topicCalls.length===1);await pause(50);
    assert.equal(p.declaredTitle,undefined);assert.equal(p.events.some(e=>e.interrupt),false);
    // 2) Se habla de otro asunto: hace falta confirmarlo dos veces.
    offTopic=true;const text='La selección juega el domingo y el delantero viene de marcar tres goles en el campeonato local con su club. ';
    const original=Date.now;let shift=0;Date.now=()=>original()+shift;
    try{
      shift+=20000;coach.say(text);await until(()=>topicCalls.length===2);await pause(50);
      assert.equal(p.title,'La fotosíntesis','una sola verificación no cambia el tema');
      shift+=20000;coach.say(text);await until(()=>p.title==='el fútbol peruano');
      assert.equal(p.declaredTitle,'La fotosíntesis');assert.deepEqual(p.topicShifts?.map(x=>[x.from,x.to]),[['La fotosíntesis','el fútbol peruano']]);
      const notice=p.events.find(e=>e.interrupt)!;
      assert.match(notice.text,/hablas de «el fútbol peruano» y no de «La fotosíntesis»/);assert.ok(notice.holdMs!>4000);
      const sent=socket.sent.find(m=>m.type==='feedback');assert.equal(sent.interrupt,true);assert.equal(sent.holdMs,notice.holdMs);
      // 3) El usuario calla para escuchar: ese silencio no es pausa ni espacio muerto.
      const before=frames;loud=false;await until(()=>frames-before>=100);loud=true;await until(()=>frames-before>=120);
      // Un consejo que llega durante la escucha no se encadena.
      coach.event({type:'session.output_transcript.delta',delta:'Habla más despacio.'});await pause(1500);
      assert.equal(p.events.filter(e=>e.interrupt).length,1);
      // Lo captado durante la escucha (la propia voz de ENSAIA) no entra en la transcripción.
      const startMs=Math.round(notice.audioMs!)+200;coach.say('detecto que hablas de fútbol ',{start_ms:startMs,end_ms:startMs+1000});
      assert.equal(p.transcript.includes('detecto que hablas'),false);
      // 4) Pasada la escucha, el consejo sí interrumpe y la verificación usa el tema nuevo.
      shift+=60000;coach.event({type:'session.output_transcript.delta',delta:'Separa las dos ideas con una pausa.'});
      await until(()=>p.events.filter(e=>e.interrupt).length===2,5000);
      coach.say('Además el entrenador cambió la táctica del equipo para el partido del domingo en el estadio nacional de Lima. ');
      await until(()=>topicCalls.at(-1)==='el fútbol peruano');
      assert.ok(coach.cues.some(c=>c.includes('"tema"')));
      // 5) La palabra de cierre termina la toma sin límite y no queda en la transcripción.
      coach.say('Y eso es todo. Ensaya, ');coach.say('finalizar.');
    }finally{Date.now=original;}
    await until(()=>Boolean(archived));
    const r=archived!;
    assert.equal(r.endedBy,'endword');assert.equal(r.status,'completed');assert.equal(r.sourceComplete,true);
    assert.match(r.transcript,/Y eso es todo\.$/);assert.equal(/finalizar/i.test(r.transcript),false);
    assert.equal(r.metrics.longPauses,0,'el silencio de escucha no es una pausa prolongada');
    assert.ok(r.metrics.interruptionSeconds!>=1.9);assert.ok(r.metrics.silenceSeconds<0.5);
    assert.ok(r.metrics.recentRms!>0.05,'el nivel reciente no refleja el silencio de escucha');
    assert.match(Coach.last.summary,/temaEscritoPorElUsuario":"La fotosíntesis"/);
    assert.ok(socket.sent.some(m=>m.type==='session.ended'&&m.status==='completed'));
  }finally{clearInterval(capture);socket.close();await pause(100);}
});

test('la toma continúa en una conexión nueva cuando la plataforma va a cortar la actual',async()=>{
  process.env.DEVICE_SECRETS=JSON.stringify({'qa-s3':hash('s'.repeat(64))});delete process.env.VERCEL;process.env.CONNECTION_MAX_SECONDS='120';
  archived=undefined;archivedAudio=undefined;parts.length=0;
  const sid='fedcba9876543210';
  const p:Presentation={id:sid,username:'qa_user',deviceId:'qa-s3',title:'Las mareas',phase:'practice',feedback:true,mode:'live',status:'pending',createdAt:new Date().toISOString(),
    durationLimit:0,endWord:'ensaia finalizar',transcript:'',advice:'',summary:'',metrics:new SpeechMeter().metrics(''),events:[],providerFinalized:false,sourceComplete:false};
  presentations.set(sid,p);
  // Placa simulada: captura siempre, conserva las tramas y reenvía desde donde le indique el servidor.
  const ring:Buffer[]=[];let sent=0,sending=false,capturing=false,resumeFrom=-1,socket=new Socket(),connections=0;
  const capture=setInterval(()=>{if(!capturing)return;const b=Buffer.alloc(664);b.write(sid);b.writeUInt32LE(ring.length,16);b.writeUInt32LE(ring.length*320,20);for(let i=24;i<664;i+=2)b.writeInt16LE(2000+ring.length%7,i);ring.push(b);},4);
  const pump=setInterval(()=>{for(let i=0;i<8&&sending&&sent<ring.length;i++)socket.emit('message',ring[sent++],true);},4);
  const connect=(resume?:string)=>{
    const current=socket=new Socket();connections++;
    new DeviceConnection(current as any,event=>new Coach(event) as any,async()=>null,async(_t,topic)=>({onTopic:true,detected:topic,confidence:90}));
    current.on('out',(m:any)=>{
      if(m.type==='capture.start'){capturing=true;sending=true;current.emit('message',Buffer.from(JSON.stringify({type:'capture.started',sid})),false);}
      if(m.type==='capture.handover'){sending=false;setTimeout(()=>{current.close();connect(sid);},30);}
      if(m.type==='capture.resume'){resumeFrom=m.frames;sent=m.frames;sending=true;}
      if(m.type==='capture.stop'){capturing=false;const flush=setInterval(()=>{if(sent<ring.length)return;clearInterval(flush);current.emit('message',Buffer.from(JSON.stringify({type:'capture.ended',sid,frames:ring.length,reason:'user'})),false);},5);}
    });
    current.emit('message',Buffer.from(JSON.stringify({type:'device.auth',deviceId:'qa-s3',secret:'s'.repeat(64),username:'qa_user',password:'p'.repeat(20),handover:true,...(resume?{resume}:{})})),false);
    return current;
  };
  const original=Date.now;let shift=0;Date.now=()=>original()+shift;
  try{
    commands.push({id:'h1',op:'start',sid});
    const first=connect();
    await until(()=>p.status==='recording');
    assert.equal(first.sent.find(m=>m.type==='auth.ok').handover,true);
    assert.equal(first.sent.find(m=>m.type==='capture.start').maxSeconds,7200,'con renovación, una toma sin límite dura hasta dos horas');
    const coachA=Coach.last;coachA.say('Las mareas suben y bajan dos veces al día por la atracción de la Luna. ',{start_ms:0,end_ms:900});
    await until(()=>ring.length>=150);
    // La conexión se acerca al límite de la plataforma (120 s menos la reserva de 60 s).
    shift+=61000;
    await until(()=>connections===2&&resumeFrom>=0,15000);
    const coachB=Coach.last;assert.notEqual(coachB,coachA);assert.equal(coachA.closed,true);
    assert.equal(first.sent.at(-1).type,'capture.handover');
    assert.ok(resumeFrom>=150&&resumeFrom<ring.length,'la placa reenvía desde la última trama que recibió la conexión anterior');
    assert.match(coachB.resumed.transcript,/atracción de la Luna/);assert.equal(coachB.resumed.title,'Las mareas');
    assert.equal(p.audioParts,1);assert.equal(parts[0].length,resumeFrom*640);
    const live=presentations.get(sid)!;assert.equal(live.status,'recording');assert.equal(live.handovers,1);
    // La IA nueva cuenta el tiempo desde cero: el servidor lo desplaza al tiempo real de la toma.
    coachB.say('También influye el Sol. ',{start_ms:100,end_ms:800});
    const event=live.events.filter(e=>e.kind==='transcript').at(-1)!;assert.equal(event.startMs,100+resumeFrom*20);
    await until(()=>coachB.audioFrames>50);
    coachB.say('Ensaia finalizar.');
    await until(()=>Boolean(archived));
  }finally{Date.now=original;clearInterval(capture);clearInterval(pump);delete process.env.CONNECTION_MAX_SECONDS;}
  const r=archived!;
  assert.equal(r.status,'completed');assert.equal(r.sourceComplete,true);assert.equal(r.endedBy,'endword');
  assert.equal(r.metrics.frames,ring.length);assert.equal(r.metrics.missingFrames,0);
  assert.match(r.transcript,/atracción de la Luna\. También influye el Sol\.$/);
  // El WAV reúne lo de ambas conexiones, sin huecos ni tramas repetidas.
  assert.equal(archivedAudio!.length,44+ring.length*640);
  assert.deepEqual(archivedAudio!.subarray(44),Buffer.concat(ring.map(f=>f.subarray(24))));
  assert.equal(parts.length,0,'los segmentos se eliminan al terminar');
  socket.close();await pause(100);
});

test('si la conexión anterior no dejó su estado, la toma se cierra con el audio ya guardado',async()=>{
  process.env.DEVICE_SECRETS=JSON.stringify({'qa-s3':hash('s'.repeat(64))});
  archived=undefined;archivedAudio=undefined;parts.length=0;resumeState=undefined;marker=false;
  const sid='00112233445566aa',saved=Buffer.alloc(6400,7);parts[0]=saved;
  const p:Presentation={id:sid,username:'qa_user',deviceId:'qa-s3',title:'Las mareas',phase:'practice',feedback:true,mode:'live',status:'recording',createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),
    durationLimit:0,transcript:'Las mareas suben y bajan. ',advice:'',summary:'',metrics:{...new SpeechMeter().metrics(''),frames:10,seconds:0.2},events:[],providerFinalized:false,sourceComplete:false,audioParts:1};
  presentations.set(sid,p);
  const socket=new Socket();
  socket.on('out',(m:any)=>{if(m.type==='capture.stop')socket.emit('message',Buffer.from(JSON.stringify({type:'capture.ended',sid,frames:400,reason:'user'})),false);});
  new DeviceConnection(socket as any,event=>new Coach(event) as any,async()=>null,async()=>null);
  socket.emit('message',Buffer.from(JSON.stringify({type:'device.auth',deviceId:'qa-s3',secret:'s'.repeat(64),username:'qa_user',password:'p'.repeat(20),handover:true,resume:sid})),false);
  await until(()=>Boolean(archived));
  assert.equal(archived!.status,'interrupted');assert.match(archived!.error!,/No se pudo continuar la toma/);
  assert.equal(archived!.metrics.frames,10,'se conservan las métricas ya guardadas');
  assert.deepEqual(archivedAudio!.subarray(44),saved);
  assert.ok(socket.sent.some(m=>m.type==='capture.stop'));assert.equal(socket.sent.some(m=>m.type==='capture.resume'),false);
  socket.close();await pause(100);
});

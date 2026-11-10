import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {LiveCoach, type ProviderEvent} from './live.js';
import {LiveAdviceBuffer} from './live-advice.js';
import {WhisperCoach} from './whisper-coach.js';
import {evaluateTranscript,attachEvidenceRanges} from './assessment.js';
import {SpeechMeter, parseAudio, fallbackSummary, wav} from './metrics.js';
import {FINALIZE_RESERVE_SECONDS, findEndWord, holdFor, platformLimitSeconds, sessionCapSeconds} from './control.js';
import {checkTopic, type TopicVerdict} from './topic.js';
import {validDeviceId, validUsername, verifyDevice} from './security.js';
import * as store from './store.js';
import {iso, terminal, type Account, type CoachResume, type Presentation, type SpeechEvent} from './types.js';
type Coach=Pick<LiveCoach,'ready'|'failed'|'audio'|'cue'|'summarize'|'close'|'abort'>&{
  open(feedback:boolean,resume?:CoachResume):Promise<void>;
  /** Deja la sesión de IA lista para que otra conexión la continúe; devuelve lo que esa conexión necesita. */
  suspend?():Promise<unknown>;
};

export class DeviceConnection {
  private owner?:Account; private lease=randomUUID(); private sub?:Awaited<ReturnType<typeof store.subscriber>>;
  private authenticated=false; private dead=false; private disconnected=false; private closing=false; private archiving=false; private born=Date.now();
  private lastDeviceMessage=Date.now();
  private tickBusy=false; private commandsBusy=false; private chain=Promise.resolve();
  private active?:Presentation; private meter?:SpeechMeter; private chunks:Buffer[]=[];
  private coach?:Coach; private peak=0; private rssi=-100; private lastFlush=0; private lastCheckpoint=0;
  private summaryMode=false; private lastSummary=0; private lastCue=0;
  private lastAssessment=0; private assessmentJob?:Promise<void>; private liveAdvice?:LiveAdviceBuffer;
  private captureEnded?:()=>void; private stopExpected?:number; private captureError?:string;
  private finishing?:Promise<void>; private topicJob?:Promise<void>; private lastTopicCheck=0; private topicStrikes=0; private topicWords=0; private topicInterval=12000; private nextInterruptAt=0; private opened=Date.now(); private lastTouch=0;
  // Renovación de conexión: la plataforma corta cada conexión a los N segundos y la toma debe continuar en la siguiente.
  private deviceHandover=false; private handoverQueued=false; private handingOver=false; private handoverJob?:Promise<void>; private resuming=false; private timeBase=0;
  private get busy(){return this.closing||this.handingOver;}
  private get cap(){return sessionCapSeconds(this.deviceHandover);}
  private authTimer:ReturnType<typeof setTimeout>; private timer:ReturnType<typeof setInterval>;
  constructor(private socket:WebSocket,private makeCoach:(event:(e:ProviderEvent)=>void,error:(message:string)=>void)=>Coach=(e,f)=>new LiveCoach(e,f),private evaluate:typeof evaluateTranscript=evaluateTranscript,private topicCheck:(transcript:string,topic:string)=>Promise<TopicVerdict|null>=checkTopic) {
    this.authTimer=setTimeout(()=>socket.close(1008,'Autenticación requerida'),8000);
    this.timer=setInterval(()=>void this.tick(),2000);
    socket.on('message',(raw,binary)=>{
      this.lastDeviceMessage=Date.now();
      const data=Buffer.isBuffer(raw)?raw:Buffer.from(raw as ArrayBuffer);
      this.chain=this.chain.then(()=>this.receive(data,binary)).catch(()=>this.fail('No se pudo procesar el audio del dispositivo'));
    });
    socket.on('close',()=>void this.cleanup());
    socket.on('error',()=>void this.fail('Se interrumpió la conexión con el dispositivo'));
  }
  private send(value:unknown){if(this.socket.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(value));}
  private log(kind:SpeechEvent['kind'],text:string,timing?:Pick<SpeechEvent,'startMs'|'endMs'|'rangeSource'>) {
    const p=this.active;if(!p||!text)return;
    const last=p.events.at(-1),at=iso();
    if(!timing&&last?.kind===kind&&Date.now()-Date.parse(last.at)<1200&&kind!=='system'&&kind!=='error')last.text+=text;
    else p.events.push({id:p.events.length,kind,text,at,audioMs:Math.round((this.meter?.samples??0)/16),...timing});
  }
  private async receive(data:Buffer,binary:boolean) {
    if(this.dead||this.disconnected)return;
    if(!this.authenticated){
      if(binary||data.length>2048){this.socket.close(1008,'Registro inválido');return;}
      let body:Record<string,unknown>;try{body=JSON.parse(data.toString());}catch{this.socket.close(1008);return;}
      const {deviceId,secret,username,password}=body;
      if(body.type!=='device.auth'||!validDeviceId(deviceId)||typeof secret!=='string'||!verifyDevice(deviceId,secret)||
         !validUsername(username)||typeof password!=='string'||password.length<16||password.length>128){
        this.send({type:'auth.error',message:'Dispositivo o credenciales no autorizados'});this.socket.close(1008);return;
      }
      try {
        // El secreto se verifica antes de que pueda crearse un usuario o abrirse una sesión de IA.
        this.owner=await store.enroll(deviceId,username,password);
        clearTimeout(this.authTimer);
        this.deviceHandover=body.handover===true;
        const resume=typeof body.resume==='string'&&/^[a-f0-9]{16}$/.test(body.resume)?body.resume:'';
        let claimed=await store.claimDevice(deviceId,this.lease);
        // Al continuar una toma, la conexión anterior puede tardar unos segundos en soltar el dispositivo.
        for(const until=Date.now()+20000;!claimed&&resume&&Date.now()<until&&this.socket.readyState===WebSocket.OPEN;){
          await new Promise(done=>setTimeout(done,250));claimed=await store.claimDevice(deviceId,this.lease);
        }
        if(!claimed)throw new Error('El dispositivo ya tiene una conexión activa');
        this.resuming=Boolean(resume);this.authenticated=true;
        this.sub=await store.subscriber();
        await this.sub.subscribe(store.key(`notify:${deviceId}`),()=>void this.commands());
        await this.writePresence();
        this.send({type:'auth.ok',username,maxSeconds:180,handover:true});
        // Sin `resume` también se revisa: una placa reiniciada a mitad de la renovación deja una toma por cerrar.
        if(resume||await store.handoverPending(deviceId)){this.resuming=true;await this.resume(resume);}
        await this.commands();
      }catch(e){this.send({type:'auth.error',message:e instanceof Error?e.message:'No se pudo registrar el dispositivo'});this.socket.close(1008);}
      return;
    }
    if(binary){
      if(!this.active||!this.meter||!this.coach||this.stopExpected!==undefined||this.handingOver)return;
      if(!['recording','closing'].includes(this.active.status))throw new Error('La captura comenzó antes de estar preparada');
      try {
        const pcm=parseAudio(data,this.active.id,this.meter.frames);
        this.coach.audio(pcm);this.meter.audio(pcm);this.chunks.push(Buffer.from(pcm));
        if(this.meter.frames%20===0)this.send({type:'audio.ack',sid:this.active.id,frames:this.meter.frames});
      }catch(e){this.meter.missingFrames++;await this.fail(e instanceof Error?e.message:'Audio inválido');}
      return;
    }
    if(data.length>4096)throw new Error('Mensaje de control demasiado grande');
    const event=JSON.parse(data.toString());
    if(event.type==='device.status'){
      if(Number.isFinite(event.peak))this.peak=Math.max(0,Math.min(32768,event.peak));
      if(Number.isFinite(event.rssi))this.rssi=event.rssi;
    }else if(event.type==='capture.started'&&this.active&&event.sid===this.active.id&&this.active.status==='starting'){
      this.active.status='recording';this.active.startedAt=iso();this.log('system','Comenzó la captura del INMP441');await this.flush();
    }else if(event.type==='capture.ended'&&this.active&&event.sid===this.active.id){
      if(!Number.isInteger(event.frames)||event.frames<0||event.frames>14400*50)throw new Error('Total de audio inválido');
      this.stopExpected=event.frames;
      this.captureEnded?.();
      if(!this.closing)void this.finish(event.reason&&event.reason!=='user'?'El dispositivo detuvo la captura':undefined);
    }else if(event.type==='capture.error')await this.fail('Captura interrumpida: '+String(event.reason||'error de micrófono').slice(0,100));
  }
  private async commands(){
    if(!this.owner||this.dead||this.disconnected||this.commandsBusy||this.handingOver||this.resuming)return;
    this.commandsBusy=true;
    try {
      for(let i=0;i<5;i++){
        const command=await store.takeCommand(this.owner.deviceId);if(!command)break;
        if(command.op==='start')await this.start(command.sid);
        else if(command.op==='stop'&&command.sid===this.active?.id){this.active.endedBy??='user';void this.finish();}
      }
    }catch{await this.fail('No se pudo aplicar el control de grabación');}
    finally{this.commandsBusy=false;}
  }
  private async start(sid:string){
    if(!this.owner||this.active||this.closing)return;
    const p=await store.getPresentation(this.owner.username,sid);if(!p||p.status!=='pending')return;
    this.prepare(p);
    p.status='starting';this.log('system','Preparando la conexión de IA');await this.flush();
    try {
      await this.coach!.open(p.feedback);
      if(this.dead||this.closing)throw new Error('El dispositivo se desconectó durante el inicio');
      this.send({type:'capture.start',sid:p.id,sampleRate:16000,samplesPerFrame:320,maxSeconds:p.durationLimit||this.cap});
      this.log('system','IA conectada. Esperando confirmación del micrófono');
      setTimeout(()=>{if(this.active?.id===p.id&&p.status==='starting')void this.fail('El micrófono no confirmó el inicio');},7000).unref();
    }catch(e){await this.fail(e instanceof Error?e.message:'No se pudo iniciar la IA');}
  }
  /** Estado de una toma en esta conexión, tanto al empezarla como al continuarla. */
  private prepare(p:Presentation){
    this.active=p;this.meter=new SpeechMeter();this.chunks=[];this.stopExpected=undefined;this.timeBase=0;
    this.captureError=undefined;this.summaryMode=false;this.lastSummary=0;this.lastCue=0;this.lastAssessment=0;this.assessmentJob=undefined;
    this.topicJob=undefined;this.lastTopicCheck=0;this.topicStrikes=0;this.topicWords=0;this.topicInterval=12000;this.nextInterruptAt=0;
    this.liveAdvice=new LiveAdviceBuffer(text=>{if(this.active?.id===p.id)this.advise(text);},1200);
    const onEvent=(e:ProviderEvent)=>this.providerEvent(e);
    const onError=(message:string)=>{if(!this.closing)void this.fail(message);};
    this.coach=p.mode==='whisper'?new WhisperCoach(p.deviceId,p.id,onEvent,onError):this.makeCoach(onEvent,onError);
  }
  /** Conexión que va a caducar: guarda la toma y pide a la placa que siga capturando mientras reconecta. */
  private async handover(){
    const p=this.active,meter=this.meter,owner=this.owner;
    if(!p||!meter||!owner||this.busy||p.status!=='recording'||this.stopExpected!==undefined)return;
    this.liveAdvice?.flush();
    this.handingOver=true;
    const job=(async()=>{
      try{
        await store.beginHandover(owner.deviceId,p.id);
        this.log('system','Renovando la conexión con el servidor. La toma continúa.');
        // Desde aquí la placa retiene el audio; lo reenviará a partir de la trama que esta conexión recibió.
        this.send({type:'capture.handover',sid:p.id});
        const coach=this.coach?.suspend?await this.coach.suspend():void await this.coach?.close();
        if(this.chunks.length){await store.saveAudioPart(p,p.audioParts??0,Buffer.concat(this.chunks));p.audioParts=(p.audioParts??0)+1;this.chunks=[];}
        // La IA confirmó el cierre de esta sesión parcial, no el de la toma.
        p.metrics=meter.metrics(p.transcript);p.providerFinalized=false;
        await store.saveLive(p);await store.checkpoint(p);
        await store.saveResume(owner.deviceId,{sid:p.id,meter:meter.snapshot(),coach});
        this.liveAdvice?.discard();this.liveAdvice=undefined;this.active=undefined;this.meter=undefined;this.coach=undefined;
        this.dead=true;clearInterval(this.timer);
        await store.releaseDevice(owner.deviceId,this.lease).catch(()=>{});
        if(this.sub?.isOpen)await this.sub.close().catch(()=>{});
        this.socket.close(1012,'Renovar conexión');
      }catch{
        // La marca se retira al final: la conexión nueva espera a que esta toma quede cerrada y no la retoma.
        this.handingOver=false;this.coach?.abort();
        try{await this.finish('No se pudo renovar la conexión del servidor');}finally{await store.cancelHandover(owner.deviceId).catch(()=>{});}
      }
    })();
    this.handoverJob=job;await job;
  }
  /** Conexión nueva: retoma la toma que dejó la anterior y le dice a la placa desde qué trama reenviar. */
  private async resume(sid:string){
    const owner=this.owner!;let p:Presentation|null=null;
    try{
      const state=await store.takeResume(owner.deviceId,sid);
      const id=sid||state?.sid||'';
      p=id?await store.getPresentation(owner.username,id):null;
      if(!sid||!state||!p||p.status!=='recording')throw new Error('Sin estado para continuar');
      this.prepare(p);this.meter=SpeechMeter.restore(state.meter as ReturnType<SpeechMeter['snapshot']>);
      // GPT-Live cuenta el tiempo desde su nueva sesión; Whisper conserva su reloj.
      this.timeBase=p.mode==='whisper'?0:Math.round(this.meter.samples/16);
      p.handovers=(p.handovers??0)+1;
      await this.coach!.open(p.feedback,{title:p.title,audience:p.audience||'',transcript:p.transcript,state:state.coach});
      if(this.dead||this.disconnected)throw new Error('El dispositivo se desconectó al continuar');
      this.resuming=false;
      this.send({type:'capture.resume',sid,frames:this.meter.frames});
      this.log('system','Conexión renovada. La toma continúa.');await this.flush();
    }catch{
      this.resuming=false;
      if(p&&(p.status==='recording'||this.active?.id===p.id)){
        // No se pudo continuar: se cierra con lo que ya estaba guardado. `capture.stop` detiene la placa.
        if(this.active?.id!==p.id){this.active=p;this.meter=undefined;this.coach=undefined;this.chunks=[];}
        else this.coach?.abort();
        this.log('error','No se pudo continuar la toma tras renovar la conexión');
        // Sin esperar: la respuesta de la placa a `capture.stop` llega por esta misma cola de mensajes.
        void this.finish('No se pudo continuar la toma tras renovar la conexión');
      }else if(sid)this.send({type:'capture.lost',sid});
    }
  }
  private providerEvent(e:ProviderEvent){
    const p=this.active;if(!p||this.dead)return;
    if(e.type==='session.input_transcript.delta'&&typeof e.delta==='string'){
      const validTiming=typeof e.start_ms==='number'&&typeof e.end_ms==='number'&&e.start_ms>=0&&e.end_ms>=e.start_ms;
      const startMs=validTiming?(e.start_ms as number)+this.timeBase:0,endMs=validTiming?(e.end_ms as number)+this.timeBase:0;
      // Lo que el micrófono capta mientras ENSAIA habla en voz alta no es parte de la exposición.
      if(validTiming&&this.meter?.inInterruption(startMs,endMs))return;
      p.transcript+=e.delta;this.log('transcript',e.delta,validTiming?{startMs,endMs,rangeSource:p.mode==='whisper'?'block':'provider'}:undefined);
      if(p.transcript.length>100000&&!this.busy){p.endedBy??='limit';this.log('system','La transcripción alcanzó el máximo de esta toma. Finalizando.');void this.finish();return;}
      if(p.endWord&&!this.busy){
        const at=findEndWord(p.transcript.slice(-300),p.endWord);
        if(at>=0){
          p.transcript=(p.transcript.slice(0,p.transcript.length-300>0?p.transcript.length-300+at:at)).trimEnd();
          p.endedBy='endword';this.log('system',`Palabra de cierre «${p.endWord}» detectada. Finalizando.`);void this.finish();return;
        }
      }
      const words=p.transcript.trim().split(/\s+/).length;
      if(!this.busy&&!this.topicJob&&Date.now()-this.lastTopicCheck>this.topicInterval&&words-this.topicWords>=12&&words>=20)void this.checkTopic(p);
      if(p.feedback&&!this.busy&&Date.now()-this.lastAssessment>20000&&words>=25)void this.assess(p);
      if(p.feedback&&!this.busy&&Date.now()-this.lastCue>4000&&words>=12){
        this.lastCue=Date.now();this.coach?.cue(JSON.stringify({metrics:this.meter?.metrics(p.transcript),tema:p.title,publico:p.audience||'No especificado',recentTranscript:p.transcript.slice(-500)}));
      }
    }else if(e.type==='session.output_transcript.delta'&&typeof e.delta==='string'){
      if(this.summaryMode){p.summary+=e.delta;this.lastSummary=Date.now();}
      else if(p.feedback){if(p.mode==='live')this.liveAdvice?.push(e.delta);else this.advise(e.delta.trim());}
    }else if(e.type==='session.closed')p.providerFinalized=true;
  }
  /** Interrumpe al usuario: la web y el monitor serie lo anuncian ya, y el silencio de escucha no cuenta como pausa. */
  private interrupt(text:string){
    const p=this.active;if(!p||!text)return;
    const holdMs=holdFor(text);this.nextInterruptAt=Date.now()+holdMs+5000;
    this.meter?.interrupt(holdMs);
    p.events.push({id:p.events.length,kind:'advice',text,at:iso(),audioMs:Math.round((this.meter?.samples??0)/16),interrupt:true,holdMs});
    p.advice+=text+' ';
    this.send({type:'feedback',text:text.slice(0,700),interrupt:true,holdMs});
  }
  /** Consejo normal; se descarta si aún se está escuchando o se acaba de interrumpir. */
  private advise(text:string){
    const p=this.active;if(!p||!p.feedback||this.busy||!text||Date.now()<this.nextInterruptAt)return;
    this.interrupt(text.slice(0,300));
  }
  private async checkTopic(p:Presentation){
    this.lastTopicCheck=Date.now();this.topicWords=p.transcript.trim().split(/\s+/).length;
    const job=(async()=>{
      try{
        const v=await this.topicCheck(p.transcript,p.title);
        if(this.active?.id!==p.id||this.busy||!v)return;
        // Si el tema coincide se verifica cada vez con menos frecuencia (hasta 45 s).
        if(v.onTopic||v.confidence<70){this.topicStrikes=0;this.topicInterval=Math.min(45000,this.topicInterval+6000);return;}
        // Dos verificaciones seguidas evitan reaccionar a una digresión breve; la segunda llega pronto.
        if(++this.topicStrikes<2){this.topicInterval=6000;return;}
        this.topicStrikes=0;this.topicInterval=12000;
        const from=p.title;p.declaredTitle??=from;p.title=v.detected;
        (p.topicShifts??=[]).push({at:iso(),from,to:v.detected});
        this.log('system',`Discrepancia de tema: se escribió «${from}» y se habla de «${v.detected}». Se toma «${v.detected}» como tema.`);
        if(p.feedback){const text=`Detecto que hablas de «${v.detected}» y no de «${from}». Tomaré «${v.detected}» como tu tema.`;
          this.nextInterruptAt=0;this.interrupt(text);}
      }catch{}
    })();
    this.topicJob=job;try{await job;}finally{if(this.topicJob===job)this.topicJob=undefined;}
  }
  private async assess(p:Presentation,final=false){
    if(this.assessmentJob){if(!final)return;await this.assessmentJob;}
    if(this.active?.id!==p.id)return;
    this.lastAssessment=Date.now();
    const transcript=p.transcript, seconds=this.meter?.metrics(transcript).seconds??0;
    const job=(async()=>{
      try{
        const result=await this.evaluate(transcript,seconds,final,p.audience||'',p.idealText||'');
        if(this.active?.id!==p.id)return;
        if(!result){if(transcript.trim().split(/\s+/).length>=35)p.assessmentError='No se pudo obtener una evaluación válida de la IA.';return;}
        p.assessmentError=undefined;
        (p.assessments??=[]).push(attachEvidenceRanges(result,p.events));
        if(!final&&p.feedback&&result.next&&!this.busy)this.advise(result.next);
      }catch{if(this.active?.id===p.id)p.assessmentError='No se pudo obtener la evaluación de IA. Revisa la conexión y el acceso al proveedor.';}
    })();
    this.assessmentJob=job;
    try{await job;}finally{if(this.assessmentJob===job)this.assessmentJob=undefined;}
  }
  private async flush(){
    if(!this.active)return;
    this.active.metrics=this.meter?.metrics(this.active.transcript)??this.active.metrics;
    await store.saveLive(this.active);this.lastFlush=Date.now();
  }
  private async writePresence(){
    if(this.owner)await store.presence({online:true,at:Date.now(),deviceId:this.owner.deviceId,username:this.owner.username,
      firmware:this.deviceHandover?'ensaia-cloud-s3-v2':'ensaia-cloud-s3-v1',rssi:this.rssi,peak:this.peak,sid:this.active?.id,handover:this.deviceHandover});
  }
  private async tick(){
    if(!this.authenticated||!this.owner||this.dead||this.tickBusy||this.handingOver)return;
    this.tickBusy=true;
    try {
      // Un socket que quedó abierto tras perder la red no debe renovar su
      // exclusividad indefinidamente. El ESP32 envía estado cada dos segundos.
      if(Date.now()-this.lastDeviceMessage>15000){this.socket.terminate();return;}
      if(!await store.renewDevice(this.owner.deviceId,this.lease)){await this.fail('La conexión perdió su autorización');this.socket.close(1012);return;}
      await this.writePresence();
      void this.commands();
      if(this.active){
        if(this.active.startedAt&&!this.closing&&Date.now()-Date.parse(this.active.startedAt)>(this.active.durationLimit||this.cap)*1000){this.active.endedBy??='limit';void this.finish();}
        // La plataforma corta la conexión a los N segundos. Si la placa sabe continuar, la toma pasa a una
        // conexión nueva; si no, se cierra antes para conservar el informe y el audio.
        const platform=platformLimitSeconds();
        if(platform&&!this.busy&&!this.handoverQueued&&this.active.status==='recording'&&Date.now()-this.opened>(platform-FINALIZE_RESERVE_SECONDS)*1000){
          if(this.deviceHandover){this.handoverQueued=true;this.chain=this.chain.then(()=>this.handover());}
          else{this.active.endedBy??='limit';this.log('system','Se alcanzó el tiempo máximo de conexión de este servidor. Finalizando para conservar el informe.');void this.finish();}
        }
        if(!this.active)return;
        if(Date.now()-this.lastTouch>60000){this.lastTouch=Date.now();await store.touchActive(this.active.deviceId,this.active.id);}
        if(!this.archiving&&Date.now()-this.lastFlush>900)await this.flush();
        if(!this.archiving&&Date.now()-this.lastCheckpoint>8000){this.lastCheckpoint=Date.now();await store.checkpoint(this.active);}
      }else if(!this.resuming&&Date.now()-this.born>55000){this.send({type:'reconnect'});this.socket.close(1000,'Renovar conexión');}
    }catch{await this.fail('El almacenamiento temporal no está disponible');}
    finally{this.tickBusy=false;}
  }
  private async finish(error?:string){
    if(this.finishing)return this.finishing;
    this.finishing=this.finalize(error);
    try{await this.finishing;}finally{this.finishing=undefined;}
  }
  private async finalize(error?:string){
    const p=this.active;if(!p||this.closing)return;
    this.closing=true;this.captureError=error;p.status='closing';await this.flush().catch(()=>{});
    this.log('system','Finalizando la captura y preparando el informe');
    if(this.stopExpected===undefined&&this.socket.readyState===WebSocket.OPEN){
      await new Promise<void>(resolve=>{
        this.captureEnded=resolve;this.send({type:'capture.stop',sid:p.id});
        const timer=setTimeout(resolve,7000);timer.unref();
      });
    }
    p.expectedFrames=this.stopExpected;
    p.sourceComplete=!error&&this.stopExpected!==undefined&&this.stopExpected===this.meter?.frames&&Boolean(this.meter.frames)&&!this.meter.missingFrames;
    if(!p.sourceComplete&&!this.captureError)this.captureError='No se pudo confirmar la integridad de todo el audio capturado';
    if(this.coach?.ready&&!this.coach.failed){
      // Dejar llegar los últimos deltas antes de solicitar un resumen separado del feedback.
      await new Promise(r=>setTimeout(r,500));
      this.liveAdvice?.flush();
      this.summaryMode=true;
      this.coach.summarize(JSON.stringify({metrics:this.meter?.metrics(p.transcript),audioComplete:p.sourceComplete,tema:p.title,temaEscritoPorElUsuario:p.declaredTitle,nota:p.declaredTitle?'El estudiante escribió un tema y expuso otro: menciónalo en el resumen y evalúa según el tema expuesto.':undefined,guion:p.idealText||''}));
      try{this.coach.audio(Buffer.alloc(16000));}catch{}
      const limit=Date.now()+12000;
      while(Date.now()<limit&&(!p.summary||Date.now()-this.lastSummary<1500))await new Promise(r=>setTimeout(r,100));
      p.providerFinalized=await this.coach.close();
    }else this.coach?.abort();
    await this.assess(p,true);
    p.metrics=this.meter?.metrics(p.transcript)??p.metrics;
    if(p.summary.trim().length<30){p.summary=fallbackSummary(p.metrics,p.transcript);p.summarySource='heuristic';}
    else p.summarySource=p.mode==='whisper'?'text-ai':'gpt-live-1';
    p.endedAt=iso();p.error=this.captureError;
    if(!p.error&&p.metrics.frames>0&&p.metrics.peak===0)
      p.error='El micrófono envió audio sin señal. Revisa la alimentación, los cables y el canal L/R del INMP441.';
    this.archiving=true;
    p.status=p.sourceComplete&&p.providerFinalized&&!p.error?'completed':'interrupted';
    if(!p.providerFinalized&&!p.error)p.error='La IA no confirmó la finalización';
    this.log(p.status==='completed'?'system':'error',p.error||'Presentación finalizada');
    try {
      // Una toma que pasó por varias conexiones tiene el audio anterior guardado por segmentos.
      const pcm=[...await store.audioParts(p),...this.chunks];
      await store.archive(p,pcm.length?wav(Buffer.concat(pcm)):undefined);
      await store.deleteAudioParts(p).catch(()=>{});
    }
    catch{p.archived=false;p.error=(p.error?p.error+'. ':'')+'No se confirmó el respaldo permanente. Exporta los registros disponibles.';await store.saveLive(p).catch(()=>{});}
    await store.clearActive(p.deviceId,p.id).catch(()=>{});
    this.send({type:'session.ended',sid:p.id,status:p.status});
    this.liveAdvice?.discard();this.liveAdvice=undefined;
    this.active=undefined;this.meter=undefined;this.coach=undefined;this.chunks=[];this.topicJob=undefined;
    this.closing=false;this.archiving=false;this.born=Date.now();
  }
  private async fail(message:string){
    if(this.handingOver)return;
    if(this.closing){this.captureError=this.captureError||message;this.captureEnded?.();return;}
    if(this.active){this.log('error',message);await this.finish(message);}
    else this.send({type:'error',message});
  }
  private async cleanup(){
    if(this.dead||this.disconnected)return;
    this.disconnected=true;
    clearTimeout(this.authTimer);clearInterval(this.timer);
    try {
      // Libera la conexión tan pronto como se cierra el socket. El cierre de IA y
      // el archivo de una toma pueden tardar más que el reintento del ESP32.
      // No publicar offline aquí: una conexión nueva ya podría estar activa.
      if(this.owner)await store.releaseDevice(this.owner.deviceId,this.lease);
      if(this.handoverJob)await this.handoverJob;
      if(this.active&&!this.closing)await this.finish('Se desconectó el ESP32 antes de confirmar el cierre');
      else if(this.finishing)await this.finishing;
      if(this.sub?.isOpen)await this.sub.close();
    }catch{console.error('device_cleanup_failed');}
    this.dead=true;
  }
}

import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {LiveCoach, type ProviderEvent} from './live.js';
import {WhisperCoach} from './whisper-coach.js';
import {evaluateTranscript} from './assessment.js';
import {SpeechMeter, parseAudio, fallbackSummary, wav} from './metrics.js';
import {validDeviceId, validUsername, verifyDevice} from './security.js';
import * as store from './store.js';
import {iso, terminal, type Account, type Presentation, type SpeechEvent} from './types.js';
type Coach=Pick<LiveCoach,'ready'|'failed'|'open'|'audio'|'cue'|'summarize'|'close'|'abort'>;

export class DeviceConnection {
  private owner?:Account; private lease=randomUUID(); private sub?:Awaited<ReturnType<typeof store.subscriber>>;
  private authenticated=false; private dead=false; private disconnected=false; private closing=false; private archiving=false; private born=Date.now();
  private lastDeviceMessage=Date.now();
  private tickBusy=false; private commandsBusy=false; private chain=Promise.resolve();
  private active?:Presentation; private meter?:SpeechMeter; private chunks:Buffer[]=[];
  private coach?:Coach; private peak=0; private rssi=-100; private lastFlush=0; private lastCheckpoint=0;
  private summaryMode=false; private lastSummary=0; private lastCue=0;
  private lastAssessment=0; private assessmentJob?:Promise<void>;
  private captureEnded?:()=>void; private stopExpected?:number; private captureError?:string;
  private finishing?:Promise<void>;
  private authTimer:ReturnType<typeof setTimeout>; private timer:ReturnType<typeof setInterval>;
  constructor(private socket:WebSocket,private makeCoach:(event:(e:ProviderEvent)=>void,error:(message:string)=>void)=>Coach=(e,f)=>new LiveCoach(e,f),private evaluate:typeof evaluateTranscript=evaluateTranscript) {
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
  private log(kind:SpeechEvent['kind'],text:string) {
    const p=this.active;if(!p||!text)return;
    const last=p.events.at(-1),at=iso();
    if(last?.kind===kind&&Date.now()-Date.parse(last.at)<1200&&kind!=='system'&&kind!=='error')last.text+=text;
    else p.events.push({id:p.events.length,kind,text,at,audioMs:Math.round((this.meter?.samples??0)/16)});
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
        if(!await store.claimDevice(deviceId,this.lease))throw new Error('El dispositivo ya tiene una conexión activa');
        this.authenticated=true;clearTimeout(this.authTimer);
        this.sub=await store.subscriber();
        await this.sub.subscribe(store.key(`notify:${deviceId}`),()=>void this.commands());
        await this.writePresence();
        this.send({type:'auth.ok',username,maxSeconds:180});
        await this.commands();
      }catch(e){this.send({type:'auth.error',message:e instanceof Error?e.message:'No se pudo registrar el dispositivo'});this.socket.close(1008);}
      return;
    }
    if(binary){
      if(!this.active||!this.meter||!this.coach||this.stopExpected!==undefined)return;
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
      if(!Number.isInteger(event.frames)||event.frames<0||event.frames>9000)throw new Error('Total de audio inválido');
      this.stopExpected=event.frames;
      this.captureEnded?.();
      if(!this.closing)void this.finish(event.reason&&event.reason!=='user'?'El dispositivo detuvo la captura':undefined);
    }else if(event.type==='capture.error')await this.fail('Captura interrumpida: '+String(event.reason||'error de micrófono').slice(0,100));
  }
  private async commands(){
    if(!this.owner||this.dead||this.disconnected||this.commandsBusy)return;
    this.commandsBusy=true;
    try {
      for(let i=0;i<5;i++){
        const command=await store.takeCommand(this.owner.deviceId);if(!command)break;
        if(command.op==='start')await this.start(command.sid);
        else if(command.op==='stop'&&command.sid===this.active?.id)void this.finish();
      }
    }catch{await this.fail('No se pudo aplicar el control de grabación');}
    finally{this.commandsBusy=false;}
  }
  private async start(sid:string){
    if(!this.owner||this.active||this.closing)return;
    const p=await store.getPresentation(this.owner.username,sid);if(!p||p.status!=='pending')return;
    this.active=p;this.meter=new SpeechMeter();this.chunks=[];this.stopExpected=undefined;
    this.captureError=undefined;this.summaryMode=false;this.lastSummary=0;this.lastCue=0;this.lastAssessment=0;this.assessmentJob=undefined;
    p.status='starting';this.log('system','Preparando la conexión de IA');await this.flush();
    const onEvent=(e:ProviderEvent)=>this.providerEvent(e);
    const onError=(message:string)=>{if(!this.closing)void this.fail(message);};
    this.coach=p.mode==='whisper'?new WhisperCoach(p.deviceId,p.id,onEvent,onError):this.makeCoach(onEvent,onError);
    try {
      await this.coach.open(p.feedback);
      if(this.dead||this.closing)throw new Error('El dispositivo se desconectó durante el inicio');
      this.send({type:'capture.start',sid:p.id,sampleRate:16000,samplesPerFrame:320,maxSeconds:p.durationLimit});
      this.log('system','IA conectada. Esperando confirmación del micrófono');
      setTimeout(()=>{if(this.active?.id===p.id&&p.status==='starting')void this.fail('El micrófono no confirmó el inicio');},7000).unref();
    }catch(e){await this.fail(e instanceof Error?e.message:'No se pudo iniciar la IA');}
  }
  private providerEvent(e:ProviderEvent){
    const p=this.active;if(!p||this.dead)return;
    if(e.type==='session.input_transcript.delta'&&typeof e.delta==='string'){
      p.transcript+=e.delta;this.log('transcript',e.delta);
      if(p.transcript.length>100000){void this.fail('La transcripción superó el límite de esta toma');return;}
      if(p.feedback&&!this.closing&&Date.now()-this.lastAssessment>30000&&p.transcript.trim().split(/\s+/).length>=35)void this.assess(p);
      if(p.feedback&&!this.closing&&Date.now()-this.lastCue>7000&&p.transcript.trim().split(/\s+/).length>=15){
        this.lastCue=Date.now();this.coach?.cue(JSON.stringify({metrics:this.meter?.metrics(p.transcript),publico:p.audience||'No especificado',recentTranscript:p.transcript.slice(-500)}));
      }
    }else if(e.type==='session.output_transcript.delta'&&typeof e.delta==='string'){
      if(this.summaryMode){p.summary+=e.delta;this.lastSummary=Date.now();}
      else if(p.feedback){p.advice+=e.delta;this.log('advice',e.delta);this.send({type:'feedback',text:e.delta.slice(0,700)});}
    }else if(e.type==='session.closed')p.providerFinalized=true;
  }
  private async assess(p:Presentation,final=false){
    if(this.assessmentJob){if(!final)return;await this.assessmentJob;}
    if(this.active?.id!==p.id)return;
    this.lastAssessment=Date.now();
    const transcript=p.transcript, seconds=this.meter?.metrics(transcript).seconds??0;
    const job=(async()=>{
      try{
        const result=await this.evaluate(transcript,seconds,final,p.audience||'');
        if(this.active?.id!==p.id)return;
        if(!result){if(transcript.trim().split(/\s+/).length>=35)p.assessmentError='No se pudo obtener una evaluación válida de la IA.';return;}
        p.assessmentError=undefined;
        (p.assessments??=[]).push(result);
        if(!final&&p.feedback&&result.next&&!this.closing){this.log('advice',result.next);p.advice+=result.next+' ';}
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
      firmware:'ensaia-cloud-s3-v1',rssi:this.rssi,peak:this.peak,sid:this.active?.id});
  }
  private async tick(){
    if(!this.authenticated||!this.owner||this.dead||this.tickBusy)return;
    this.tickBusy=true;
    try {
      // Un socket que quedó abierto tras perder la red no debe renovar su
      // exclusividad indefinidamente. El ESP32 envía estado cada dos segundos.
      if(Date.now()-this.lastDeviceMessage>15000){this.socket.terminate();return;}
      if(!await store.renewDevice(this.owner.deviceId,this.lease)){await this.fail('La conexión perdió su autorización');this.socket.close(1012);return;}
      await this.writePresence();
      void this.commands();
      if(this.active){
        if(this.active.startedAt&&!this.closing&&Date.now()-Date.parse(this.active.startedAt)>this.active.durationLimit*1000)void this.finish();
        if(!this.archiving&&Date.now()-this.lastFlush>900)await this.flush();
        if(!this.archiving&&Date.now()-this.lastCheckpoint>8000){this.lastCheckpoint=Date.now();await store.checkpoint(this.active);}
      }else if(Date.now()-this.born>55000){this.send({type:'reconnect'});this.socket.close(1000,'Renovar conexión');}
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
      this.summaryMode=true;
      this.coach.summarize(JSON.stringify({metrics:this.meter?.metrics(p.transcript),audioComplete:p.sourceComplete}));
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
    try {await store.archive(p,this.chunks.length?wav(Buffer.concat(this.chunks)):undefined);}
    catch{p.archived=false;p.error=(p.error?p.error+'. ':'')+'No se confirmó el respaldo permanente. Exporta los registros disponibles.';await store.saveLive(p).catch(()=>{});}
    await store.clearActive(p.deviceId,p.id).catch(()=>{});
    this.send({type:'session.ended',sid:p.id,status:p.status});
    this.active=undefined;this.meter=undefined;this.coach=undefined;this.chunks=[];
    this.closing=false;this.archiving=false;this.born=Date.now();
  }
  private async fail(message:string){
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
      if(this.active&&!this.closing)await this.finish('Se desconectó el ESP32 antes de confirmar el cierre');
      else if(this.finishing)await this.finishing;
      if(this.sub?.isOpen)await this.sub.close();
    }catch{console.error('device_cleanup_failed');}
    this.dead=true;
  }
}

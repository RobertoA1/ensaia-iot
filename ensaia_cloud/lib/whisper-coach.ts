import {seal,unseal} from './security.js';
import * as store from './store.js';
import {workerOnline} from './worker.js';
import type {ProviderEvent} from './live.js';
import type {CoachResume} from './types.js';

export class WhisperCoach {
 ready=false;failed=false;private ended=false;private stopping=false;private pending=Promise.resolve();private chunks:Buffer[]=[];private bytes=0;private queued=0;private seq=0;private transcript='';private lastAdvice=0;private cueContext='';private summaryContext='';private textJob?:Promise<void>;private summaryJob?:Promise<void>;private sub?:Awaited<ReturnType<typeof store.subscriber>>;
 constructor(private device:string,private sid:string,private event:(e:ProviderEvent)=>void,private onError:(s:string)=>void){}
 async open(feedback:boolean,resume?:CoachResume){
  // Al continuar una toma, el transcriptor puede estar reconectando: sus fragmentos se reintentan.
  if(!resume&&!await workerOnline(this.device))throw new Error('Inicia Whisper en la laptop antes de grabar.');
  const r=await store.db(),backlog=store.key('whisper:backlog:'+this.device);
  this.sub=await store.subscriber();await this.sub.subscribe(store.key('whisper:result:'+this.device),raw=>this.result(raw));
  if(resume){
   // El transcriptor conserva la toma abierta: se continúa la numeración y se recogen los textos que llegaron sin oyente.
   const state=resume.state as {seq?:number}|undefined;this.seq=Number.isInteger(state?.seq)?state!.seq!:0;this.transcript=resume.transcript;
   for(let raw=await r.lPop(backlog);raw;raw=await r.lPop(backlog))this.result(raw);
   this.ready=true;return;
  }
  await r.del(backlog);
  this.ready=true;await this.publish({type:'start',sid:this.sid});
 }
 private result(raw:string){try{const m=JSON.parse(unseal(raw,'whisper:result:'+this.device));if(m.sid!==this.sid)return;
   if(m.type==='transcript'&&m.text){const t=String(m.text).trim()+' ';this.transcript+=t;this.event({type:'session.input_transcript.delta',delta:t,...(Number.isInteger(m.start_ms)&&Number.isInteger(m.end_ms)?{start_ms:m.start_ms,end_ms:m.end_ms}:{})});}
   else if(m.type==='ended')this.ended=true;
   else if(m.type==='error'){this.failed=true;this.onError('La transcripción local se interrumpió.');}
  }catch{this.failed=true;this.onError('La transcripción local envió una respuesta inválida.');}}
 /** Entrega el audio pendiente y deja la toma abierta en el transcriptor para que otra conexión la continúe. */
 async suspend(){
  this.stopping=true;this.flush();await this.pending;if(this.textJob)await this.textJob;
  await new Promise(done=>setTimeout(done,1500));
  if(this.sub?.isOpen)await this.sub.close();
  return {seq:this.seq};
 }
 private publish(obj:unknown){return this.pending=this.pending.then(async()=>{const r=await store.db();const payload=seal(JSON.stringify(obj),'whisper:audio:'+this.device);
  // El transcriptor también renueva su conexión: se reintenta unos segundos antes de darlo por perdido.
  for(const until=Date.now()+15000;;){if(await r.publish(store.key('whisper:audio:'+this.device),payload))return;if(this.failed||Date.now()>until)throw new Error('Whisper perdió la conexión');await new Promise(done=>setTimeout(done,400));}});}
 private flush(){if(!this.bytes)return;const pcm=Buffer.concat(this.chunks);this.chunks=[];this.bytes=0;this.queued++;if(this.queued>40){this.failed=true;this.onError('La transcripción se atrasó demasiado.');return;}void this.publish({type:'audio',sid:this.sid,seq:this.seq++,audio:pcm.toString('base64')}).catch(()=>{this.failed=true;this.onError('La laptop de transcripción se desconectó.');}).finally(()=>this.queued--);}
 audio(pcm:Buffer){if(this.stopping)return;if(this.failed||!this.ready)throw new Error('Whisper no está listo');this.chunks.push(Buffer.from(pcm));this.bytes+=pcm.length;if(this.bytes>=32000)this.flush();}
 cue(context:string){this.cueContext=context.slice(0,2500);if(this.stopping||this.textJob||Date.now()-this.lastAdvice<10000||this.transcript.trim().length<40)return;this.lastAdvice=Date.now();this.textJob=this.generate(false).finally(()=>{this.textJob=undefined;});}
 summarize(context:string){this.summaryContext=context.slice(0,24000);this.stopping=true;this.flush();void this.publish({type:'end',sid:this.sid,seq:this.seq}).catch(()=>{this.failed=true;});this.summaryJob=(async()=>{const until=Date.now()+35000;while(!this.ended&&!this.failed&&Date.now()<until)await new Promise(r=>setTimeout(r,100));if(this.textJob)await this.textJob;if(this.ended&&this.transcript.trim())await this.generate(true);})();}
 private async generate(summary:boolean){
  try{const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({model:process.env.TEXT_MODEL||'gpt-5.6-luna',store:false,reasoning:{effort:'none'},max_output_tokens:summary?500:120,instructions:summary?'Eres entrenador de oratoria. Resume en español fortalezas, tres aspectos por mejorar y un ejercicio. Si hay guion en el contexto, compara ideas y orden con la transcripción sin penalizar paráfrasis ni afirmar que una omisión ocurrió si la transcripción es incompleta. Reconoce sus límites.':'Eres entrenador de oratoria. Da un solo consejo breve y respetuoso, de máximo 15 palabras, en español. Examina claridad de las ideas, explicaciones complejas, organización, ejemplos, ritmo y posibles muletillas en su contexto. Usa el texto y los indicadores como evidencia incierta: una muletilla candidata puede ser una palabra necesaria y los silencios pueden ser intencionales. Si hay términos difíciles, sugiere una explicación sencilla. No inventes errores, palabras, volumen de voz ni gestos. Si no hay evidencia clara responde únicamente: SIN CONSEJO.',input:JSON.stringify({transcripcion:this.transcript.slice(-7000),indicadores:this.cueContext||'No disponibles',contextoFinal:summary?this.summaryContext:undefined})})});
   if(!response.ok)throw Error('text_provider');const json=await response.json() as any;const text=(json.output||[]).flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join('').trim();
   if(!summary&&this.stopping)return;
   if(text&&!/^(sin consejo)[.!]?$/i.test(text))this.event({type:'session.output_transcript.delta',delta:text+' '});
  }catch{if(summary)this.event({type:'provider.warning',message:'No se pudo obtener el resumen de IA.'});}
 }
 async close(){try{await this.summaryJob;await this.pending;}catch{this.failed=true;}if(this.sub?.isOpen)await this.sub.close();return this.ended&&!this.failed;}
 abort(){this.failed=true;void this.sub?.close();}
}

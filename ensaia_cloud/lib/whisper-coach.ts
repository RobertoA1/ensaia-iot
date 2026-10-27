import {seal,unseal} from './security.js';
import * as store from './store.js';
import {workerOnline} from './worker.js';
import type {ProviderEvent} from './live.js';

export class WhisperCoach {
 ready=false;failed=false;private ended=false;private stopping=false;private pending=Promise.resolve();private chunks:Buffer[]=[];private bytes=0;private queued=0;private seq=0;private transcript='';private lastAdvice=0;private cueContext='';private textJob?:Promise<void>;private summaryJob?:Promise<void>;private sub?:Awaited<ReturnType<typeof store.subscriber>>;
 constructor(private device:string,private sid:string,private event:(e:ProviderEvent)=>void,private onError:(s:string)=>void){}
 async open(feedback:boolean){
  if(!await workerOnline(this.device))throw new Error('Inicia Whisper en la laptop antes de grabar.');
  this.sub=await store.subscriber();await this.sub.subscribe(store.key('whisper:result:'+this.device),raw=>{try{const m=JSON.parse(unseal(raw,'whisper:result:'+this.device));if(m.sid!==this.sid)return;
   if(m.type==='transcript'&&m.text){const t=String(m.text).trim()+' ';this.transcript+=t;this.event({type:'session.input_transcript.delta',delta:t});}
   else if(m.type==='ended')this.ended=true;
   else if(m.type==='error'){this.failed=true;this.onError('La transcripción local se interrumpió.');}
  }catch{this.failed=true;this.onError('La transcripción local envió una respuesta inválida.');}});
  this.ready=true;await this.publish({type:'start',sid:this.sid});
 }
 private publish(obj:unknown){return this.pending=this.pending.then(async()=>{const r=await store.db();const receivers=await r.publish(store.key('whisper:audio:'+this.device),seal(JSON.stringify(obj),'whisper:audio:'+this.device));if(!receivers)throw new Error('Whisper perdió la conexión');});}
 private flush(){if(!this.bytes)return;const pcm=Buffer.concat(this.chunks);this.chunks=[];this.bytes=0;this.queued++;if(this.queued>8){this.failed=true;this.onError('La transcripción se atrasó demasiado.');return;}void this.publish({type:'audio',sid:this.sid,seq:this.seq++,audio:pcm.toString('base64')}).catch(()=>{this.failed=true;this.onError('La laptop de transcripción se desconectó.');}).finally(()=>this.queued--);}
 audio(pcm:Buffer){if(this.stopping)return;if(this.failed||!this.ready)throw new Error('Whisper no está listo');this.chunks.push(Buffer.from(pcm));this.bytes+=pcm.length;if(this.bytes>=32000)this.flush();}
 cue(context:string){this.cueContext=context.slice(0,2500);if(this.stopping||this.textJob||Date.now()-this.lastAdvice<20000||this.transcript.trim().length<60)return;this.lastAdvice=Date.now();this.textJob=this.generate(false).finally(()=>{this.textJob=undefined;});}
 summarize(){this.stopping=true;this.flush();void this.publish({type:'end',sid:this.sid,seq:this.seq}).catch(()=>{this.failed=true;});this.summaryJob=(async()=>{const until=Date.now()+35000;while(!this.ended&&!this.failed&&Date.now()<until)await new Promise(r=>setTimeout(r,100));if(this.textJob)await this.textJob;if(this.ended&&this.transcript.trim())await this.generate(true);})();}
 private async generate(summary:boolean){
  try{const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({model:process.env.TEXT_MODEL||'gpt-5.6-luna',store:false,reasoning:{effort:'none'},max_output_tokens:summary?500:120,instructions:summary?'Eres entrenador de oratoria. Resume en español fortalezas, tres aspectos por mejorar y un ejercicio, usando solo la transcripción. Reconoce sus límites.':'Eres entrenador de oratoria. Da un solo consejo breve y respetuoso, de máximo 15 palabras, en español. Examina claridad de las ideas, explicaciones complejas, organización, ejemplos, ritmo y posibles muletillas en su contexto. Usa el texto y los indicadores como evidencia incierta: una muletilla candidata puede ser una palabra necesaria y los silencios pueden ser intencionales. Si hay términos difíciles, sugiere una explicación sencilla. No inventes errores, palabras, volumen de voz ni gestos. Si no hay evidencia clara responde únicamente: SIN CONSEJO.',input:JSON.stringify({transcripcion:this.transcript.slice(-7000),indicadores:this.cueContext||'No disponibles'})})});
   if(!response.ok)throw Error('text_provider');const json=await response.json() as any;const text=(json.output||[]).flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join('').trim();
   if(!summary&&this.stopping)return;
   if(text&&!/^(sin consejo)[.!]?$/i.test(text))this.event({type:'session.output_transcript.delta',delta:text+' '});
  }catch{if(summary)this.event({type:'provider.warning',message:'No se pudo obtener el resumen de IA.'});}
 }
 async close(){try{await this.summaryJob;await this.pending;}catch{this.failed=true;}if(this.sub?.isOpen)await this.sub.close();return this.ended&&!this.failed;}
 abort(){this.failed=true;void this.sub?.close();}
}

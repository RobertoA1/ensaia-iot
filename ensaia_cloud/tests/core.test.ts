import {test} from 'node:test';
import assert from 'node:assert/strict';
import {passwordHash,verifyPassword,verifyDevice,hash,validUsername,seal,unseal} from '../lib/security.js';
import {SpeechMeter,parseAudio,wav,fallbackSummary} from '../lib/metrics.js';
import {LiveCoach} from '../lib/live.js';
import {WebSocketServer} from 'ws';

test('el secreto del dispositivo se verifica por ID y no permite registros arbitrarios',()=>{
  process.env.DEVICE_SECRETS=JSON.stringify({'test-s3':hash('a'.repeat(64))});
  assert.equal(verifyDevice('test-s3','a'.repeat(64)),true);
  assert.equal(verifyDevice('test-s3','b'.repeat(64)),false);
  assert.equal(verifyDevice('otro','a'.repeat(64)),false);
  assert.equal(verifyDevice('__proto__','a'.repeat(64)),false);
  assert.equal(validUsername('../../admin'),false);
});
test('las contraseñas usan sal y verifican el valor sin almacenarlo en texto',async()=>{
  const password='password-de-prueba-1234';const a=await passwordHash(password),b=await passwordHash(password);
  assert.notEqual(a,b);assert.equal(a.includes(password),false);
  assert.equal(await verifyPassword(password,a),true);assert.equal(await verifyPassword('incorrecta',a),false);
});
test('los registros temporales se cifran y una alteración o cambio de contexto se rechaza',()=>{
  process.env.SESSION_SECRET='test-only-random-master-secret-not-real';
  const encoded=seal('contenido privado','session:a');
  assert.equal(encoded.includes('contenido privado'),false);assert.equal(unseal(encoded,'session:a'),'contenido privado');
  assert.throws(()=>unseal(encoded,'session:b'));
  const bytes=Buffer.from(encoded,'base64url');bytes[30]^=1;assert.throws(()=>unseal(bytes.toString('base64url'),'session:a'));
});
test('el audio exige SID, secuencia y offset exactos; PCM16 sin cabecera WAV',()=>{
  const sid='0123456789abcdef',packet=Buffer.alloc(664);packet.write(sid);packet.writeUInt32LE(320,20);packet.writeUInt32LE(1,16);
  packet.writeInt16LE(-32768,24);
  const pcm=parseAudio(packet,sid,1);assert.equal(pcm.length,640);assert.equal(pcm.readInt16LE(0),-32768);
  assert.throws(()=>parseAudio(packet,sid,0),/Se perdió audio/);
  assert.throws(()=>parseAudio(packet.subarray(1),sid,1));
  assert.throws(()=>parseAudio(packet,'aaaaaaaaaaaaaaaa',1));
  const encoded=wav(pcm);assert.equal(encoded.toString('ascii',0,4),'RIFF');assert.equal(encoded.readUInt32LE(40),640);assert.equal(encoded.readUInt32LE(24),16000);
});
test('las estadísticas usan duración real de audio y no inventan una puntuación',()=>{
  const meter=new SpeechMeter();for(let i=0;i<50;i++)meter.audio(Buffer.alloc(640));
  const m=meter.metrics('Bueno, este tema es es importante, o sea, debemos practicar.');
  assert.equal(m.seconds,1);assert.equal(m.longPauses,1);assert.equal(m.silencePercent,100);
  assert.equal(m.repetitions,1);assert.equal(m.fillerCandidates,3);assert.equal(m.wordsPerMinute,m.words*60);
  assert.match(fallbackSummary(m,'texto'),/no son un resumen generado por IA/);
});
test('GPT-Live utiliza el protocolo Live con PCM16 a 16 kHz y confirma su cierre',async()=>{
  process.env.OPENAI_API_KEY='fake-key-only-for-local-test';
  const received:any[]=[];const wss=new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise<void>(r=>wss.once('listening',r));
  wss.on('connection',(ws,request)=>{
    assert.equal(request.headers.authorization,'Bearer fake-key-only-for-local-test');
    ws.on('message',raw=>{const e=JSON.parse(raw.toString());received.push(e);
      if(e.type==='session.start')ws.send(JSON.stringify({type:'session.started'}));
      if(e.type==='session.input_audio.append')ws.send(JSON.stringify({type:'session.input_transcript.delta',delta:'Hola, eh, gracias.'}));
      if(e.type==='session.close')ws.send(JSON.stringify({type:'session.closed',usage:{seconds:1}}));
    });
  });
  const events:any[]=[];const failures:string[]=[];
  const coach=new LiveCoach(e=>events.push(e),e=>failures.push(e),`ws://127.0.0.1:${(wss.address() as any).port}`);
  try{
    await coach.open(true);coach.audio(Buffer.alloc(640));
    coach.cue('Datos de prueba');coach.summarize('Indicadores de prueba');
    assert.equal(await coach.close(),true);
    assert.equal(received[0].session.model,'gpt-live-1');assert.equal(received[0].session.audio.format.rate,16000);
    assert.ok(received.some(e=>e.type==='session.input_audio.append'&&Buffer.from(e.audio,'base64').length===640));
    assert.ok(received.some(e=>e.type==='session.instructions.append'));assert.ok(events.some(e=>e.type==='session.input_transcript.delta'));
    assert.deepEqual(failures,[]);
  }finally{coach.abort();for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));}
});

test('la rúbrica solo puntúa dimensiones con citas presentes y calcula un promedio comparable',async()=>{
  const {parseAssessment}=await import('../lib/assessment.js');
  const transcript='Primero debemos organizar el tiempo. Por ejemplo, una lista facilita decidir. En conclusión, el descanso importa.';
  const response=JSON.stringify({clarity:{score:80,evidence:'organizar el tiempo',suggestion:'Define la idea central.'},organization:{score:70,evidence:'Primero debemos',suggestion:'Añade una transición.'},development:{score:90,evidence:'una lista facilita decidir',suggestion:'Amplía el ejemplo.'},complexity:'Explica el término.',next:'Añade un ejemplo.'});
  const parsed=parseAssessment(response,transcript,30)!;
  assert.equal(parsed.total,80);assert.equal(parsed.dimensions.clarity.score,80);assert.equal(parsed.seconds,30);
  const invented=parseAssessment(response,transcript.replace('una lista facilita decidir','otra cosa'),30)!;
  assert.equal(invented.dimensions.development.score,null);assert.equal(invented.total,null);
  assert.equal(parseAssessment('no es JSON',transcript,30),null);
});
test('el nivel reciente no conserva una saturación anterior por toda la sesión',()=>{
  const meter=new SpeechMeter(),clipped=Buffer.alloc(640);for(let i=0;i<640;i+=2)clipped.writeInt16LE(32767,i);
  meter.audio(clipped);assert.ok(meter.metrics('hola').recentClipped!>0);
  for(let i=0;i<250;i++)meter.audio(Buffer.alloc(640));
  const m=meter.metrics('hola');assert.equal(m.recentClipped,0);assert.equal(m.recentRms,0);assert.ok(m.clippedSamples>0);
});

test('el ritmo reciente usa solo fragmentos temporizados y la frecuencia de candidatos considera la longitud',async()=>{
  const {recentTranscriptionRate,candidateRate}=await import('../lib/insights.js');
  const words=Array.from({length:30},(_,i)=>`palabra${i}`).join(' ');
  const events=[{id:0,at:new Date().toISOString(),kind:'transcript' as const,text:words,audioMs:45000},
    {id:1,at:new Date().toISOString(),kind:'transcript' as const,text:words,audioMs:10000}];
  assert.equal(recentTranscriptionRate(events,55),60);
  assert.equal(recentTranscriptionRate(events,20),null);
  assert.equal(recentTranscriptionRate([{...events[0],audioMs:undefined}],55),null);
  assert.equal(candidateRate(3,60),5);assert.equal(candidateRate(2,20),null);
});

test('un consejo de Whisper que llega al finalizar no se convierte en resumen',async()=>{
  const {WhisperCoach}=await import('../lib/whisper-coach.js');
  const realFetch=globalThis.fetch;let release!:(r:Response)=>void;
  globalThis.fetch=(()=>new Promise<Response>(r=>{release=r;})) as typeof fetch;
  const events:any[]=[];const coach=new WhisperCoach('test','test',e=>events.push(e),()=>{});
  try{
    const pending=(coach as any).generate(false);(coach as any).stopping=true;
    release(new Response(JSON.stringify({output:[{content:[{type:'output_text',text:'Consejo anterior'}]}]}),{status:200}));
    await pending;assert.deepEqual(events,[]);
  }finally{globalThis.fetch=realFetch;}
});

test('la evolución histórica ordena las tomas completas y omite puntuaciones no disponibles',async()=>{
  const {historyTrend}=await import('../lib/insights.js');
  const base={status:'completed',sourceComplete:true};
  const items=[{...base,id:'b',title:'Segunda',createdAt:'2026-01-02T10:00:00Z',score:70},
    {...base,id:'a',title:'Primera',createdAt:'2026-01-01T10:00:00Z',score:80},
    {...base,id:'c',createdAt:'2026-01-03T10:00:00Z',score:null},
    {...base,id:'d',createdAt:'2026-01-04T10:00:00Z',score:99,sourceComplete:false},
    {...base,id:'e',createdAt:'no es fecha',score:99}];
  assert.deepEqual(historyTrend(items).map(x=>x.id),['a','b']);
  assert.equal(items[0].id,'b');
});

test('los candidatos muestran contexto exacto y no coinciden dentro de otras palabras',async()=>{
  const {fillerOccurrences,fillerCounts,fillerContexts}=await import('../lib/fillers.js');
  const text='Bueno, este tema es importante, eh. El noreste y éste no son candidatos. O sea, debemos practicar.';
  assert.deepEqual(fillerCounts(text),[{token:'eh',count:1},{token:'este',count:1},{token:'o sea',count:1},{token:'bueno',count:1}]);
  assert.deepEqual(fillerOccurrences(text).map(x=>text.slice(x.start,x.end)),['Bueno','este','eh','O sea']);
  const contexts=fillerContexts(text,2,10);assert.equal(contexts.length,2);assert.equal(contexts[1].match,'O sea');
  assert.match(contexts[1].after,/debemos/);assert.deepEqual(fillerContexts(text,0),[]);
  assert.deepEqual(fillerOccurrences('antiéh ehé noreste éeste esteé'),[]);
});

test('la evidencia numerada proviene literalmente de la transcripción y rechaza índices inventados',async()=>{
  const {evidenceFragments,parseAssessment}=await import('../lib/assessment.js');
  const transcript='Primero explicamos un concepto. Después presentamos un ejemplo con pasos concretos.';
  const fragments=evidenceFragments(transcript);assert.equal(fragments.length,2);
  assert.ok(fragments.every(f=>transcript.includes(f.text)));
  const item=(id:number)=>({score:80,evidence_id:id,suggestion:'Explica la idea.'});
  const response=JSON.stringify({clarity:item(0),organization:item(1),development:item(1),next:'Da un ejemplo.'});
  const result=parseAssessment(response,transcript,30,fragments)!;assert.equal(result.total,80);
  assert.equal(result.dimensions.organization.evidence,fragments[1].text);
  const invalid=JSON.stringify({clarity:item(999),organization:item(1),development:item(1)});
  assert.equal(parseAssessment(invalid,transcript,30,fragments)!.total,null);
});

test('los fragmentos de GPT-Live forman un consejo y se descartan confirmaciones aisladas',async()=>{
  const {LiveAdviceBuffer}=await import('../lib/live-advice.js');const items:string[]=[];
  const buf=new LiveAdviceBuffer(x=>items.push(x),20);
  buf.push(' ¿Pod');buf.push('rías decirlo');buf.push(' en español?');
  await new Promise(r=>setTimeout(r,40));assert.deepEqual(items,['¿Podrías decirlo en español?']);
  buf.push(' Mm-hmm.');buf.flush();buf.push(' Claro.');buf.flush();assert.equal(items.length,1);
  buf.push(' Separa');buf.push(' las ideas.');buf.flush();assert.equal(items[1],'Separa las ideas.');
  buf.push('descartado');buf.discard();await new Promise(r=>setTimeout(r,40));assert.equal(items.length,2);
});

test('el consejo de rúbrica solo se emite cuando referencia un fragmento válido',async()=>{
  const {evidenceFragments,parseAssessment}=await import('../lib/assessment.js');
  const transcript='La fragmentación separa las frases y dificulta entender el mensaje para toda la audiencia.';
  const fragments=evidenceFragments(transcript);const d={score:70,evidence_id:0,suggestion:'Define el término.'};
  const raw=(id:number|null)=>JSON.stringify({clarity:d,organization:d,development:d,next:'Explica «fragmentación» con un ejemplo sencillo.',next_evidence_id:id});
  assert.match(parseAssessment(raw(0),transcript,15,fragments)!.next,/fragmentación/);
  assert.equal(parseAssessment(raw(999),transcript,15,fragments)!.next,'');
  assert.equal(parseAssessment(raw(null),transcript,15,fragments)!.next,'');
});

test('los intervalos de evidencia se construyen con los fragmentos de audio y no con la hora de llegada',async()=>{
 const {attachEvidenceRanges}=await import('../lib/assessment.js');
 const d=(evidence:string)=>({score:70,evidence,suggestion:'Revisar'});
 const assessment={seconds:10,at:new Date().toISOString(),total:70,dimensions:{clarity:d('frase clara'),organization:d('siguiente idea'),development:d('sin tiempos')},complexity:'',next:''};
 const events=[{id:0,at:new Date().toISOString(),kind:'transcript' as const,text:'Una frase clara ',startMs:4000,endMs:8000,rangeSource:'block' as const},
 {id:1,at:new Date().toISOString(),kind:'transcript' as const,text:'y la siguiente idea ',startMs:8000,endMs:10000,rangeSource:'block' as const},
 {id:2,at:new Date().toISOString(),kind:'transcript' as const,text:'sin tiempos',audioMs:16000}];
 const result=attachEvidenceRanges(assessment,events);
 assert.equal(result.dimensions.clarity.startMs,4000);assert.equal(result.dimensions.clarity.endMs,8000);
 assert.equal(result.dimensions.organization.startMs,8000);assert.equal(result.dimensions.organization.endMs,10000);
 assert.equal(result.dimensions.development.startMs,undefined);
});

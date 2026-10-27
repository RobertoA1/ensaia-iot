'use strict';
const $=id=>document.getElementById(id);
let token=sessionStorage.getItem('oratoria_access')||'',ws=null,sid=null,mic=null,context=null,source=null,processor=null;
let seq=0,offset=0,connected=false,recording=false,closing=false,timer=null,demoTimer=null,startedAt=0,lastCoach='',reviewSid=null,playAt=0;
let flushing=null,transcript='',coach='',allowFeedback=true;
$('token').value=token;
async function api(path,options={}){let r=await fetch(path,{...options,headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json',...(options.headers||{})}});
  if(!r.ok){let p=await r.json().catch(()=>({detail:'Error de conexión'}));throw Error(typeof p.detail==='string'?p.detail:'Revisa los datos ingresados');}return r;}
function message(text){$('sessionMessage').textContent=text;}
function metrics(m){if(!m)return;$('words').textContent=m.words??0;$('fillers').textContent=(m.filled_pause_candidate||0)+(m.contextual_filler_candidate||0);$('repetitions').textContent=m.repetition_candidate??0;$('pace').textContent=m.words_per_minute??'—';}
async function status(){if(!connected)return;try{let s=await(await api('/api/status')).json();
  $('connection').textContent=s.device_online?'Dispositivo conectado':'Esperando ESP8266';$('connection').classList.toggle('online',s.device_online);
  $('device').textContent=(s.device.simulated?'Nodo virtual de pruebas':'ESP8266 físico')+' · MQTT '+(s.mqtt_connected?'conectado':'sin conexión');
  if(!recording&&!closing){$('start').disabled=!s.device_online||!s.api_key_configured;$('demo').disabled=!s.device_online||!s.allow_demo;}
  $('accessMessage').textContent=s.api_key_configured?'GPT-Live configurado en la laptop.':'Falta OPENAI_API_KEY en .env. Puedes comprobar el flujo con una demostración simulada.';
}catch(e){$('connection').textContent='Sin conexión';$('accessMessage').textContent=e.message;$('start').disabled=true;$('demo').disabled=true;}}
$('connect').onclick=async()=>{token=$('token').value.trim();connected=true;try{await api('/api/status');sessionStorage.setItem('oratoria_access',token);$('refresh').disabled=false;await status();await history();}catch(e){connected=false;$('accessMessage').textContent=e.message;}};
function sendPCM(buffer){if(!ws||ws.readyState!==WebSocket.OPEN||closing)return;
  if(ws.bufferedAmount>64000){message('La conexión es demasiado lenta. Finalizando para marcar la incidencia.');stop();return;}
  let packet=new ArrayBuffer(16+buffer.byteLength),view=new DataView(packet),bytes=new Uint8Array(packet);
  bytes.set(new TextEncoder().encode(sid),0);view.setUint32(8,seq++,true);view.setUint32(12,offset,true);bytes.set(new Uint8Array(buffer),16);offset+=buffer.byteLength/2;ws.send(packet);}
async function prepareMic(){if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw Error('El celular necesita HTTPS con certificado de confianza; una IP por HTTP no permite grabar.');
  mic=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
  context=new AudioContext();await context.resume();}
function outputAudio(base64){if(!context||!$('playAudio').checked||!allowFeedback)return;let bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),buffer=context.createBuffer(1,bytes.length/2,16000),channel=buffer.getChannelData(0);
  for(let i=0;i<channel.length;i++)channel[i]=view.getInt16(i*2,true)/32768;
  let node=context.createBufferSource();node.buffer=buffer;node.connect(context.destination);playAt=Math.max(context.currentTime+.03,playAt);node.start(playAt);playAt+=buffer.duration;}
async function begin(demo){if(!connected||recording)return;if(!$('consent').checked){message('Marca tu aceptación antes de iniciar.');return;}
  $('start').disabled=true;$('demo').disabled=true;seq=0;offset=0;transcript='';coach='';closing=false;allowFeedback=$('feedback').checked;
  $('transcript').textContent='Esperando texto confirmado por el ESP8266…';$('coach').textContent=allowFeedback?'Escuchando…':'Feedback oculto para esta condición del experimento.';$('demoBanner').hidden=!demo;
  try{if(!demo)await prepareMic();message('Preparando sesión y esperando confirmación del dispositivo…');
    let session=await(await api('/api/sessions',{method:'POST',body:JSON.stringify({participant:$('participant').value.trim(),phase:$('phase').value,feedback:allowFeedback,demo,consent:true})})).json();sid=session.sid;
    ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws/'+sid);
    await new Promise((resolve,reject)=>{let timeout=setTimeout(()=>reject(Error('No se abrió el canal del micrófono')),10000);
      ws.onopen=()=>ws.send(JSON.stringify({token}));ws.onerror=()=>{clearTimeout(timeout);reject(Error('No se pudo conectar el micrófono'));};
      ws.onmessage=e=>{let p=JSON.parse(e.data);if(p.type==='ready'){clearTimeout(timeout);resolve();}else handle(p);};
      ws.onclose=()=>{clearTimeout(timeout);if(!recording)reject(Error('El servidor rechazó la conexión'));else if(!closing){message('Se cerró la conexión. La sesión se marcará como interrumpida.');cleanup();}};});
    recording=true;startedAt=Date.now();$('stop').disabled=false;
    for(let id of ['participant','phase','feedback','playAudio'])$(id).disabled=true;
    timer=setInterval(()=>{let sec=Math.floor((Date.now()-startedAt)/1000);$('clock').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');},250);
    if(demo){message('Prueba simulada: se envía una señal sintética y aparecen frases predefinidas. No se usa el micrófono.');let count=0;
      demoTimer=setInterval(()=>{let samples=new ArrayBuffer(640),view=new DataView(samples);for(let i=0;i<320;i++)view.setInt16(i*2,Math.round(1800*Math.sin((count*320+i)*2*Math.PI*220/16000)),true);sendPCM(samples);count++;if(count===300)stop();},20);
    }else{await context.audioWorklet.addModule('/static/pcm-worklet.js');source=context.createMediaStreamSource(mic);processor=new AudioWorkletNode(context,'pcm16000');
      processor.port.onmessage=e=>{if(e.data.pcm)sendPCM(e.data.pcm);if(e.data.flushed&&flushing)flushing();};source.connect(processor);processor.connect(context.destination);
      message('Grabando. Mantén esta página visible y el celular desbloqueado.');}
  }catch(e){message(e.message);if(sid){try{await api('/api/sessions/'+sid+'/stop',{method:'POST'});}catch(_){}}await cleanup();}}
async function stop(){if(!recording||closing)return;$('stop').disabled=true;clearInterval(demoTimer);message('Finalizando: se están confirmando registros y cerrando GPT-Live…');
  if(processor){await new Promise(resolve=>{let timeout=setTimeout(resolve,700);flushing=()=>{clearTimeout(timeout);resolve();};processor.port.postMessage('flush');});}
  closing=true;if(source)source.disconnect();if(processor)processor.disconnect();if(mic)mic.getTracks().forEach(t=>t.stop());
  if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'stop',frames:seq}));else await cleanup();}
function handle(p){if(p.type==='device_event'){let e=p.event;if(e.kind==='transcript.user'){transcript+=e.text||'';$('transcript').textContent=transcript;}
    if(e.kind==='feedback.ai'&&e.visible){coach+=e.text||'';$('coach').textContent=coach;}
    metrics(p.metrics);
  }else if(p.type==='meters'){metrics(p.metrics);$('relay').textContent=`Audio: ${p.frames_relayed} / ${p.frames_sent} tramas confirmadas por el relevo. El contador puede llevar un pequeño retraso.`;
  }else if(p.type==='assistant_audio'){outputAudio(p.pcm);
  }else if(p.type==='warning'||p.type==='error'){message(p.text);
  }else if(p.type==='ended'){metrics(p.summary.metrics);$('relay').textContent=`Registro final: ${p.summary.relay_frames} / ${p.summary.original_frames} tramas recibidas del relevo · ${p.summary.relay_missing_frames} ausentes.`;message(`Sesión guardada. Audio vía ESP: ${p.summary.audio_relay_complete?'completo':'con incidencias'} · Eventos pendientes: ${p.summary.pending_device_events}.`);cleanup();}}
async function cleanup(){recording=false;closing=false;clearInterval(timer);clearInterval(demoTimer);if(source){try{source.disconnect();}catch(_){}}if(processor){try{processor.disconnect();}catch(_){}}
  if(mic)mic.getTracks().forEach(t=>t.stop());if(context){try{await context.close();}catch(_){}}if(ws)ws.close();ws=null;mic=null;context=null;source=null;processor=null;sid=null;
  $('stop').disabled=true;for(let id of ['participant','phase','feedback','playAudio'])$(id).disabled=false;await status();await history();}
async function download(id){try{let response=await api('/api/sessions/'+id+'/export'),blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='sesion-'+id+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}catch(e){message(e.message);}}
async function review(id){try{let p=await(await api('/api/sessions/'+id)).json();reviewSid=id;$('review').hidden=false;
  let s=p.summary;$('reviewSummary').textContent=`Sesión ${id} · ${p.session.participant} · ${p.session.demo?'DEMOSTRACIÓN':'Audio real'} · ${p.events.length} eventos. Descarga el ZIP para escuchar el audio y verificar candidatos antes de anotar.`;
  $('annotationStatus').textContent='';$('annotationNote').value='';$('review').scrollIntoView({behavior:'smooth'});
}catch(e){message(e.message);}}
async function history(){if(!connected)return;try{let sessions=await(await api('/api/sessions')).json(),container=$('history');container.replaceChildren();
  if(!sessions.length){let p=document.createElement('p');p.className='caption';p.textContent='Aún no hay sesiones guardadas.';container.append(p);return;}
  for(let s of sessions){let row=document.createElement('div');row.className='history-item';let description=document.createElement('div'),title=document.createElement('div'),meta=document.createElement('p');title.className='history-title';
    title.textContent=`${s.participant} · ${s.phase==='pre'?'Antes':s.phase==='post'?'Después':'Práctica'} · ${s.demo?'DEMO':'GPT-Live'} · ${s.id}`;meta.className='history-meta';
    meta.textContent=new Date(s.started_at).toLocaleString('es-PE')+' · '+s.status;description.append(title,meta);let actions=document.createElement('div');actions.className='history-actions';
    let inspect=document.createElement('button');inspect.className='small secondary';inspect.textContent='Revisar';inspect.onclick=()=>review(s.id);actions.append(inspect);
    if(['ended','interrupted'].includes(s.status)){let button=document.createElement('button');button.className='small secondary';button.textContent='Descargar evidencias';button.onclick=()=>download(s.id);actions.append(button);}
    row.append(description,actions);container.append(row);}
}catch(e){$('history').textContent=e.message;}}
$('saveAnnotation').onclick=async()=>{if(!reviewSid)return;try{await api('/api/sessions/'+reviewSid+'/annotations',{method:'POST',body:JSON.stringify({reviewer:$('reviewer').value.trim(),label:$('annotationLabel').value,note:$('annotationNote').value})});$('annotationStatus').textContent='Anotación guardada; se incluirá en la exportación.';}catch(e){$('annotationStatus').textContent=e.message;}};
$('start').onclick=()=>begin(false);$('demo').onclick=()=>begin(true);$('stop').onclick=stop;$('refresh').onclick=history;setInterval(status,3000);

import './style.css';
import type {Metrics,Presentation,Presence} from '../lib/types.js';
import {candidateRate,recentTranscriptionRate,historyTrend} from '../lib/insights.js';
import {fillerContexts} from '../lib/fillers.js';

const icon=(name:string)=>{
  const paths:Record<string,string>={mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
    grid:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4"/>',
    arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',play:'<path d="m9 5 11 7-11 7Z"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
    wave:'<path d="M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4"/>',download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    check:'<path d="m5 12 4 4L19 6"/>',logout:'<path d="M9 4H4v16h5m6-12 4 4-4 4m-7-4h11"/>',link:'<path d="m10 13 4-4M7 15l-1 1a4 4 0 0 0 6 6l3-3a4 4 0 0 0 0-6M17 9l1-1a4 4 0 0 0-6-6L9 5a4 4 0 0 0 0 6"/>',
    file:'<path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8m-8 4h6"/>'};
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.mic}</svg>`;
};
const $=<T extends HTMLElement=HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
const esc=(x:unknown)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const time=(x:number)=>`${Math.floor(x/60).toString().padStart(2,'0')}:${Math.floor(x%60).toString().padStart(2,'0')}`;
const date=(x:string)=>new Date(x).toLocaleString('es-PE',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
const phase=(x:string)=>({pre:'Antes',post:'Después',practice:'Práctica'}[x]||x);
const finished=(p:Presentation)=>['completed','interrupted','error'].includes(p.status);
let state:{username:string;deviceId:string;device:Presence|null;presentation:Presentation|null;aiConfigured:boolean;workerOnline:boolean;maxSeconds:number}|null=null;
let current:Presentation|null=null;
let tab='practice',timer:ReturnType<typeof setInterval>|undefined,pollBusy=false,lastSignature='',busy=false;
let historySignature='';let previousActive:string|null=null;
let voiceSession='',spokenId=-1,pendingSpeech='',voiceTimer:ReturnType<typeof setTimeout>|undefined,lowSignalAt=0;
function say(text:string){
  if(!$<HTMLInputElement>('#voice')?.checked)return;
  const native='speechSynthesis' in window&&typeof SpeechSynthesisUtterance!=='undefined';
  const spanish=native?speechSynthesis.getVoices().find(v=>v.lang.toLowerCase().startsWith('es')):undefined;
  if(spanish){const u=new SpeechSynthesisUtterance(text);u.lang='es-PE';u.voice=spanish;speechSynthesis.speak(u);return;}
  void fetch('http://127.0.0.1:18765/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text.slice(0,700)}),signal:AbortSignal.timeout(45000)})
    .then(r=>{if(!r.ok)throw Error('voz');}).catch(()=>toast('No hay una voz disponible. Inicia Whisper en esta laptop o habilita una voz en español en tu navegador.'));
}
function speakAdvice(p:Presentation){if(voiceSession!==p.id){voiceSession=p.id;spokenId=-1;lowSignalAt=0;}const a=p.events.filter(x=>x.kind==='advice').at(-1);if(!a||a.id<=spokenId)return;const signature=a.id+':'+a.text;if(signature===pendingSpeech)return;pendingSpeech=signature;if(voiceTimer)clearTimeout(voiceTimer);voiceTimer=setTimeout(()=>{if(state?.presentation?.id===p.id&&state.presentation.status==='recording'&&state.presentation.feedback&&a.id>spokenId){spokenId=a.id;say(a.text);}},1800);}

async function api<T=any>(action:string,method='GET',body?:unknown):Promise<T>{
  const response=await fetch(`/api/server?action=${action}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store'});
  const data=await response.json();if(!response.ok){const e=new Error(data.error||'No se pudo completar la solicitud');(e as any).status=response.status;throw e;}return data;
}
function toast(text:string){let box=document.querySelector('#toast');if(!box){box=document.createElement('div');box.id='toast';box.setAttribute('role','status');document.body.append(box);}box.textContent=text;box.classList.add('visible');setTimeout(()=>box?.classList.remove('visible'),5500);}

function login(){
  if(timer)clearInterval(timer);state=null;current=null;
  $('#app').innerHTML=`<main class="login-layout"><section class="login-story"><a class="brand" href="/">${icon('wave')}<span>ENSAIA<span class="brand-dot">.</span></span></a><div class="story-body"><span class="eyebrow light">UN ESPACIO PARA ENCONTRAR TU VOZ</span><h1>Las grandes ideas<br>merecen una<br><em>voz clara.</em></h1><p>Practica tu presentación, escucha nuevas perspectivas y mejora un poco en cada intento.</p><div class="story-wave" aria-hidden="true">${Array.from({length:37},(_,i)=>`<i></i>`).join('')}</div></div><footer>Tu voz. Tu ritmo. Tu siguiente paso.</footer></section><section class="login-form-panel"><div class="login-form"><span class="small-tag">TU ESPACIO DE PRÁCTICA</span><h2>Qué bueno tenerte aquí.</h2><p class="muted">Entra con las credenciales registradas por tu dispositivo ENSAIA.</p><form id="login-form"><label for="username">Usuario</label><input id="username" name="username" autocomplete="username" placeholder="Tu usuario de ENSAIA" maxlength="32" required><label for="password">Contraseña</label><div class="password-field"><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Tu contraseña" maxlength="128" required><button type="button" id="show-password" aria-label="Mostrar contraseña">Ver</button></div><p id="login-error" class="form-error" role="alert"></p><button class="primary full" id="login-submit">Entrar a mi espacio ${icon('arrow')}</button></form><div class="login-help">${icon('link')}<div><strong>Tu dispositivo es el primer paso</strong><p>Conecta el ESP32 a Wi-Fi. El Monitor Serie te mostrará tu usuario y contraseña cuando el servidor acepte el registro.</p></div></div><span class="privacy-note">Acceso privado · Conexión cifrada · Tu micrófono, bajo tu control</span></div></section></main>`;
  $('#show-password').onclick=()=>{const p=$<HTMLInputElement>('#password');p.type=p.type==='password'?'text':'password';$('#show-password').textContent=p.type==='password'?'Ver':'Ocultar';};
  $('#login-form').onsubmit=async event=>{event.preventDefault();const button=$<HTMLButtonElement>('#login-submit');button.disabled=true;$('#login-error').textContent='';try{await api('login','POST',{username:$<HTMLInputElement>('#username').value.trim().toLowerCase(),password:$<HTMLInputElement>('#password').value});await dashboard();}catch(e){$('#login-error').textContent=(e as Error).message;}finally{button.disabled=false;}};
}
async function dashboard(){
  if(timer)clearInterval(timer);lastSignature='';historySignature='';tab='practice';
  state=await api('state');current=state!.presentation;previousActive=current?.id||null;
  $('#app').innerHTML=`<div class="workspace"><aside class="sidebar"><a class="brand" href="/">${icon('wave')}<span>ENSAIA<span class="brand-dot">.</span></span></a><span class="nav-label">MI ESPACIO</span><nav><button class="nav-item active" data-tab="practice">${icon('grid')}Mi práctica</button><button class="nav-item" data-tab="history">${icon('clock')}Mis presentaciones</button><button class="nav-item" data-tab="report">${icon('spark')}Mi progreso</button></nav><div class="sidebar-tip"><span class="tip-icon">${icon('spark')}</span><strong>Un consejo para hoy</strong><p>Haz una pausa antes de tu idea más importante. Dale espacio para llegar.</p></div><div class="sidebar-user"><span class="avatar">${esc(state!.username[0].toUpperCase())}</span><div><strong>${esc(state!.username)}</strong><small>Miembro de ENSAIA</small></div><button id="logout" class="icon-button" aria-label="Cerrar sesión">${icon('logout')}</button></div></aside><div class="main-area"><header class="topbar"><span>Tu espacio de expresión oral</span><div class="topbar-right"><span id="top-status" class="status-pill">Comprobando conexión</span><span class="header-avatar">${esc(state!.username.slice(0,2).toUpperCase())}</span></div></header><main class="content"><section id="practice-view"><div class="page-heading"><div><span class="eyebrow">CADA INTENTO CUENTA</span><h1>Tu próxima gran presentación<br>empieza con una práctica.</h1><p>Habla con intención. Nosotros te ayudamos a encontrar el ritmo.</p></div><span class="date-chip">${new Date().toLocaleDateString('es-PE',{weekday:'long',day:'numeric',month:'long'})}</span></div><div class="practice-grid"><section class="card studio-card"><div class="card-heading"><div><span class="section-number">01 / TU PRESENTACIÓN</span><h2>Encuentra tu ritmo</h2></div><span id="recording-badge" class="small-tag">LISTO PARA PRACTICAR</span></div><form id="presentation-form"><label for="title">¿Sobre qué vas a hablar?</label><input id="title" maxlength="120" placeholder="Ej. La importancia de organizar el tiempo" required><label for="audience">¿A quién te diriges? <span class="muted">(opcional)</span></label><input id="audience" maxlength="120" placeholder="Ej. estudiantes que conocen poco el tema"><label for="engine">Modo de transcripción</label><select id="engine"><option value="whisper">Whisper en mi laptop + IA de texto</option><option value="live">GPT-Live 1</option></select><p class="muted small" id="engine-status"></p><div class="form-row"><div><label for="phase">Tipo de práctica</label><select id="phase"><option value="practice">Práctica libre</option><option value="pre">Antes del entrenamiento</option><option value="post">Después del entrenamiento</option></select></div><div><label for="seconds">Duración máxima</label><select id="seconds"><option value="60">1 minuto</option><option value="120">2 minutos</option><option value="180">3 minutos</option><option value="30">30 segundos</option></select></div></div><div class="studio-stage"><div class="studio-orbit"><div class="mic-disc">${icon('mic')}</div></div><div class="visualizer" id="visualizer" aria-hidden="true">${Array.from({length:33},(_,i)=>`<i></i>`).join('')}</div><div class="timer" id="duration">00:00</div><p id="stage-caption">Tu siguiente idea está a un ensayo de distancia.</p></div><label class="toggle-row"><span><strong>Consejos mientras hablas</strong><small>Recomendaciones breves para acompañarte</small></span><input id="feedback" type="checkbox" checked><span class="toggle" aria-hidden="true"></span></label><label class="toggle-row"><span><strong>Leer consejos en voz alta</strong><small>Usa la voz disponible en este navegador</small></span><input id="voice" type="checkbox" checked><span class="toggle" aria-hidden="true"></span></label><button type="button" class="secondary full" id="voice-test">Probar voz</button><label class="consent"><input id="consent" type="checkbox"><span>Acepto grabar mi voz y procesar el audio o su transcripción con IA, según el modo elegido.</span></label><button type="submit" class="primary full" id="start">${icon('play')} Iniciar mi presentación</button><button type="button" class="stop-button full" id="stop" hidden>${icon('stop')} Finalizar y guardar</button></form><div class="device-line">${icon('mic')}<span id="device-line">Comprobando tu dispositivo…</span></div></section><aside class="practice-aside"><section class="card connection-card"><div class="card-heading"><h3>Tu dispositivo</h3><span id="device-dot" class="connection-dot"></span></div><div class="device-illustration">${icon('mic')}<span class="signal-rings"></span></div><strong id="device-name">ENSAIA · ESP32-S3</strong><p id="connection-description">Esperando conexión</p><div class="connection-details"><span>Micrófono <strong>INMP441</strong></span><span>Conexión <strong id="signal-value">—</strong></span><span>Transcripción <strong id="engine-name">Whisper local</strong></span></div></section><section class="guide-card"><span class="section-number">ANTES DE EMPEZAR</span><h3>Dale espacio a tu voz.</h3><ol><li>Busca un lugar tranquilo.</li><li>Comprueba que tu voz se escuche desde tu posición.</li><li>Respira y organiza tu primera idea.</li></ol><p>No hace falta hacerlo perfecto.<br>Solo hace falta empezar.</p></section></aside></div><div class="section-heading"><div><span class="eyebrow">LO QUE ESTÁ PASANDO</span><h2>Tu voz, en perspectiva</h2></div><span class="live-indicator"><i></i> Actualización en vivo</span></div><div class="metrics-grid" id="metrics"></div><div class="logs-grid"><section class="card log-card"><div class="card-heading"><h3>${icon('file')}Tu discurso</h3><span id="word-count" class="muted small">0 palabras</span></div><div id="transcript" class="log-body"><div class="empty-state">${icon('wave')}<strong>Aquí aparecerán tus ideas.</strong><p>La transcripción llegará cuando empieces a hablar.</p></div></div></section><section class="card log-card advice-card"><div class="card-heading"><h3>${icon('spark')}Una mirada que acompaña</h3><span class="ai-label">IA</span></div><div id="advice" class="log-body"><div class="empty-state">${icon('spark')}<strong>Pequeños ajustes. Más claridad.</strong><p>Tus recomendaciones aparecerán aquí durante la práctica.</p></div></div></section></div><section class="card summary-card" id="summary-card" hidden><div class="card-heading"><div><span class="section-number">TU SIGUIENTE PASO</span><h2>Una práctica, nuevos aprendizajes.</h2></div><button class="secondary export-button">${icon('download')} Exportar informe</button></div><div id="quality-note"></div><div id="summary" class="summary-text"></div><div class="summary-footer"><span id="summary-source"></span><button class="text-button" id="audio-download">Descargar audio ${icon('arrow')}</button></div></section><p class="measurement-note">Los candidatos a muletillas y las pausas son indicadores exploratorios. Revisa el audio y su contexto antes de interpretarlos como errores.</p></section><section id="history-view" hidden><div class="page-heading"><div><span class="eyebrow">UN INTENTO A LA VEZ</span><h1>Tu recorrido tiene voz.</h1><p>Vuelve a tus presentaciones y reconoce lo que has aprendido.</p></div><button class="secondary" id="refresh-history">Actualizar</button></div><div id="history-list" class="card"></div></section><section id="report-view" hidden><div class="page-heading"><div><span class="eyebrow">OBSERVAR PARA MEJORAR</span><h1>El progreso empieza<br>por escucharte.</h1><p>Selecciona dos presentaciones para comparar sus indicadores.</p></div></div><div class="card compare-card"><div class="form-row"><div><label for="compare-a">Primera presentación</label><select id="compare-a"></select></div><div><label for="compare-b">Segunda presentación</label><select id="compare-b"></select></div></div><button class="primary" id="compare">Comparar mis prácticas ${icon('arrow')}</button><div id="comparison" class="comparison"></div><p class="measurement-note">La comparación describe estas tomas. Cambios de tema, duración o condiciones pueden influir en los indicadores; no demuestra por sí sola un efecto del entrenamiento.</p></div></section><footer class="app-footer"><span>ENSAIA · Tu voz, con intención.</span><span>Una práctica a la vez.</span></footer></main></div></div>`;
  // Durante la captura, los dos paneles de trabajo quedan inmediatamente bajo el control.
  const trendPanel=Object.assign(document.createElement('section'),{id:'history-trend',className:'card history-trend'});
  $('#report-view .compare-card').before(trendPanel);
  const logs=$('.logs-grid'), heading=$('#practice-view .section-heading');
  heading.before(logs);
  logs.after(Object.assign(document.createElement('section'),{id:'analysis-panel',className:'card analysis-card'}));
  const noFeedback=Object.assign(document.createElement('p'),{id:'no-feedback-note',className:'measurement-note',textContent:'Sin consejos durante esta toma: los indicadores de desempeño y la evaluación aparecerán al finalizar.'});
  noFeedback.hidden=true;$('#analysis-panel').after(noFeedback);
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab!));
  $('#logout').onclick=async()=>{await api('logout','POST',{});login();};
  $('#presentation-form').onsubmit=start;
  $('#stop').onclick=stop;
  $('#voice-test').onclick=()=>say('Hola. Así escucharás los consejos de ENSAIA.');
  $('#engine').onchange=drawState;$('#voice').onchange=()=>{if(!$<HTMLInputElement>('#voice').checked&&'speechSynthesis' in window)speechSynthesis.cancel();};
  $('#refresh-history').onclick=()=>void loadHistory();
  document.querySelectorAll<HTMLButtonElement>('.export-button').forEach(b=>b.onclick=()=>download('export'));
  $('#audio-download').onclick=()=>download('audio');
  $('#compare').onclick=compare;
  drawState();await loadHistory();timer=setInterval(()=>void poll(),1500);
}
function switchTab(next:string){tab=next;for(const name of ['practice','history','report'])$(`#${name}-view`).hidden=next!==name;document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',(x as HTMLElement).dataset.tab===next));if(next!=='practice')void loadHistory();}
function drawState(){
  if(!state)return;const online=Boolean(state.device?.online&&Date.now()-(state.device?.at||0)<12000);
  const active=state.presentation&&!finished(state.presentation)?state.presentation:null;
  const p=current;
  const status=$('#top-status');status.textContent=online?'Dispositivo conectado':'Dispositivo desconectado';status.classList.toggle('online',online);
  $('#device-dot').classList.toggle('connected',online);$('#connection-description').textContent=online?'Listo para acompañarte':'Enciende el ESP32 y conecta su Wi-Fi';
  $('#signal-value').textContent=online?`${state.device?.rssi??'—'} dBm`:'Sin conexión';
  $('#engine-name').textContent=$<HTMLSelectElement>('#engine').value==='whisper'?'Whisper local':'GPT-Live 1';
  $('#engine-status').textContent=$<HTMLSelectElement>('#engine').value==='whisper'?(state.workerOnline?'Whisper conectado en la laptop.':'Inicia el transcriptor Whisper en la laptop antes de grabar.'):'GPT-Live procesa el audio en la nube.';
  $('#device-line').textContent=online?'Micrófono conectado · Captura desde tu ESP32':'Tu ESP32 necesita conectarse para comenzar';
  const recording=active?.status==='recording',closing=active?.status==='closing';
  $('#practice-view').classList.toggle('in-session',Boolean(active));
  const quietPractice=Boolean(active&&!active.feedback);
  $('#practice-view').classList.toggle('feedback-off',quietPractice);
  $('#analysis-panel').hidden=quietPractice;$('#no-feedback-note').hidden=!quietPractice;
  $('#visualizer').classList.toggle('moving',Boolean(recording));
  $('#recording-badge').textContent=recording?'ESTÁS EN EL AIRE':closing?'PREPARANDO TU INFORME':active?'CONECTANDO':'LISTO PARA PRACTICAR';
  $('#recording-badge').classList.toggle('recording',Boolean(recording));
  $('#stage-caption').textContent=recording?'Habla con calma. Este momento es tuyo.':closing?'Estamos reuniendo tus aprendizajes…':active?'Preparando el micrófono y la IA…':'Tu siguiente idea está a un ensayo de distancia.';
  $('#duration').textContent=time(p?.metrics.seconds||0);
  const startButton=$<HTMLButtonElement>('#start'),stopButton=$<HTMLButtonElement>('#stop');
  startButton.hidden=Boolean(active);stopButton.hidden=!active;
  startButton.disabled=!online||busy||!state.aiConfigured;stopButton.disabled=busy||closing||active?.status==='pending';
  for(const id of ['title','audience','phase','seconds','feedback','consent','engine'])($(`#${id}`) as HTMLInputElement).disabled=Boolean(active);
  const metrics=p?.metrics||{seconds:0,words:0,wordsPerMinute:0,fillerCandidates:0,longPauses:0};
  $('#metrics').innerHTML=[['clock','Tiempo de voz',time(metrics.seconds),'Duración del audio recibido'],['wave','Ritmo al hablar',metrics.wordsPerMinute,'palabras por minuto'],['mic','Posibles muletillas',metrics.fillerCandidates,'A revisar en su contexto'],['spark','Pausas prolongadas',metrics.longPauses,'Silencio bajo ≥ 0,8 segundos']].map(([i,label,value,note])=>`<article class="metric-card"><div class="metric-icon">${icon(String(i))}</div><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('');
  $('#word-count').textContent=`${metrics.words} palabras`;
  renderAssessment(p);
  if(p){
    if(recording&&p.feedback)speakAdvice(p);
    if(recording&&p.metrics.seconds>=8&&Date.now()-lowSignalAt>30000){const noSignal=p.metrics.peak===0;const weak=p.metrics.seconds>=15&&(p.metrics.recentRms??1)<0.002;const clipping=(p.metrics.recentClipped??0)>10;if(noSignal||weak||clipping){lowSignalAt=Date.now();const warning=noSignal?'No recibo señal del micrófono. Revisa la conexión.':clipping?'La señal se satura. Si estás hablando muy fuerte, reduce la intensidad o revisa la ganancia.':'La señal es muy baja o hay silencio. Si estás hablando, proyecta la voz o acércate al micrófono.';toast(warning);if(p.feedback)say(warning);}}
    const sig=p.id+':'+p.transcript+':'+p.advice+':'+p.status+':'+p.summary;
    if(sig!==lastSignature){lastSignature=sig;
      $('#transcript').innerHTML=p.transcript?`<p class="transcript-text">${esc(p.transcript)}</p>`:'<div class="empty-state"><strong>Esperando tus primeras palabras…</strong></div>';
      const advice=p.events.filter(x=>x.kind==='advice');
      $('#advice').innerHTML=advice.length?advice.map(x=>`<div class="advice-item"><span>${icon('spark')}</span><div><small>${time((x.audioMs||0)/1000)}</small><p>${esc(x.text)}</p></div></div>`).join(''):`<div class="empty-state"><strong>${p.feedback?'Escuchando para acompañarte.':'Consejos en vivo desactivados.'}</strong><p>${p.feedback?'La IA ofrecerá recomendaciones cuando encuentre una oportunidad clara.':'Recibirás el informe al finalizar.'}</p></div>`;
      if(recording){$('#transcript').scrollTop=$('#transcript').scrollHeight;$('#advice').scrollTop=$('#advice').scrollHeight;}
      $('#summary-card').hidden=!finished(p);
      if(finished(p)){
        $('#summary').textContent=p.summary||p.error||'No se generó un informe para esta toma.';
        $('#summary-source').textContent=p.summarySource==='gpt-live-1'?'Reflexiones de GPT-Live 1':p.summarySource==='text-ai'?'Reflexiones de IA de texto':'Orientaciones a partir de indicadores';
        $('#audio-download').hidden=!p.audioSaved;
        $('#quality-note').innerHTML=p.status==='completed'&&p.sourceComplete&&p.archived?'<div class="quality-note">'+icon('check')+' Audio completo y presentación guardada</div>':`<div class="quality-note warning">${esc(p.error||'Toma incompleta o guardado aún no confirmado. Revisa los registros antes de usar sus resultados.')}</div>`;
      }
    }
  }
}
function renderAssessment(p:Presentation|null){
  const panel=$('#analysis-panel');const metrics=p?.metrics;
  const latest=p?.assessments?.at(-1), points=(p?.assessments||[]).filter(x=>x.total!==null);
  const fillers=metrics?.fillers||[];
  const contexts=p?fillerContexts(p.transcript):[];
  const recentRate=p?recentTranscriptionRate(p.events,metrics?.seconds??0):null;
  const per100=metrics?candidateRate(metrics.fillerCandidates,metrics.words):null;
  const signal=!metrics||metrics.seconds<5?'Esperando señal':(metrics.recentClipped||0)>10?'Señal saturada: reduce ganancia o aleja el micrófono':(metrics.recentRms||0)<0.002?'Señal baja o silencio: si hablas, proyecta la voz o revisa el micrófono':'Señal recibida; el volumen en el aula no está calibrado';
  const items=latest?([['Claridad','clarity'],['Organización','organization'],['Desarrollo de ideas','development']] as const).map(([label,key])=>{const d=latest.dimensions[key];return `<div class="rubric-item"><div><strong>${label}</strong><b>${d.score===null?'Sin evidencia':d.score+'/100'}</b></div>${d.evidence?`<q>${esc(d.evidence)}</q>`:''}${d.suggestion?`<p>${esc(d.suggestion)}</p>`:''}</div>`;}).join(''):'';
  panel.innerHTML=`<div class="card-heading"><div><span class="section-number">LECTURA FORMATIVA · NO VALIDADA</span><h2>Tu evolución durante la práctica</h2></div><strong class="score-big">${latest?.total==null?'—':latest.total}<small> / 100</small></strong></div>
    <p class="analysis-explain">Promedio de claridad, organización y desarrollo, con igual peso. Estimación de IA basada en la transcripción; exige evidencia en las tres dimensiones.</p>
    ${latest?.source==='posthoc'?'<p class="quality-note">Esta puntuación se calculó después de la presentación, con la rúbrica corregida.</p>':''}
    ${p?.assessmentError?`<p class="quality-note warning" role="status">${esc(p.assessmentError)}</p>`:''}
    ${latest?`<div class="rubric-grid">${items}</div>${latest.complexity?`<p class="complexity"><strong>Complejidad y explicación:</strong> ${esc(latest.complexity)}</p>`:''}`:'<p class="muted small">La evaluación aparecerá al contar con suficiente transcripción; puede tardar unos segundos.</p>'}
    <div class="trend"><strong>Evolución en esta toma</strong>${points.length?`<div class="trend-bars">${points.map(x=>`<div class="trend-point" title="${time(x.seconds)}: ${x.total}/100"><span>${x.total}</span><i style="height:${Math.max(5,x.total!)}%"></i><small>${time(x.seconds)}</small></div>`).join('')}</div><p>Los puntos comparan evaluaciones acumuladas, no intervalos independientes.</p>`:'<p>Aún no hay puntos suficientes para mostrar una evolución.</p>'}</div>
    <div class="analysis-detail"><div><strong>Posibles muletillas</strong><p>${fillers.length?fillers.map(x=>`${esc(x.token)}: ${x.count}`).join(' · '):'No detectadas en la transcripción'}${per100!==null?` · ${per100} por 100 palabras`:''}</p><small>Son candidatos; palabras como «este» o «bueno» pueden ser necesarias. Whisper puede omitir sonidos.</small>${contexts.length?`<div class="filler-contexts"><strong>Revisa los últimos ejemplos</strong>${contexts.map(x=>`<p class="filler-context">${x.leading?'…':''}${esc(x.before)}<mark>${esc(x.match)}</mark>${esc(x.after)}${x.trailing?'…':''}</p>`).join('')}</div>`:''}</div><div><strong>Señal de los últimos 5 s</strong><p>${esc(signal)}</p><small>El nivel recibido depende de la distancia, ruido y conexiones; no mide dB del aula.</small></div><div><strong>Ritmo reciente</strong><p>${recentRate===null?'Necesitamos más transcripción reciente.':`${recentRate} palabras/minuto estimadas en los últimos 30 s.`}</p><small>Se basa en cuándo llega el texto; las pausas y la demora de transcripción afectan la cifra.</small>${recentRate!==null&&recentRate>200?'<p>Si tus ideas se acumulan, prueba una pausa entre ellas.</p>':recentRate!==null&&recentRate<75?'<p>Si las pausas interrumpen la idea, prueba unir frases relacionadas.</p>':''}</div></div>`;
}
async function poll(){
  if(pollBusy||!state)return;pollBusy=true;
  try{
    const next=await api<typeof state>('state');if(!next)return;
    const old=previousActive;state=next;previousActive=state.presentation?.id||null;
    if(state.presentation){current=state.presentation;}
    else if(old){current=await api(`presentation&id=${encodeURIComponent(old)}`);await loadHistory();}
    if(current&&!finished(current)&&!state.presentation)current=await api(`presentation&id=${current.id}`);
    drawState();
  }catch(e){if((e as any).status===401)login();else $('#top-status').textContent='Reconectando con tu espacio…';}finally{pollBusy=false;}
}
async function start(event:Event){event.preventDefault();if(busy)return;
  if(!$<HTMLInputElement>('#consent').checked){toast('Confirma la aceptación de grabación para comenzar.');return;}
  if('speechSynthesis' in window){speechSynthesis.cancel();if($<HTMLInputElement>('#voice').checked){const unlock=new SpeechSynthesisUtterance('');unlock.lang='es-PE';speechSynthesis.speak(unlock);}}
  if(voiceTimer)clearTimeout(voiceTimer);voiceSession='';spokenId=-1;pendingSpeech='';lowSignalAt=0;busy=true;drawState();try{
    current=await api('start','POST',{title:$<HTMLInputElement>('#title').value.trim(),audience:$<HTMLInputElement>('#audience').value.trim(),phase:$<HTMLSelectElement>('#phase').value,
      seconds:Number($<HTMLSelectElement>('#seconds').value),feedback:$<HTMLInputElement>('#feedback').checked,mode:$<HTMLSelectElement>('#engine').value,consent:true});
    state!.presentation=current;previousActive=current!.id;lastSignature='';drawState();$('#practice-view').scrollIntoView({block:'start'});
  }catch(e){toast((e as Error).message);}finally{busy=false;drawState();}}
async function stop(){if(!state?.presentation||busy)return;if(voiceTimer)clearTimeout(voiceTimer);if('speechSynthesis' in window)speechSynthesis.cancel();busy=true;drawState();try{await api('stop','POST',{id:state.presentation.id});toast('Finalizando la captura y preparando tu informe.');}catch(e){toast((e as Error).message);}finally{busy=false;}}
function download(action:string){if(current)window.location.assign(`/api/server?action=${action}&id=${current.id}`);}
type HistoryItem=Partial<Presentation>&{score?:number|null};
let sessions:HistoryItem[]=[];
async function loadHistory(){
  try{
    const data=await api<{sessions:HistoryItem[]}>('history');sessions=data.sessions;
    const signature=JSON.stringify(sessions);if(signature===historySignature)return;historySignature=signature;
    $('#history-list').innerHTML=sessions.length?`<div class="history-header"><span>PRESENTACIÓN</span><span>ETAPA</span><span>DURACIÓN</span><span>ESTADO</span><span></span></div>`+sessions.map(p=>`<button class="history-row" data-id="${p.id}"><span><strong>${esc(p.title)}</strong><small>${date(p.createdAt!)}</small></span><span>${phase(p.phase!)}</span><span>${time(p.metrics?.seconds||0)}</span><span class="history-status ${p.status==='completed'?'done':''}">${p.status==='completed'?'Guardada':p.status==='interrupted'?'Incompleta':'En proceso'}</span>${icon('arrow')}</button>`).join(''):'<div class="empty-history">'+icon('mic')+'<h2>Tu primera práctica te espera.</h2><p>Las presentaciones guardadas aparecerán aquí.</p><button class="primary" id="first-practice">Empezar una práctica</button></div>';
    document.querySelectorAll<HTMLButtonElement>('[data-id]').forEach(b=>b.onclick=async()=>{try{current=await api(`presentation&id=${b.dataset.id}`);lastSignature='';switchTab('practice');drawState();$('#summary-card').scrollIntoView({behavior:'smooth',block:'start'});}catch(e){toast((e as Error).message);}});
    const first=document.querySelector<HTMLButtonElement>('#first-practice');if(first)first.onclick=()=>switchTab('practice');
    const options=sessions.filter(x=>x.status==='completed'||x.status==='interrupted').map(p=>`<option value="${p.id}">${esc(p.title)} · ${phase(p.phase!)} · ${date(p.createdAt!)}</option>`).join('');
    const compareA=$<HTMLSelectElement>('#compare-a'),compareB=$<HTMLSelectElement>('#compare-b');
    const previousA=compareA.value,previousB=compareB.value;
    compareA.innerHTML=options||'<option value="">Aún no hay presentaciones</option>';compareB.innerHTML=options||'<option value="">Aún no hay presentaciones</option>';
    if(previousA&&[...compareA.options].some(x=>x.value===previousA))compareA.value=previousA;else if(compareA.options.length>1)compareA.selectedIndex=1;
    if(previousB&&[...compareB.options].some(x=>x.value===previousB))compareB.value=previousB;else compareB.selectedIndex=0;
    const trend=historyTrend(sessions);
    $('#history-trend').innerHTML=`<div class="card-heading"><div><span class="section-number">HISTORIAL · PUNTUACIÓN FORMATIVA</span><h2>Tu recorrido en el tiempo</h2></div></div>${trend.length?`<div class="history-trend-list">${trend.map((p,i)=>`<div class="history-trend-row"><span><strong>${esc(p.title)}</strong><small>${date(p.createdAt!)} · ${phase(p.phase!)}</small></span><span><b>${p.score}/100</b>${i?` <small>${p.score!-trend[i-1].score!>=0?'+':''}${p.score!-trend[i-1].score!} respecto a la anterior</small>`:''}</span></div>`).join('')}</div>`:'<p class="muted small">Las prácticas completas con una evaluación disponible aparecerán aquí.</p>'}<p class="measurement-note">Las puntuaciones describen cada toma. Cambios de tema, duración, condiciones o modo de transcripción pueden afectar la comparación; una diferencia no demuestra por sí sola mejora ni efecto del entrenamiento.</p>`;
  }catch{toast('No pudimos cargar el historial. Puedes volver a intentarlo.');}
}
async function compare(){
  const a=$<HTMLSelectElement>('#compare-a').value,b=$<HTMLSelectElement>('#compare-b').value;
  if(!a||!b||a===b){toast('Selecciona dos presentaciones diferentes.');return;}
  try{
    const [first,last]=await Promise.all([api<Presentation>(`presentation&id=${a}`),api<Presentation>(`presentation&id=${b}`)]);
    const firstScore=first.assessmentError?null:first.assessments?.at(-1)?.total,lastScore=last.assessmentError?null:last.assessments?.at(-1)?.total;
    const orderWarning=Date.parse(first.createdAt)>Date.parse(last.createdAt)?'La primera selección es posterior a la segunda; el signo refleja ese orden. ':'';
    const qualityWarning=first.status!=='completed'||last.status!=='completed'||!first.sourceComplete||!last.sourceComplete?'Hay una toma incompleta; interpreta la comparación con cautela. ':'';
    const firstFillers=candidateRate(first.metrics.fillerCandidates,first.metrics.words),lastFillers=candidateRate(last.metrics.fillerCandidates,last.metrics.words);
    const rows:[string,keyof Metrics,string][]=[['Tiempo de audio','seconds','s'],['Ritmo','wordsPerMinute','ppm'],['Candidatos a muletillas','fillerCandidates',''],['Repeticiones consecutivas','repetitions',''],['Pausas prolongadas','longPauses','']];
    $('#comparison').innerHTML=`<h3>Dos momentos de tu práctica</h3>${orderWarning||qualityWarning?`<p class="quality-note warning">${esc(orderWarning+qualityWarning)}</p>`:''}<p class="score-compare">Puntuación formativa: ${firstScore??'sin evaluación'} → ${lastScore??'sin evaluación'}${firstScore!=null&&lastScore!=null?` (${lastScore-firstScore>=0?'+':''}${lastScore-firstScore} puntos)`:''}</p><table><thead><tr><th>Indicador</th><th>Primera</th><th>Segunda</th></tr></thead><tbody>${rows.map(([label,k,u])=>`<tr><td>${label}</td><td>${first.metrics[k]} ${u}</td><td>${last.metrics[k]} ${u}</td></tr>`).join('')}</tbody></table><p class="muted small">Candidatos por 100 palabras: ${firstFillers??'sin suficientes palabras'} → ${lastFillers??'sin suficientes palabras'}. La transcripción puede omitir muletillas.</p><p class="muted small">${esc(first.title)} → ${esc(last.title)}</p>`;
  }catch(e){toast((e as Error).message);}
}
api('state').then(()=>dashboard()).catch(()=>login());

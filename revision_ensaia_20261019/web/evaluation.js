'use strict';
let evaluationData=null, comparisonData=null, comparisonSessions=[], audioUrls=[];
const kindNames={filled_pause_candidate:'Pausa rellena',contextual_filler_candidate:'Muletilla contextual',repetition_candidate:'Repetición'};
const rubricCriteria={
  clarity:['Claridad','1: mensaje difícil de entender; 3: comprensible con pasajes ambiguos; 5: mensaje comprensible y términos explicados.'],
  introduction:['Introducción','1: no presenta tema ni propósito; 3: presenta solo uno; 5: presenta claramente tema y propósito.'],
  organization:['Orden de ideas','1: ideas desconectadas; 3: secuencia parcial; 5: secuencia lógica y transiciones claras.'],
  development:['Desarrollo','1: afirmaciones sin explicación; 3: explicación parcial; 5: ideas explicadas con un ejemplo pertinente.'],
  conclusion:['Conclusión','1: cierre ausente; 3: cierre genérico; 5: sintetiza la idea central y termina claramente.']};
function element(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
function option(value,text){const e=element('option',text);e.value=value;return e;}
function numberText(value){return value===null||value===undefined?'Sin datos':typeof value==='number'?value.toLocaleString('es-PE',{maximumFractionDigits:3}):String(value);}
function dataTable(headers,rows){const wrap=element('div');wrap.className='table-scroll';const t=element('table'),head=element('thead'),tr=element('tr');
  headers.forEach(h=>{const th=element('th',h);th.scope='col';tr.append(th);});head.append(tr);t.append(head);const body=element('tbody');
  rows.forEach(row=>{const r=element('tr');row.forEach(value=>r.append(element('td',numberText(value))));body.append(r);});t.append(body);wrap.append(t);return wrap;}
function renderQuality(p){const q=p.quality,d=q.diagnostics||{};
  $('reviewQuality').replaceChildren(dataTable(['Indicador','Resultado'],[
    ['Duración de audio (s)',p.seconds],['Pérdida de tramas (%)',q.loss_percent],['Tramas faltantes',q.missing_frames],
    ['Envío completo a IA',q.provider_audio_complete===true?'Sí':q.provider_audio_complete===false?'No':'Sin datos'],
    ['Eventos pendientes',q.pending_events],['Descartes en recepción MQTT',q.mqtt_drops],
    ['Latencia eco MQTT mediana (ms)',q.ack_latency_median_ms],['Latencia eco MQTT p95 (ms)',q.ack_latency_p95_ms],
    ['Eventos usados para latencia',q.ack_latency_samples],['RAM mínima observada (bytes)',d.min_free_heap],
    ['Señal Wi-Fi mínima observada (dBm)',d.min_wifi_rssi],['Desconexiones observadas',d.observed_disconnects],
    ['Escrituras TCP incompletas durante sesión',d.short_writes_during_session]]));
  const warning=element('p',p.eligible?'Integridad técnica verificada.':p.warnings.join(' · '));warning.className=p.eligible?'caption':'notice';$('reviewQuality').append(warning);}
function scoreSelect(id){const s=element('select');s.id=id;s.append(option('','No evaluado'));for(let n=1;n<=5;n++)s.append(option(String(n),String(n)));return s;}
for(const [key,[title,description]] of Object.entries(rubricCriteria)){
  const label=element('label',title),s=scoreSelect('rubric_'+key),help=element('small',description);label.append(s,help);$('rubricFields').append(label);}
function addMissedRow(value={}){const row=element('div');row.className='missed-row';row.dataset.id=value.id||crypto.randomUUID();
  const kind=element('select');kind.className='missed-kind';for(const [key,title] of Object.entries(kindNames))kind.append(option(key,title));kind.value=value.kind||'filled_pause_candidate';
  const token=element('input');token.className='missed-token';token.maxLength=100;token.value=value.token||'';
  const time=element('input');time.type='number';time.className='missed-time';time.min=0;time.step='.01';time.value=value.at_seconds??'';
  for(const [title,input] of [['Tipo',kind],['Expresión escuchada',token],['Segundo del audio',time]]){const label=element('label',title);label.append(input);row.append(label);}
  const remove=element('button','Quitar omisión');remove.className='secondary small';remove.onclick=()=>row.remove();row.append(remove);$('missedList').append(row);}
async function loadReviewAudio(id){audioUrls.forEach(URL.revokeObjectURL);audioUrls=[];$('reviewAudio').replaceChildren();
  for(const [name,title] of [['microfono_original.wav','Audio original'],['audio_via_esp8266.wav','Audio retransmitido']]){
    const box=element('div'),label=element('p',title),button=element('button','Cargar '+title.toLowerCase());button.className='small secondary';
    button.onclick=async()=>{button.disabled=true;try{const response=await api('/api/sessions/'+id+'/audio/'+name),blob=await response.blob();if(reviewSid!==id)return;
      const url=URL.createObjectURL(blob);audioUrls.push(url);const audio=element('audio');audio.controls=true;audio.src=url;audio.setAttribute('aria-label',title);box.append(audio);button.remove();
    }catch(e){button.disabled=false;label.textContent=title+': '+e.message;}};box.append(label,button);$('reviewAudio').append(box);}}
function renderHuman(p){const h=p.human;if(!h){$('humanResults').textContent='Sin revisión guardada para este revisor.';return;}
  $('humanResults').replaceChildren(element('p',h.complete?'Revisión humana completa.':'Borrador: conteos parciales; no usar como resultado final.'),
    dataTable(['Indicador humano','Resultado'],[['Muletillas confirmadas y añadidas',h.fillers],['Repeticiones confirmadas y añadidas',h.repetitions],
      ['Palabras corregidas',h.words],['Muletillas / minuto',h.fillers_per_minute],['Muletillas / 100 palabras',h.fillers_per_100_words],
      ['Repeticiones / minuto',h.repetitions_per_minute],['Repeticiones / 100 palabras',h.repetitions_per_100_words],
      ['Precisión de candidatos revisados',h.precision],['Cobertura respecto a la revisión completa',h.recall]]));}
async function openEvaluation(id,scroll=true){try{
  const reviewer=$('reviewer').value.trim();const p=await(await api('/api/sessions/'+id+'/evaluation?reviewer='+encodeURIComponent(reviewer))).json();
  reviewSid=id;evaluationData=p;$('review').hidden=false;
  $('reviewSummary').textContent=`${p.session.participant} · ${p.session.phase==='pre'?'Antes':p.session.phase==='post'?'Después':'Práctica'} · ${id} · ${p.session.feedback_enabled?'Consejos activados':'Sin consejos'} · ${p.session.demo?'DEMO':'Audio real'}`;
  renderQuality(p);await loadReviewAudio(id);const review=p.review||{},decisions=new Map((review.decisions||[]).map(d=>[d.event_id,d.label]));
  $('candidateList').replaceChildren();for(const e of p.candidates){const label=element('label',`${kindNames[e.candidate_kind]}: «${e.token||''}» · posición ${e.char_start??'?'} · tiempo aproximado ${e.start_ms==null?'sin datos':numberText(e.start_ms/1000)+' s'}`),s=element('select');
    s.dataset.eventId=e.id;s.append(option('','Pendiente'),option('confirmed','Confirmar en audio'),option('rejected','Descartar'),option('uncertain','Dudoso'));s.value=decisions.get(e.id)||'';label.append(s);$('candidateList').append(label);}
  if(!p.candidates.length)$('candidateList').textContent='Sin candidatos automáticos. Escucha el audio para buscar posibles omisiones.';
  $('missedList').replaceChildren();(review.additions||[]).forEach(addMissedRow);$('correctedTranscript').value=review.corrected_transcript??'';
  $('evaluationNote').value=review.note||'';$('reviewComplete').checked=!!review.complete;
  for(const key of Object.keys(rubricCriteria))$('rubric_'+key).value=review.rubric?.[key]??'';
  $('evaluationStatus').textContent='';renderHuman(p);$('legacyAnnotations').replaceChildren();
  for(const a of p.legacy_annotations)$('legacyAnnotations').append(element('p',`${a.reviewer} · ${a.label}: ${a.note}`));
  if(!p.legacy_annotations.length)$('legacyAnnotations').textContent='Sin anotaciones anteriores.';
  $('surveyUsefulness').value=p.survey?.usefulness??'';$('surveyDistraction').value=p.survey?.distraction??'';$('surveyComment').value=p.survey?.comment??'';$('surveyStatus').textContent='';
  if(scroll)$('review').scrollIntoView({behavior:'smooth'});
}catch(e){$('evaluationStatus').textContent=e.message;message(e.message);}}
$('loadReviewer').onclick=()=>{if(reviewSid)openEvaluation(reviewSid,false);};
$('addMissed').onclick=()=>addMissedRow();
$('copyTranscript').onclick=async()=>{if(!reviewSid)return;try{const p=await(await api('/api/sessions/'+reviewSid)).json();$('correctedTranscript').value=p.events.filter(e=>e.kind==='transcript.user').map(e=>e.payload.text||'').join('');}catch(e){$('evaluationStatus').textContent=e.message;}};
$('saveEvaluation').onclick=async()=>{if(!reviewSid)return;try{
  const additions=Array.from($('missedList').children).map(row=>{const value=row.querySelector('.missed-time').value;if(value==='')throw Error('Indica el segundo de cada omisión');return {id:row.dataset.id,kind:row.querySelector('.missed-kind').value,token:row.querySelector('.missed-token').value.trim(),at_seconds:Number(value)};});
  const decisions=Array.from($('candidateList').querySelectorAll('select')).filter(s=>s.value).map(s=>({event_id:s.dataset.eventId,label:s.value}));
  const rubric=Object.fromEntries(Object.keys(rubricCriteria).map(key=>[key,$('rubric_'+key).value?Number($('rubric_'+key).value):null]));
  await api('/api/sessions/'+reviewSid+'/evaluation',{method:'PUT',body:JSON.stringify({reviewer:$('reviewer').value.trim(),decisions,additions,rubric,complete:$('reviewComplete').checked,corrected_transcript:$('correctedTranscript').value||null,note:$('evaluationNote').value})});
  await openEvaluation(reviewSid,false);$('evaluationStatus').textContent='Revisión guardada. Se incluye en el ZIP de evidencias.';
}catch(e){$('evaluationStatus').textContent=e.message;}};
$('saveSurvey').onclick=async()=>{if(!reviewSid)return;try{if(!$('surveyUsefulness').value||!$('surveyDistraction').value)throw Error('Responde las dos preguntas');
  await api('/api/sessions/'+reviewSid+'/survey',{method:'PUT',body:JSON.stringify({usefulness:Number($('surveyUsefulness').value),distraction:Number($('surveyDistraction').value),comment:$('surveyComment').value})});$('surveyStatus').textContent='Encuesta guardada.';
}catch(e){$('surveyStatus').textContent=e.message;}};
function populateComparison(sessions){comparisonSessions=sessions;const current=$('comparisonParticipant').value;$('comparisonParticipant').replaceChildren(option('','Selecciona un participante'));
  [...new Set(sessions.filter(s=>s.phase==='pre'||s.phase==='post').map(s=>s.participant))].sort().forEach(p=>$('comparisonParticipant').append(option(p,p)));
  $('comparisonParticipant').value=current;updatePairs();}
function updatePairs(){for(const [id,phase] of [['comparisonPre','pre'],['comparisonPost','post']]){const current=$(id).value;$(id).replaceChildren(option('','Selecciona una sesión'));
  comparisonSessions.filter(s=>s.participant===$('comparisonParticipant').value&&s.phase===phase).forEach(s=>{const m=JSON.parse(s.summary_json||'{}').metrics||{};$(id).append(option(s.id,`${s.id} · ${numberText(m.captured_audio_seconds)} s · ${s.status} · ${s.demo?'DEMO':'Real'}`));});$(id).value=current;}
  comparisonData=null;$('downloadComparison').disabled=true;$('comparisonResults').replaceChildren();$('comparisonStatus').textContent='';}
$('comparisonParticipant').onchange=updatePairs;
for(const id of ['comparisonPre','comparisonPost','comparisonReviewer'])$(id).onchange=()=>{comparisonData=null;$('downloadComparison').disabled=true;$('comparisonResults').replaceChildren();};
const metricNames={fillers:'Muletillas',repetitions:'Repeticiones',words:'Palabras',fillers_per_minute:'Muletillas / minuto',repetitions_per_minute:'Repeticiones / minuto',fillers_per_100_words:'Muletillas / 100 palabras',repetitions_per_100_words:'Repeticiones / 100 palabras'};
$('compareSessions').onclick=async()=>{try{if(!$('comparisonPre').value||!$('comparisonPost').value)throw Error('Selecciona ambas sesiones');
  const p=await(await api('/api/comparison',{method:'POST',body:JSON.stringify({pre:$('comparisonPre').value,post:$('comparisonPost').value,reviewer:$('comparisonReviewer').value.trim()})})).json();comparisonData=p;$('downloadComparison').disabled=false;
  $('comparisonStatus').textContent=[...p.warnings,p.interpretation].join(' · ');$('comparisonResults').replaceChildren();
  for(const [key,title] of [['automatic_changes','Candidatos automáticos · exploratorio'],['human_changes','Resultados humanos confirmados']]){const changes=p[key];$('comparisonResults').append(element('h3',title));
    if(!changes){$('comparisonResults').append(element('p','Sin comparación disponible: revisa la integridad técnica y la revisión humana.'));continue;}
    $('comparisonResults').append(dataTable(['Indicador','Antes','Después','Cambio Después − Antes','Cambio %'],Object.entries(changes).map(([k,v])=>[metricNames[k]||k,v.before,v.after,v.delta,v.change_percent])));}
  $('comparisonResults').append(element('p','Una reducción de muletillas tiene cambio negativo. Si Antes es cero, el cambio porcentual queda sin datos. Menos palabras no equivale por sí solo a mejora.'));
  if(Object.keys(p.rubric_changes).length)$('comparisonResults').append(element('h3','Rúbrica · mayor puntuación indica mejor cumplimiento'),dataTable(['Criterio','Antes','Después','Cambio'],Object.entries(p.rubric_changes).map(([k,v])=>[rubricCriteria[k][0],v.before,v.after,v.delta])));
  $('comparisonResults').append(element('h3','Percepción del participante'),dataTable(['Etapa','Utilidad (1–5)','Distracción (1–5)'],[['Antes',p.pre.survey?.usefulness,p.pre.survey?.distraction],['Después',p.post.survey?.usefulness,p.post.survey?.distraction]]));
}catch(e){$('comparisonStatus').textContent=e.message;}};
$('downloadComparison').onclick=()=>{if(!comparisonData)return;const url=URL.createObjectURL(new Blob([JSON.stringify(comparisonData,null,2)],{type:'application/json'}));const a=element('a');a.href=url;a.download='comparacion-'+comparisonData.pre.session.participant+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};

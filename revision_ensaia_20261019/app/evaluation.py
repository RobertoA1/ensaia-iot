"""Evaluacion descriptiva; no infiere causalidad ni reemplaza la escucha humana."""
import json
import math
import statistics
from datetime import datetime
from .analysis import WORDS

KINDS={'filled_pause_candidate','contextual_filler_candidate','repetition_candidate'}

def rates(fillers,repetitions,words,seconds):
    return {'fillers':fillers,'repetitions':repetitions,'words':words,
        'fillers_per_minute':round(fillers*60/seconds,3) if seconds>0 else None,
        'repetitions_per_minute':round(repetitions*60/seconds,3) if seconds>0 else None,
        'fillers_per_100_words':round(fillers*100/words,3) if words else None,
        'repetitions_per_100_words':round(repetitions*100/words,3) if words else None}

def candidates(store,sid):
    return [json.loads(e['payload_json']) for e in store.events(sid)
        if e['kind']=='speech.candidate' and json.loads(e['payload_json']).get('candidate_kind') in KINDS]

def validate_review(store,sid,payload):
    available={e['id'] for e in candidates(store,sid)}
    ids=[d['event_id'] for d in payload['decisions']]
    if len(set(ids))!=len(ids) or not set(ids)<=available:
        raise ValueError('Candidatos duplicados o ajenos a esta sesion')
    additions=payload['additions']
    if len({a['id'] for a in additions})!=len(additions):
        raise ValueError('Omisiones duplicadas')
    summary=json.loads(store.session(sid)['summary_json'])
    duration=summary.get('metrics',{}).get('captured_audio_seconds',0)
    if any(a['at_seconds']>duration for a in additions):
        raise ValueError('El tiempo de la omision excede el audio')
    if payload['complete'] and (set(ids)!=available or any(d['label']=='uncertain' for d in payload['decisions'])
            or not WORDS.findall(payload['corrected_transcript'] or '')):
        raise ValueError('Para completar: revisar todos los candidatos sin dudas y aportar la transcripcion corregida')
    if any(not a['token'].strip() for a in additions):
        raise ValueError('Escribe la expresion de cada omision')

def session_report(store,sid,reviewer='R001'):
    row=store.session(sid)
    summary=json.loads(row['summary_json']); m=summary.get('metrics',{})
    seconds=m.get('captured_audio_seconds',0)
    automatic=rates(m.get('filled_pause_candidate',0)+m.get('contextual_filler_candidate',0),
        m.get('repetition_candidate',0),m.get('words',0),seconds)
    review=store.evaluation(sid,reviewer)
    human=None
    if review:
        by_id={e['id']:e for e in candidates(store,sid)}
        accepted=[by_id[d['event_id']] for d in review['decisions']
            if d['label']=='confirmed' and d['event_id'] in by_id]
        fillers=sum(e['candidate_kind']!='repetition_candidate' for e in accepted)
        repetitions=len(accepted)-fillers
        fillers+=sum(e['kind']!='repetition_candidate' for e in review['additions'])
        repetitions+=sum(e['kind']=='repetition_candidate' for e in review['additions'])
        text=review['corrected_transcript']
        human=rates(fillers,repetitions,len(WORDS.findall(text)) if text is not None else None,seconds)
        tp=len(accepted); fp=sum(d['label']=='rejected' for d in review['decisions']); fn=len(review['additions'])
        human.update(complete=review['complete'],precision=tp/(tp+fp) if tp+fp else None,
            recall=tp/(tp+fn) if review['complete'] and tp+fn else None,
            denominator='human_corrected_transcript' if text is not None else 'unavailable')
    latencies=[]
    for event in store.events(sid):
        if event['device_confirmed_at']:
            try:
                delay=(datetime.fromisoformat(event['device_confirmed_at'])-datetime.fromisoformat(event['created_at'])).total_seconds()*1000
                if delay>=0: latencies.append(delay)
            except (ValueError,TypeError): pass
    latencies.sort()
    original=summary.get('original_frames',0); missing=summary.get('relay_missing_frames',0)
    pending=store.pending_count(sid)
    warnings=[]
    if row['status']!='ended': warnings.append('Sesion no finalizada normalmente')
    if row['demo'] or summary.get('device_simulated'): warnings.append('Sesion simulada')
    if seconds<=0 or not m.get('words'): warnings.append('Sin audio o sin transcripcion util')
    if not summary.get('audio_relay_complete'): warnings.append('Audio del relevo incompleto')
    if summary.get('provider_audio_complete') is not True: warnings.append('Envio completo a IA no verificado')
    if not summary.get('provider_finalization_confirmed'): warnings.append('Cierre de IA no confirmado')
    if pending: warnings.append('Eventos pendientes de confirmacion')
    return {'session':row,'seconds':seconds,'automatic':automatic,'review':review,'human':human,
        'survey':store.survey(sid),'eligible':not warnings,'warnings':warnings,
        'quality':{'missing_frames':missing,'loss_percent':round(missing*100/original,3) if original else None,
            'pending_events':pending,'provider_audio_complete':summary.get('provider_audio_complete'),
            'provider_finalization_confirmed':summary.get('provider_finalization_confirmed'),
            'mqtt_drops':summary.get('mqtt_internal_drops'),
            'device':summary.get('device_status_at_close',{}),
            'diagnostics':summary.get('device_diagnostics',{}),
            'ack_latency_samples':len(latencies),'ack_latency_median_ms':round(statistics.median(latencies),2) if latencies else None,
            'ack_latency_p95_ms':round(latencies[math.ceil(.95*len(latencies))-1],2) if latencies else None,
            'latency_definition':'Emision en laptop hasta eco del ESP; incluye reintentos. No es latencia desde el habla.'}}

def compare(store,pre_id,post_id,reviewer):
    pre=session_report(store,pre_id,reviewer); post=session_report(store,post_id,reviewer)
    if pre['session']['participant']!=post['session']['participant'] or pre['session']['phase']!='pre' or post['session']['phase']!='post':
        raise ValueError('Selecciona Antes y Despues del mismo participante')
    usable=pre['eligible'] and post['eligible']
    def changes(a,b):
        result={}
        for key in a:
            if key in ('complete','precision','recall','denominator'): continue
            x,y=a[key],b.get(key)
            result[key]={'before':x,'after':y,'delta':round(y-x,3) if x is not None and y is not None else None,
                'change_percent':round((y-x)*100/x,2) if x and y is not None else None}
        return result
    human_ready=usable and pre['human'] and post['human'] and pre['human']['complete'] and post['human']['complete']
    warnings=pre['warnings']+post['warnings']
    if pre['session']['feedback_enabled'] or post['session']['feedback_enabled']:
        warnings.append('Consejos activados en alguna medicion; no equivale a Antes/Despues sin ayuda')
    if not human_ready: warnings.append('Comparacion humana pendiente de revision completa o de integridad tecnica')
    rubric={}
    if usable and pre['review'] and post['review']:
        a,b=pre['review']['rubric'],post['review']['rubric']
        rubric={k:{'before':a[k],'after':b[k],'delta':b[k]-a[k]} for k in a if a[k] is not None and b[k] is not None}
    return {'pre':pre,'post':post,'eligible':usable,'warnings':list(dict.fromkeys(warnings)),
        'automatic_changes':changes(pre['automatic'],post['automatic']) if usable else None,
        'human_changes':changes(pre['human'],post['human']) if human_ready else None,'rubric_changes':rubric,
        'interpretation':'Cambios descriptivos por participante; no prueban causalidad. Candidatos automaticos no son fallos confirmados.'}

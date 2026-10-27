import io
import json
import wave
import zipfile
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from app.storage import Store
from app.main import create_app, Evaluation
from app.evaluation import rates, compare, session_report, validate_review


def seed(store,sid,phase,participant='P01',fillers=2,words=100,seconds=60,complete=True):
    store.create(sid,participant,phase,False,False)
    summary={'metrics':{'words':words,'filled_pause_candidate':fillers,'contextual_filler_candidate':0,
        'repetition_candidate':1,'captured_audio_seconds':seconds},'original_frames':3000,
        'relay_missing_frames':0 if complete else 10,'audio_relay_complete':complete,
        'provider_audio_complete':complete,'provider_finalization_confirmed':True,'mqtt_internal_drops':0}
    store.update(sid,status='ended',summary_json=json.dumps(summary))
    for i in range(fillers+1):
        event={'id':sid+str(i),'sid':sid,'kind':'speech.candidate','at':'2026-10-17T10:00:00+00:00',
            'candidate_kind':'filled_pause_candidate' if i<fillers else 'repetition_candidate','token':'eh','char_start':i}
        store.event(event)
        store.db.execute('UPDATE events SET device_confirmed_at=? WHERE id=?',('2026-10-17T10:00:00.200+00:00',event['id']))
    store.db.commit()


@pytest.fixture
def store(tmp_path):
    value=Store(tmp_path)
    seed(value,'aaaaaaaa','pre')
    seed(value,'bbbbbbbb','post',fillers=0,words=50,seconds=30)
    yield value
    value.close()


def payload(store,sid,reviewer='R001'):
    return Evaluation(reviewer=reviewer,complete=True,corrected_transcript='uno dos tres cuatro cinco seis siete ocho nueve diez',
        decisions=[{'event_id':e['id'],'label':'confirmed'} for e in store.events(sid)],
        rubric={'clarity':3,'organization':4}).model_dump()


def test_rates_normalize_duration_and_words_without_zero_division():
    assert rates(2,1,100,60)['fillers_per_minute']==2
    assert rates(2,1,50,30)['fillers_per_minute']==4
    assert rates(2,1,50,30)['fillers_per_100_words']==4
    assert rates(0,0,0,0)['fillers_per_minute'] is None
    assert rates(1,0,None,10)['fillers_per_100_words'] is None


def test_human_review_revisions_and_missing_candidates_do_not_double_count(store):
    p=payload(store,'aaaaaaaa')
    p['decisions'][1]['label']='rejected'
    p['additions']=[{'id':'manual1','kind':'contextual_filler_candidate','token':'bueno','at_seconds':2}]
    validate_review(store,'aaaaaaaa',p)
    store.save_evaluation('aaaaaaaa',p);store.save_evaluation('aaaaaaaa',p)
    report=session_report(store,'aaaaaaaa')
    assert report['human']['fillers']==2 and report['human']['repetitions']==1
    assert report['human']['fillers_per_100_words']==20
    assert report['human']['precision']==pytest.approx(2/3)
    assert report['human']['recall']==pytest.approx(2/3)
    assert store.db.execute('select count(*) from evaluations').fetchone()[0]==1
    other=payload(store,'aaaaaaaa','R002');other['decisions'][0]['label']='rejected'
    store.save_evaluation('aaaaaaaa',other)
    assert session_report(store,'aaaaaaaa','R001')['human']['fillers']==2
    assert session_report(store,'aaaaaaaa','R002')['human']['fillers']==1


@pytest.mark.parametrize('mutation', ['foreign','duplicate','unreviewed','uncertain','empty_text','late_addition','duplicate_addition'])
def test_invalid_review_cannot_be_marked_complete(store,mutation):
    p=payload(store,'aaaaaaaa')
    if mutation=='foreign': p['decisions'][0]['event_id']='bbbbbbbb0'
    if mutation=='duplicate': p['decisions'].append(p['decisions'][0])
    if mutation=='unreviewed': p['decisions'].pop()
    if mutation=='uncertain': p['decisions'][0]['label']='uncertain'
    if mutation=='empty_text': p['corrected_transcript']='...'
    if mutation in ('late_addition','duplicate_addition'):
        a={'id':'same','kind':'filled_pause_candidate','token':'eh','at_seconds':61 if mutation=='late_addition' else 1}
        p['additions']=[a] if mutation=='late_addition' else [a,a]
    with pytest.raises(ValueError): validate_review(store,'aaaaaaaa',p)


def test_comparison_is_paired_and_separates_human_from_automatic(store):
    result=compare(store,'aaaaaaaa','bbbbbbbb','R001')
    assert result['eligible'] and result['human_changes'] is None
    assert result['automatic_changes']['fillers_per_minute']['delta']==-2
    assert result['automatic_changes']['fillers_per_100_words']['change_percent']==-100
    assert result['automatic_changes']['repetitions_per_minute']['change_percent']==100
    for sid in ['aaaaaaaa','bbbbbbbb']: store.save_evaluation(sid,payload(store,sid))
    result=compare(store,'aaaaaaaa','bbbbbbbb','R001')
    assert result['human_changes']['fillers']['delta']==-2
    assert result['rubric_changes']['clarity']['delta']==0
    with pytest.raises(ValueError): compare(store,'bbbbbbbb','aaaaaaaa','R001')
    seed(store,'cccccccc','post',participant='P02')
    with pytest.raises(ValueError): compare(store,'aaaaaaaa','cccccccc','R001')


def test_incomplete_empty_demo_and_pending_sessions_are_not_comparable(store):
    seed(store,'cccccccc','post',complete=False)
    assert compare(store,'aaaaaaaa','cccccccc','R001')['automatic_changes'] is None
    seed(store,'dddddddd','pre',seconds=0,words=0)
    assert not session_report(store,'dddddddd')['eligible']
    store.db.execute("UPDATE sessions SET demo=1 WHERE id='bbbbbbbb'");store.db.commit()
    assert not session_report(store,'bbbbbbbb')['eligible']
    store.db.execute("UPDATE events SET device_confirmed_at=NULL WHERE sid='aaaaaaaa'");store.db.commit()
    assert not session_report(store,'aaaaaaaa')['eligible']


def test_quality_latency_uses_confirmation_and_flags_feedback(store):
    report=session_report(store,'aaaaaaaa')
    assert report['quality']['ack_latency_median_ms']==200
    assert report['quality']['ack_latency_p95_ms']==200
    assert report['quality']['diagnostics']=={}
    store.db.execute("UPDATE sessions SET feedback_enabled=1 WHERE id='aaaaaaaa'");store.db.commit()
    assert any('Consejos' in w for w in compare(store,'aaaaaaaa','bbbbbbbb','R001')['warnings'])


def test_zero_baseline_has_no_invented_percentage(store):
    seed(store,'cccccccc','pre',fillers=0)
    result=compare(store,'cccccccc','bbbbbbbb','R001')
    assert result['automatic_changes']['fillers']['delta']==0
    assert result['automatic_changes']['fillers']['change_percent'] is None


def test_device_diagnostics_measure_session_deltas_and_observed_minima(store):
    from app.engine import Recording
    from app.config import Settings
    engine=SimpleNamespace(store=store,link=SimpleNamespace(dropped=0),settings=Settings(),
        device={'online':True,'short_writes':9})
    recording=Recording(engine,'aaaaaaaa',False,True)
    try:
        recording.observe_device({'online':True,'free_heap':40000,'short_writes':9})
        recording.observe_device({'online':False})
        recording.observe_device({'online':True,'free_heap':38000,'short_writes':10})
        recording.observe_device({'online':True,'short_writes':0})
        recording.observe_device({'online':True,'short_writes':2})
        assert recording.device_diagnostics=={'min_free_heap':38000,'min_wifi_rssi':None,
            'observed_disconnects':1,'short_writes_during_session':3}
    finally:
        recording.original.close();recording.relay.close();recording.raw_log.close()


def test_api_review_survey_audio_export_and_persistence(store):
    app=create_app();app.state.engine=SimpleNamespace(store=store)
    client=TestClient(app)
    auth={'Authorization':'Bearer '+app.state.settings.app_token}
    assert client.get('/api/sessions/aaaaaaaa/evaluation').status_code==401
    p=payload(store,'aaaaaaaa')
    assert client.put('/api/sessions/aaaaaaaa/evaluation',headers=auth,json=p).status_code==200
    assert client.get('/api/sessions/aaaaaaaa/evaluation',headers=auth).json()['human']['complete']
    invalid=dict(p,rubric={'clarity':6})
    assert client.put('/api/sessions/aaaaaaaa/evaluation',headers=auth,json=invalid).status_code==422
    assert client.put('/api/sessions/aaaaaaaa/survey',headers=auth,json={'usefulness':0,'distraction':2}).status_code==422
    survey={'usefulness':4,'distraction':2,'comment':'Útil'}
    assert client.put('/api/sessions/aaaaaaaa/survey',headers=auth,json=survey).status_code==200
    assert client.get('/api/sessions/aaaaaaaa/evaluation',headers=auth).json()['survey']==survey
    audio=store.directory/'aaaaaaaa'/'microfono_original.wav'
    with wave.open(str(audio),'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\0'*640)
    assert client.get('/api/sessions/aaaaaaaa/audio/microfono_original.wav').status_code==401
    assert client.get('/api/sessions/aaaaaaaa/audio/microfono_original.wav',headers=auth).content==audio.read_bytes()
    assert client.get('/api/sessions/aaaaaaaa/audio/secrets.h',headers=auth).status_code==404
    response=client.get('/api/sessions/aaaaaaaa/export',headers=auth)
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert json.loads(archive.read('evaluaciones.json'))[0]['reviewer']=='R001'
        assert json.loads(archive.read('encuesta.json'))==survey
        assert json.loads(archive.read('evaluacion_indicadores.json'))[0]['human']['fillers']==2
    assert client.post('/api/comparison',headers=auth,json={'pre':'aaaaaaaa','post':'bbbbbbbb'}).status_code==200
    store.update('aaaaaaaa',status='recording')
    assert client.put('/api/sessions/aaaaaaaa/evaluation',headers=auth,json=p).status_code==409
    store.update('aaaaaaaa',status='ended')
    # Reabrir conserva sesiones, revisiones y encuestas: migracion aditiva.
    second=Store(store.directory)
    assert second.evaluation('aaaaaaaa','R001')==p
    assert second.survey('aaaaaaaa')==survey
    assert len(second.sessions())==2
    second.close();client.close()

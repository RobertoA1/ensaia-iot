"""Opt-in: requiere el EMQX real desplegado por infra/emqx/compose.yaml."""
import json
import os
import time
from pathlib import Path
from tempfile import TemporaryDirectory
import pytest
from fastapi.testclient import TestClient
from dotenv import dotenv_values
from app.config import BASE,Settings
from app.main import create_app
from app.protocol import pack_audio
from laboratorio.config import Config
from laboratorio.client import run_id
from laboratorio.seguridad import verify_security
from laboratorio.verificar import verify

pytestmark=[pytest.mark.integration,pytest.mark.skipif(os.getenv('ORATORIA_TEST_EMQX')!='1',reason='EMQX real: activar ORATORIA_TEST_EMQX=1')]

@pytest.fixture(autouse=True)
def independent_mqtt_environment(monkeypatch):
    # app.config se importa durante coleccion y puede cargar el .env habitual.
    for key in list(os.environ):
        if key.startswith('MQTT_'):monkeypatch.delenv(key)

def test_emqx_pubsub_and_security(tmp_path):
    cfg=Config.load(BASE/'laboratorio/.env')
    report=verify(cfg,run_id(),10,tmp_path,True)
    assert report['passed'],json.dumps(report)
    security=verify_security(cfg,run_id())
    assert security['passed'],json.dumps(security)

def test_two_full_sessions_through_emqx_with_simulated_device(tmp_path):
    values=dotenv_values(BASE/'.env.emqx')
    settings=Settings(mqtt_host=values['MQTT_HOST'],mqtt_port=int(values['MQTT_PORT']),
        mqtt_user=values['MQTT_USER'],mqtt_password=values['MQTT_PASSWORD'],
        device_id=values['DEVICE_ID'],app_token='emqx-test-local-token-123456',api_key='',
        data_dir=tmp_path,builtin_broker=False,simulate_device=True)
    headers={'Authorization':'Bearer '+settings.app_token}
    sids=[]
    with TestClient(create_app(settings)) as client:
        for _ in range(60):
            if client.get('/api/status',headers=headers).json()['device_online']:break
            time.sleep(.05)
        assert client.get('/api/status',headers=headers).json()['device_online']
        for _ in range(2):
            response=client.post('/api/sessions',headers=headers,json={'participant':'EMQX_TEST','demo':True,'consent':True})
            assert response.status_code==200,response.text
            sid=response.json()['sid'];sids.append(sid)
            with client.websocket_connect('/ws/'+sid) as ws:
                ws.send_json({'token':settings.app_token});assert ws.receive_json()['type']=='ready'
                for seq in range(100):ws.send_bytes(pack_audio(sid,seq,seq*320,b'\1\1'*320))
                ws.send_json({'type':'stop','frames':100})
                while True:
                    packet=ws.receive_json()
                    if packet['type']=='ended':break
                summary=packet['summary']
                assert summary['audio_relay_complete'] and summary['relay_frames']==100
                assert summary['pending_device_events']==0
            assert client.get(f'/api/sessions/{sid}/audio/microfono_original.wav',headers=headers).status_code==200
        assert sids[0]!=sids[1]
        for sid in sids:
            detail=client.get('/api/sessions/'+sid,headers=headers).json()
            assert all(event['sid']==sid for event in detail['events'])

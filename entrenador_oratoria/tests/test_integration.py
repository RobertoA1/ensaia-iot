import asyncio
import base64
import io
import json
from pathlib import Path
import socket
import time
import wave
import zipfile
import pytest
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
from app.protocol import pack_audio

pytestmark=pytest.mark.integration

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0))
        return s.getsockname()[1]

def configuration(tmp_path):
    return Settings(app_token='local-test-token-not-a-secret',api_key='',mqtt_password='mqtt-test-password-123456',
        mqtt_port=port(),mqtt_bind='127.0.0.1',mqtt_host='127.0.0.1',simulate_device=True,
        data_dir=tmp_path,builtin_broker=True)

def wait_device(client,headers):
    for _ in range(60):
        if client.get('/api/status',headers=headers).json()['device_online']:
            return
        time.sleep(.05)
    raise TimeoutError('Nodo MQTT no conectado')

def test_phone_mqtt_device_ai_events_export_and_annotation(tmp_path):
    s=configuration(tmp_path)
    headers={'Authorization':'Bearer '+s.app_token}
    with TestClient(create_app(s)) as client:
        wait_device(client,headers)
        assert client.get('/api/sessions').status_code==401
        assert client.post('/api/sessions',headers=headers,json={'participant':'P01','consent':False,'demo':True}).status_code==422
        assert client.post('/api/sessions',headers=headers,json={'participant':'P01','consent':True,'demo':False}).status_code==409
        response=client.post('/api/sessions',headers=headers,json={'participant':'P01','phase':'pre','feedback':True,'consent':True,'demo':True})
        assert response.status_code==200,response.text
        sid=response.json()['sid']
        with client.websocket_connect('/ws/'+sid) as ws:
            ws.send_json({'token':s.app_token})
            assert ws.receive_json()['type']=='ready'
            # 100 tramas = 2 segundos de audio, circulan por dos clientes MQTT y un broker TCP real.
            for seq in range(100):
                ws.send_bytes(pack_audio(sid,seq,seq*320,b'\x01\x01'*320))
            ws.send_json({'type':'stop','frames':100})
            received=[]
            while True:
                p=ws.receive_json()
                received.append(p)
                if p['type']=='ended':
                    summary=p['summary']
                    break
        assert summary['original_frames']==100
        assert summary['relay_frames']==100
        assert summary['audio_relay_complete']
        assert summary['pending_device_events']==0
        assert summary['provider_finalization_confirmed']
        assert summary['demo'] and summary['device_simulated']
        events=[p['event'] for p in received if p['type']=='device_event']
        assert ''.join(e.get('text','') for e in events if e['kind']=='transcript.user').startswith('Buenos días, eh')
        assert any(e['kind']=='feedback.ai' for e in events)
        detail=client.get('/api/sessions/'+sid,headers=headers).json()
        candidate=next(e['id'] for e in detail['events'] if e['kind']=='speech.candidate')
        annotation={'reviewer':'R01','event_id':candidate,'label':'confirmed','note':'Verificado en audio de prueba'}
        assert client.post('/api/sessions/'+sid+'/annotations',headers=headers,json=annotation).status_code==200
        export=client.get('/api/sessions/'+sid+'/export',headers=headers)
        assert export.status_code==200
        with zipfile.ZipFile(io.BytesIO(export.content)) as z:
            for filename in ['microfono_original.wav','audio_via_esp8266.wav']:
                with wave.open(io.BytesIO(z.read(filename))) as audio:
                    assert audio.getframerate()==16000 and audio.getnframes()==32000
            assert z.read('transcripcion_estudiante.txt').decode().endswith('demostración. ')
            assert len(json.loads(z.read('revision_humana.json')))==1
            assert not any('.env' in x or 'password' in x or '.key' in x for x in z.namelist())

def test_second_socket_does_not_stop_owner_and_invalid_frames_interrupt(tmp_path):
    s=configuration(tmp_path)
    headers={'Authorization':'Bearer '+s.app_token}
    with TestClient(create_app(s)) as client:
        wait_device(client,headers)
        sid=client.post('/api/sessions',headers=headers,json={'participant':'P02','consent':True,'demo':True}).json()['sid']
        with client.websocket_connect('/ws/'+sid) as owner:
            owner.send_json({'token':s.app_token});assert owner.receive_json()['type']=='ready'
            with client.websocket_connect('/ws/'+sid) as second:
                second.send_json({'token':s.app_token})
                with pytest.raises(Exception):
                    second.receive_json()
            assert client.get('/api/sessions/'+sid,headers=headers).json()['session']['status']=='recording'
            owner.send_bytes(pack_audio(sid,5,0,b'\0'*640))
            while True:
                p=owner.receive_json()
                if p['type']=='error':
                    break
        deadline=time.monotonic()+5
        while True:
            row=client.get('/api/sessions/'+sid,headers=headers).json()['session']
            if row['status']!='closing' or time.monotonic()>deadline:
                break
            time.sleep(.05)
        assert row['status']=='interrupted'

def test_missing_relay_is_not_reported_as_complete(tmp_path):
    s=configuration(tmp_path)
    headers={'Authorization':'Bearer '+s.app_token}
    with TestClient(create_app(s)) as client:
        wait_device(client,headers)
        sid=client.post('/api/sessions',headers=headers,json={'participant':'P03','consent':True,'demo':True}).json()['sid']
        # El nodo queda conectado, pero ya no escucha audio: fallo controlado del relevo.
        sim_topic=s.root+'/down/audio'
        engine=client.app.state.engine
        original_publish=engine.link.publish
        def drop_audio(topic,payload,**kwargs):
            if topic!=sim_topic:
                return original_publish(topic,payload,**kwargs)
        engine.link.publish=drop_audio
        with client.websocket_connect('/ws/'+sid) as ws:
            ws.send_json({'token':s.app_token});assert ws.receive_json()['type']=='ready'
            ws.send_bytes(pack_audio(sid,0,0,b'\0'*640))
            ws.send_json({'type':'stop','frames':1})
            while True:
                p=ws.receive_json()
                if p['type']=='ended':
                    assert not p['summary']['audio_relay_complete']
                    assert p['summary']['relay_missing_frames']==1
                    break

def test_gpt_live_protocol_with_local_fake_provider(monkeypatch):
    import websockets
    from app.live import LiveConnection
    async def exercise():
        observed=[]
        async def handler(ws):
            start=json.loads(await ws.recv())
            assert start['type']=='session.start'
            assert start['session']['model']=='gpt-live-1'
            assert start['session']['audio']['format']['rate']==16000
            assert ws.request.headers['Authorization']=='Bearer fake-key-for-local-test'
            await ws.send(json.dumps({'type':'session.started','session':{'id':'fake-live'}}))
            audio=json.loads(await ws.recv())
            assert audio['type']=='session.input_audio.append'
            assert base64.b64decode(audio['audio'])==b'\0'*640
            await ws.send(json.dumps({'type':'session.input_transcript.delta','delta':'eh, hola ', 'start_ms':0,'end_ms':20}))
            close=json.loads(await ws.recv())
            assert close['type']=='session.close'
            await ws.send(json.dumps({'type':'session.closed','usage':{'seconds':1}}))
        real_connect=websockets.connect
        async with websockets.serve(handler,'127.0.0.1',0) as server:
            local_port=server.sockets[0].getsockname()[1]
            monkeypatch.setattr(websockets,'connect',lambda url,**kwargs: real_connect(f'ws://127.0.0.1:{local_port}',**kwargs))
            settings=Settings(api_key='fake-key-for-local-test')
            async def receive(e):observed.append(e)
            live=LiveConnection(settings,receive)
            await live.open()
            await live.audio(b'\0'*640)
            assert await live.close()
        assert any(e['type']=='session.input_transcript.delta' for e in observed)
    asyncio.run(exercise())

def test_provider_failure_during_close_still_saves_evidence(tmp_path):
    s=configuration(tmp_path)
    headers={'Authorization':'Bearer '+s.app_token}
    with TestClient(create_app(s)) as client:
        wait_device(client,headers)
        sid=client.post('/api/sessions',headers=headers,json={'participant':'P04','consent':True,'demo':True}).json()['sid']
        async def broken_close():
            raise ConnectionError('Corte simulado de la conexion de IA')
        client.app.state.engine.active.provider.close=broken_close
        with client.websocket_connect('/ws/'+sid) as ws:
            ws.send_json({'token':s.app_token});assert ws.receive_json()['type']=='ready'
            ws.send_bytes(pack_audio(sid,0,0,b'\0'*640))
            ws.send_json({'type':'stop','frames':1})
            while True:
                p=ws.receive_json()
                if p['type']=='ended':
                    assert not p['summary']['provider_finalization_confirmed']
                    break
        assert client.get('/api/sessions/'+sid+'/export',headers=headers).status_code==200

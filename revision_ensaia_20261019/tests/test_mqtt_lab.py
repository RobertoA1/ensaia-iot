import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from types import SimpleNamespace
import pytest
from app.config import Settings
from app.mqtt import MQTTLink,start_broker
from laboratorio.config import Config
from laboratorio.client import Client,message,run_id
from laboratorio.verificar import verify

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));return sock.getsockname()[1]

def test_lab_config_is_independent_and_secret_repr_safe(tmp_path,monkeypatch):
    for k in list(os.environ):
        if k.startswith('MQTT_'):monkeypatch.delenv(k)
    path=tmp_path/'lab.env'
    path.write_text('MQTT_USER=lab\nMQTT_PASSWORD=secret-test-123456\nMQTT_PORT=1884\n',encoding='utf-8')
    cfg=Config.load(path)
    assert cfg.port==1884 and cfg.qos==0
    assert cfg.password not in repr(cfg)
    for bad in [replace(cfg,topic='oratoria/v1/real/up/audio'),replace(cfg,topic='laboratorio/oratoria/#'),
                replace(cfg,host='mqtt://user:password@host'),replace(cfg,port=0),replace(cfg,qos=3),replace(cfg,timeout=float('nan'))]:
        with pytest.raises(ValueError):bad.validate()
    with pytest.raises(ValueError):run_id('../../secrets')

def test_settings_read_environment_when_created_and_validate(monkeypatch):
    monkeypatch.setenv('MQTT_PORT','1884');assert Settings().mqtt_port==1884
    monkeypatch.setenv('MQTT_PORT','1885');assert Settings().mqtt_port==1885
    monkeypatch.setenv('MQTT_PORT','bad')
    with pytest.raises(ValueError,match='MQTT_PORT'):Settings()
    with pytest.raises(ValueError,match='MQTT_HOST'):
        Settings(mqtt_host='mqtt://user:secret@host',mqtt_port=1884).validate()

def test_private_bootstrap_preserves_existing_credentials_and_firmware(tmp_path):
    from tools.preparar_emqx import prepare
    from tools.configurar_nodo_emqx import configure
    source='MQTT_USER=oratoria\nMQTT_PASSWORD=existing-test-password\nDEVICE_ID=esp-test\nAPP_TOKEN=test-existing-token-123456\n'
    (tmp_path/'.env').write_text(source)
    firmware=tmp_path/'firmware/EntrenadorESP8266';firmware.mkdir(parents=True)
    original=(Path('firmware/EntrenadorESP8266/secrets.example.h')).read_text()
    (firmware/'secrets.h').write_text(original)
    assert prepare(tmp_path)==1884
    state=(tmp_path/'infra/emqx/private/credentials.json').read_text()
    assert (tmp_path/'.env').read_text()==source
    assert (firmware/'secrets.h').read_text()==original
    assert prepare(tmp_path)==1884
    assert (tmp_path/'infra/emqx/private/credentials.json').read_text()==state
    configure('192.168.1.55',tmp_path)
    updated=(firmware/'secrets.h').read_text()
    assert 'MQTT_PORT = 1884' in updated and '192.168.1.55' in updated
    assert 'TU_WIFI_2_4_GHZ' in updated and 'TU_CLAVE_WIFI' in updated
    assert (tmp_path/'infra/emqx/private/secrets.previous.h').read_text()==original

def test_explicit_config_loads_before_application_import(tmp_path):
    config=tmp_path/'custom.env';config.write_text('MQTT_PORT=1999\nBUILTIN_BROKER=false\nAPP_TOKEN=fixture-token\n')
    # Fake uvicorn prevents starting any server or using the real study database.
    code="""
import sys,types,runpy
def run(app,**kwargs):
    assert app.state.settings.mqtt_port==1999
    assert app.state.settings.builtin_broker is False
    assert app.state.settings.app_token=='fixture-token'
sys.modules['uvicorn']=types.SimpleNamespace(run=run)
sys.argv=['run.py','--localhost','--env-file',sys.argv[1]]
runpy.run_path('run.py',run_name='__main__')
"""
    result=subprocess.run([sys.executable,'-c',code,str(config)],capture_output=True,text=True)
    assert result.returncode==0,result.stderr

@pytest.mark.integration
def test_verifier_real_tcp_auth_and_topic_isolation(tmp_path):
    async def exercise():
        settings=Settings(mqtt_bind='127.0.0.1',mqtt_host='127.0.0.1',mqtt_port=free_port(),
            mqtt_user='lab',mqtt_password='test-mqtt-password-123456',data_dir=tmp_path)
        broker=await start_broker(settings)
        config=Config(port=settings.mqtt_port,user=settings.mqtt_user,password=settings.mqtt_password,timeout=3)
        try:
            report=await asyncio.to_thread(verify,config,'unit-wire',10,tmp_path,False)
            assert report['passed'],json.dumps(report)
            assert report['received']==10 and not report['missing'] and report['duplicates']==0
            rows=[json.loads(row) for row in (tmp_path/'unit-wire-wire.jsonl').read_text(encoding='utf-8').splitlines()]
            assert sum(row['type']=='received' for row in rows)==10
            assert config.password not in json.dumps(report)
        finally:await broker.shutdown()
    asyncio.run(exercise())

@pytest.mark.integration
def test_verifier_broker_off_is_failure_not_auth_rejection(tmp_path):
    cfg=Config(port=free_port(),user='lab',password='fixture',timeout=.3)
    result=verify(cfg,'offline',log_dir=tmp_path,security=True)
    assert not result['passed'] and result['errors'] and result['received']==0
    assert result['missing']==list(range(1,11))

@pytest.mark.integration
def test_external_mode_uses_existing_broker_without_starting_builtin(tmp_path,monkeypatch):
    import app.main as api_module
    from app.main import create_app
    async def exercise():
        config=Settings(mqtt_bind='127.0.0.1',mqtt_host='127.0.0.1',mqtt_port=free_port(),
            mqtt_user='lab',mqtt_password='test-mqtt-password-123456',app_token='test-token-at-least-20-chars',
            data_dir=tmp_path/'app',builtin_broker=False,simulate_device=True)
        config.data_dir.mkdir()
        broker=await start_broker(config)
        async def forbidden(*args):raise AssertionError('External mode started builtin broker')
        monkeypatch.setattr(api_module,'start_broker',forbidden)
        app=create_app(config)
        try:
            async with app.router.lifespan_context(app):
                for _ in range(40):
                    if app.state.engine.device_online:break
                    await asyncio.sleep(.05)
                assert app.state.engine.link.ready.is_set()
                assert app.state.engine.device_online
        finally:await broker.shutdown()
    asyncio.run(exercise())

@pytest.mark.integration
def test_clients_and_application_resubscribe_after_broker_restart(tmp_path):
    async def exercise():
        settings=Settings(mqtt_bind='127.0.0.1',mqtt_host='127.0.0.1',mqtt_port=free_port(),
            mqtt_user='lab',mqtt_password='test-mqtt-password-123456',data_dir=tmp_path)
        cfg=Config(port=settings.mqtt_port,user=settings.mqtt_user,password=settings.mqtt_password,timeout=4)
        got=[]
        async def receive(topic,payload):got.append(payload)
        link=MQTTLink(settings,'app-reconnect',[(cfg.topic,0)],receive)
        broker=await start_broker(settings);sub=Client(cfg,'recovery',subscribe=True);pub=Client(cfg,'recovery-pub')
        try:
            await link.start();await asyncio.to_thread(sub.start);await asyncio.to_thread(pub.start)
            await asyncio.to_thread(pub.publish,message('recovery',1))
            await asyncio.to_thread(sub.inbox.get,True,3)
            await broker.shutdown();broker=None
            for _ in range(60):
                if not link.connected and not sub.connected.is_set():break
                await asyncio.sleep(.05)
            assert not link.connected and not link.ready.is_set() and not sub.connected.is_set()
            broker=await start_broker(settings)
            deadline=time.monotonic()+12
            while time.monotonic()<deadline:
                if link.ready.is_set() and sub.ready.is_set() and pub.ready.is_set():break
                await asyncio.sleep(.05)
            assert link.ready.is_set() and sub.ready.is_set() and pub.ready.is_set()
            await asyncio.to_thread(pub.publish,message('recovery',2))
            row=await asyncio.to_thread(sub.inbox.get,True,3)
            assert json.loads(row['raw'])['secuencia']==2
            await asyncio.sleep(.2)
            assert sum(json.loads(p)['secuencia']==2 for p in got)==1
            assert link.disconnects>=1 and sub.disconnects>=1 and link.connections>=2
        finally:
            await asyncio.to_thread(sub.close);await asyncio.to_thread(pub.close);await link.close()
            if broker:await broker.shutdown()
    asyncio.run(exercise())

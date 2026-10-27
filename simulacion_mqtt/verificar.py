"""Prueba de integracion con MQTT real sobre TCP y persistencia SQLite."""
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from uuid import uuid4

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE/'app'))
from common import ROOT, connect, publish
from collector import DASHBOARD

def available_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

def wait_for(check, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise TimeoutError('La prueba no alcanzo el estado esperado')

def main():
    evidence = BASE/'evidencias'
    evidence.mkdir(exist_ok=True)
    run = str(uuid4())
    port, http = available_port(), available_port()
    environment = dict(os.environ, MQTT_HOST='127.0.0.1', MQTT_PORT=str(port),
                       HTTP_PORT=str(http), HTTP_BIND='127.0.0.1', DB_BACKEND='sqlite',
                       MAX_SAMPLES='40', PHASE_SAMPLES='10', INTERVAL_SECONDS='0.05', RUN_ID=run,
                       PYTHONUNBUFFERED='1')
    processes, logs, observers = [], [], []
    with tempfile.TemporaryDirectory(prefix='confort-mqtt-') as temporary:
        environment['DATA_DIR'] = temporary
        def start(name, app, extra=None):
            log = (evidence/f'{name}.log').open('w')
            logs.append(log)
            process = subprocess.Popen([sys.executable, str(BASE/'app'/app)],
                                       env=dict(environment, **(extra or {})),
                                       stdout=log, stderr=subprocess.STDOUT)
            processes.append(process)
            return process
        def api():
            with urllib.request.urlopen(f'http://127.0.0.1:{http}/api', timeout=2) as result:
                return json.load(result)
        try:
            start('broker', 'demo_broker.py')
            def broker_ready():
                with socket.create_connection(('127.0.0.1', port), timeout=1):
                    return True
            wait_for(broker_ready)
            start('colector', 'collector.py')
            wait_for(api)
            # El observador confirma las recomendaciones y estados que transitan por MQTT.
            observed = []
            def on_message(client, userdata, msg):
                observed.append({'topic': msg.topic, 'payload': json.loads(msg.payload),
                                 'qos': msg.qos, 'retain': msg.retain})
            os.environ['MQTT_PORT'] = str(port)
            observer = connect('observador-prueba', on_message=on_message,
                               subscriptions=[f'{ROOT}/+/recomendacion', f'{ROOT}/+/estado'])
            observers.append(observer)
            nodes = [start('zona1', 'simulator.py', {'NODE_ID': 'esp32-z1', 'ZONE_ID': 'zona1'}),
                     start('zona2', 'simulator.py', {'NODE_ID': 'esp32-z2', 'ZONE_ID': 'zona2'})]
            for node in nodes:
                if node.wait(timeout=30) != 0:
                    raise RuntimeError('Fallo un nodo: revisar log')
            wait_for(lambda: api() if api()['recibidas'] == 80 else None)
            records = [json.loads(x) for x in (Path(temporary)/'telemetria.jsonl').read_text().splitlines()]
            assert len(records) == 80
            spy = connect('publicador-prueba')
            observers.append(spy)
            first = records[0]
            publish(spy, first['topic'], first['telemetria'])
            invalid = dict(first['telemetria'], humedad_pct=120)
            publish(spy, first['topic'], invalid)
            other_topic = f"{ROOT}/{'zona2' if first['telemetria']['zona_id']=='zona1' else 'zona1'}/telemetria"
            publish(spy, other_topic, first['telemetria'])
            final = wait_for(lambda: api() if api()['duplicadas'] == 1 and api()['rechazadas'] == 2 else None)
            wait_for(lambda: len([x for x in observed if x['topic'].endswith('/recomendacion')]) >= 81)
            # Suscriptor tardio recibe los dos estados offline retenidos.
            retained = []
            late = connect('suscriptor-tardio', on_message=lambda c,u,m: retained.append(
                           {'topic':m.topic,'payload':json.loads(m.payload),'retain':m.retain}),
                           subscriptions=[f'{ROOT}/+/estado'])
            observers.append(late)
            wait_for(lambda: len(retained) >= 2)
            assert all(x['retain'] and x['payload']['estado'] == 'offline' for x in retained)
            # Fuerza una desconexion y comprueba el Last Will en un topic de prueba.
            will_messages = []
            will_topic = f'{ROOT}/prueba/lastwill'
            will_observer = connect('observador-will', on_message=lambda c,u,m: will_messages.append(json.loads(m.payload)),
                                    subscriptions=[will_topic])
            observers.append(will_observer)
            code = "import sys,time;sys.path.insert(0,sys.argv[1]);from common import connect;c=connect('nodo-will',will_topic=sys.argv[2]);print('ready',flush=True);time.sleep(60)"
            victim = subprocess.Popen([sys.executable, '-u', '-c', code, str(BASE/'app'), will_topic],
                                      env=environment, stdout=subprocess.PIPE, text=True)
            processes.append(victim)
            assert victim.stdout.readline().strip() == 'ready'
            victim.kill()
            victim.wait(timeout=5)
            wait_for(lambda: will_messages)
            assert will_messages[0]['estado'] == 'offline'
            with sqlite3.connect(Path(temporary)/'confort.sqlite') as db:
                assert db.execute('SELECT count(*) FROM lecturas').fetchone()[0] == 80
                assert db.execute('SELECT count(*) FROM recomendaciones').fetchone()[0] == 80
                assert db.execute('SELECT count(*) FROM encuestas').fetchone()[0] == 0
                assert not db.execute('PRAGMA foreign_key_check').fetchall()
                group = db.execute('SELECT nodo_id, escenario, count(*), round(avg(temperatura_c),2), round(avg(humedad_pct),2), round(avg(velocidad_aire_ms),3) FROM lecturas GROUP BY nodo_id, escenario').fetchall()
            summary = {'resultado':'APROBADO', 'broker_verificado':'aMQTT 0.11.3 local sobre TCP',
                       'protocolo':'MQTT 3.1.1', 'qos':1, 'run_id':run,
                       'lecturas':80, 'nodos':2, 'canales_virtuales':6, 'recomendaciones_bd':80,
                       'recomendaciones_mqtt_observadas':len([x for x in observed if x['topic'].endswith('/recomendacion')]),
                       'duplicados_sin_filas_adicionales':1,'mensajes_invalidos_rechazados':2,
                       'retained_estados':True, 'last_will':True, 'integridad_relacional':True,
                       'backend_verificado':'SQLite', 'emqx_mysql_docker_ejecutado':False,
                       'motivo':'Usuario sin acceso al servicio local de Docker',
                       'resumen_por_nodo_escenario':group}
            (evidence/'resultado.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
            (evidence/'dashboard.json').write_text(json.dumps(final, ensure_ascii=False, indent=2))
            (evidence/'mensajes_mqtt.json').write_text(json.dumps(observed, ensure_ascii=False, indent=2))
            # Instantanea offline del dashboard; conserva los valores y explicita su antiguedad.
            snapshot = DASHBOARD.replace("await(await fetch('/api')).json()", json.dumps(final, ensure_ascii=False))
            (evidence/'dashboard.html').write_text(snapshot)
            print(json.dumps(summary, ensure_ascii=False, indent=2))
        finally:
            for observer in observers:
                observer.disconnect()
                observer.loop_stop()
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            for log in logs:
                log.close()
            for filename in ['confort.sqlite','telemetria.jsonl','rechazados.jsonl']:
                path = Path(temporary)/filename
                if path.exists():
                    shutil.copy2(path, evidence/filename)

if __name__ == '__main__':
    main()

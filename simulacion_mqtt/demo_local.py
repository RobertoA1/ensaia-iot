"""Arranca una demostracion continua sin Docker. Ctrl+C detiene todos sus procesos."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--duration', type=float, default=0, help='Segundos; 0 = hasta Ctrl+C')
    args = parser.parse_args()
    base = Path(__file__).resolve().parent
    directory = base/'data/demo_local'
    directory.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, MQTT_HOST='127.0.0.1', MQTT_PORT=os.getenv('MQTT_PORT','18883'),
               HTTP_BIND='127.0.0.1', HTTP_PORT=os.getenv('HTTP_PORT','8090'),
               DB_BACKEND='sqlite', DATA_DIR=str(directory), MAX_SAMPLES='0', PYTHONUNBUFFERED='1')
    children, logs = [], []
    stop = False
    def stop_all(*args):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGINT, stop_all)
    signal.signal(signal.SIGTERM, stop_all)
    def start(name, app, extra=None):
        output = (directory/f'{name}.log').open('w')
        logs.append(output)
        process = subprocess.Popen([sys.executable, str(base/'app'/app)],
                                   env=dict(env, **(extra or {})), stdout=output, stderr=subprocess.STDOUT)
        children.append(process)
        return process
    try:
        start('broker','demo_broker.py')
        time.sleep(1)
        start('colector','collector.py')
        deadline = time.monotonic()+35
        while time.monotonic() < deadline:
            if any(p.poll() is not None for p in children):
                raise RuntimeError('Fallo un servicio; revisar logs en data/demo_local')
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{env['HTTP_PORT']}/health",timeout=1).close()
                break
            except OSError:
                time.sleep(0.2)
        else:
            raise TimeoutError('No inicio el colector')
        start('zona1','simulator.py', {'NODE_ID':'esp32-z1','ZONE_ID':'zona1'})
        start('zona2','simulator.py', {'NODE_ID':'esp32-z2','ZONE_ID':'zona2'})
        print(f"Dashboard: http://127.0.0.1:{env['HTTP_PORT']} | MQTT: {env['MQTT_PORT']}",flush=True)
        print('Datos sinteticos. Ctrl+C para detener.',flush=True)
        began = time.monotonic()
        while not stop and (args.duration == 0 or time.monotonic()-began < args.duration):
            if any(p.poll() is not None for p in children):
                raise RuntimeError('Un servicio termino inesperadamente; revisar logs')
            time.sleep(0.2)
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        for output in logs:
            output.close()

if __name__ == '__main__':
    main()

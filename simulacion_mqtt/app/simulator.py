import os
import random
import signal
import time
from uuid import uuid4
from common import ROOT, NODES, connect, now, publish

SCENARIOS = [('frio', 20.5, 55, 0.10, 0, 8),
             ('confort', 24.5, 58, 0.25, 1, 16),
             ('calor', 29.5, 74, 0.12, 0, 28),
             ('ventilado', 28.0, 68, 0.85, 3, 28)]

def main():
    node = os.getenv('NODE_ID', 'esp32-z1')
    zone = os.getenv('ZONE_ID', NODES.get(node, ''))
    if NODES.get(node) != zone:
        raise ValueError('NODE_ID/ZONE_ID no corresponden')
    interval = float(os.getenv('INTERVAL_SECONDS', '5'))
    phase = int(os.getenv('PHASE_SAMPLES', '12'))
    maximum = int(os.getenv('MAX_SAMPLES', '0'))
    if interval <= 0 or phase < 1 or maximum < 0:
        raise ValueError('Intervalo/fase/cantidad invalidos')
    rng = random.Random(2026 if zone == 'zona1' else 2027)
    run = os.getenv('RUN_ID') or str(uuid4())
    status = f'{ROOT}/{zone}/estado'
    client = connect(node, will_topic=status)
    stopped = False
    def stop(*args):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    publish(client, status, {'estado': 'online', 'nodo_id': node, 'simulado': True}, True)
    seq = 0
    try:
        while not stopped and (maximum == 0 or seq < maximum):
            name, t, h, air, fan, people = SCENARIOS[(seq // phase) % 4]
            p = {'schema_version': 1, 'mensaje_id': f'{run}/{node}/{seq}',
                 'run_id': run, 'secuencia': seq, 'nodo_id': node, 'zona_id': zone,
                 'aula_id': 'aula-posgrado-01', 'instante_utc': now(),
                 'temperatura_c': round(t + (0.8 if zone == 'zona2' else 0) + rng.uniform(-0.25, 0.25), 2),
                 'humedad_pct': round(h + (2 if zone == 'zona2' else 0) + rng.uniform(-1, 1), 2),
                 'velocidad_aire_ms': round(max(0, air - (0.08 if zone == 'zona2' else 0) + rng.uniform(-0.02, 0.02)), 3),
                 'escenario': name, 'nivel_ventilador_simulado': fan,
                 'ocupantes_simulados': people, 'simulado': True}
            publish(client, f'{ROOT}/{zone}/telemetria', p)
            print('PUBLICADO ' + str(p), flush=True)
            seq += 1
            time.sleep(interval)
    finally:
        publish(client, status, {'estado': 'offline', 'nodo_id': node, 'simulado': True}, True)
        client.disconnect()
        client.loop_stop()

if __name__ == '__main__':
    main()

import json
import math
import os
import threading
from datetime import datetime, timezone
import paho.mqtt.client as mqtt

ROOT = 'unt/posgrado/aula01'
NODES = {'esp32-z1': 'zona1', 'esp32-z2': 'zona2'}

def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')

def connect(client_id, on_message=None, subscriptions=(), will_topic=None):
    ready = threading.Event()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id,
                         protocol=mqtt.MQTTv311)
    if os.getenv('MQTT_USER'):
        client.username_pw_set(os.environ['MQTT_USER'], os.getenv('MQTT_PASSWORD'))
    if will_topic:
        client.will_set(will_topic, json.dumps({'estado': 'offline', 'simulado': True}),
                        qos=1, retain=True)
    def on_connect(c, userdata, flags, reason, properties):
        if reason.is_failure:
            return
        if subscriptions:
            c.subscribe([(topic, 1) for topic in subscriptions])
        else:
            ready.set()
    def on_subscribe(c, userdata, mid, reasons, properties):
        if all(not reason.is_failure for reason in reasons):
            ready.set()
    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_message = on_message
    client.reconnect_delay_set(1, 10)
    client.connect_async(os.getenv('MQTT_HOST', '127.0.0.1'),
                         int(os.getenv('MQTT_PORT', '1883')), 20)
    client.loop_start()
    if not ready.wait(30):
        client.loop_stop()
        raise TimeoutError('No fue posible conectar/suscribir al broker MQTT')
    return client

def publish(client, topic, payload, retain=False):
    info = client.publish(topic, json.dumps(payload, ensure_ascii=False), qos=1,
                          retain=retain)
    info.wait_for_publish(timeout=10)
    if not info.is_published():
        raise TimeoutError('Publicacion MQTT sin confirmacion')

def validate(topic, p):
    if not isinstance(p, dict) or p.get('schema_version') != 1 or p.get('simulado') is not True:
        raise ValueError('Formato/version/simulado incorrecto')
    node = p.get('nodo_id')
    if node not in NODES or p.get('zona_id') != NODES[node] or p.get('aula_id') != 'aula-posgrado-01':
        raise ValueError('Nodo, zona o aula no registrados')
    if topic != f'{ROOT}/{NODES[node]}/telemetria':
        raise ValueError('El topic no corresponde a la zona declarada')
    for key, low, high in [('temperatura_c', -10, 60), ('humedad_pct', 0, 100),
                           ('velocidad_aire_ms', 0, 10)]:
        v = p.get(key)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not low <= v <= high:
            raise ValueError(f'{key} fuera del dominio de simulacion')
    for key, low, high in [('secuencia', 0, 2**31-1), ('nivel_ventilador_simulado', 0, 3),
                           ('ocupantes_simulados', 0, 200)]:
        if type(p.get(key)) is not int or not low <= p[key] <= high:
            raise ValueError(f'{key} invalido')
    from uuid import UUID
    UUID(p['run_id'])
    if p.get('mensaje_id') != f"{p['run_id']}/{node}/{p['secuencia']}":
        raise ValueError('Identificador de mensaje inconsistente')
    stamp = datetime.fromisoformat(p['instante_utc'])
    if stamp.tzinfo is None:
        raise ValueError('Fecha sin zona horaria')
    if p.get('escenario') not in ['frio', 'confort', 'calor', 'ventilado']:
        raise ValueError('Escenario desconocido')

def recommend(p):
    # Umbrales arbitrarios de demostracion; no son un modelo ML ni una norma de confort.
    t, h, v = p['temperatura_c'], p['humedad_pct'], p['velocidad_aire_ms']
    if t < 22:
        label, level, reason = 'frio', 0, 'Temperatura menor que 22 C'
    elif t >= 28 and v < 0.5:
        label, level, reason = 'calor', 3, 'Temperatura >= 28 C y poco movimiento de aire'
    elif t >= 26 and v < 0.35:
        label, level, reason = 'calor', 2, 'Temperatura >= 26 C y aire < 0.35 m/s'
    elif h >= 70 and v < 0.3:
        label, level, reason = 'calor', 1, 'Humedad >= 70% y aire < 0.30 m/s'
    else:
        label, level, reason = 'confort', 1, 'Condiciones dentro de la regla de demostracion'
    return {'mensaje_id': p['mensaje_id'], 'zona_id': p['zona_id'],
            'confort_estimado': label, 'nivel_sugerido': level,
            'origen': 'reglas_demo_v1', 'motivo': reason, 'simulado': True,
            'instante_utc': now()}

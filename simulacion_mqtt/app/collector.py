import json
import os
import queue
import signal
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from common import ROOT, connect, recommend, validate
from storage import Storage

DASHBOARD = '''<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confort térmico | MQTT</title><style>
body{font:17px system-ui;background:#eff5f7;color:#163446;margin:0;padding:32px}
main{max-width:1040px;margin:auto}h1{font-size:34px}small{color:#526777}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}
article{background:white;padding:25px;border-radius:15px;border-top:5px solid #008579}
.big{font-size:32px;font-weight:700}.tag{background:#d9eee8;padding:7px;border-radius:7px}
td,th{padding:10px;text-align:left}table{width:100%}.note{background:#fff1d8;padding:16px;border-radius:9px}
</style><main><small>UNT · POSGRADO · AVANCE DE VIRTUALIZACIÓN</small>
<h1>Confort térmico del aula</h1><p>Dos nodos virtuales conectados mediante MQTT.</p>
<p class="note">Datos sintéticos. Reglas de demostración; el modelo de Machine Learning aún requiere entrenamiento con encuestas reales.</p>
<p id="count">Conectando…</p><div class="grid" id="zones"></div>
<p>Velocidades sugeridas: 0 apagado · 1 baja · 2 media · 3 alta.</p>
<p>Un ventilador con niveles recircula el aire. Esta simulación no mide renovación de aire ni CO₂.</p>
</main><script>
async function refresh(){try{let s=await(await fetch('/api')).json();
document.getElementById('count').textContent=`Lecturas guardadas en esta ejecución: ${s.recibidas} · Duplicados: ${s.duplicadas} · Rechazadas: ${s.rechazadas}`;
document.getElementById('zones').innerHTML=['zona1','zona2'].map(z=>{let p=s.zonas[z];if(!p)return `<article><h2>${z}</h2>Esperando telemetría</article>`;
let age=(Date.now()-Date.parse(p.instante_utc))/1000;
return `<article><h2>${z==='zona1'?'Zona 1 · cerca del ventilador':'Zona 2 · lejos del ventilador'}</h2>
<p class="big">${p.temperatura_c.toFixed(2)} °C</p><table><tr><td>Humedad relativa</td><td>${p.humedad_pct.toFixed(2)} %</td></tr>
<tr><td>Velocidad del aire</td><td>${p.velocidad_aire_ms.toFixed(3)} m/s</td></tr>
<tr><td>Escenario simulado</td><td>${p.escenario}</td></tr><tr><td>Nivel usado en escenario</td><td>${p.nivel_ventilador_simulado}</td></tr></table>
<p class="tag">${age>20?'Datos antiguos: recomendación suspendida':`Estimación: ${p.recomendacion.confort_estimado} · Nivel sugerido: ${p.recomendacion.nivel_sugerido}`}</p>
<small>${p.nodo_id} · ${p.instante_utc}</small></article>`}).join('');}catch(e){document.getElementById('count').textContent='Sin conexión con el colector';}}
refresh();setInterval(refresh,1500)</script></html>'''

def main():
    directory = Path(os.getenv('DATA_DIR', 'data'))
    directory.mkdir(parents=True, exist_ok=True)
    storage = Storage(directory)
    inbox = queue.Queue()
    lock = threading.Lock()
    state = {'recibidas': 0, 'duplicadas': 0, 'rechazadas': 0, 'zonas': {}}
    ready = threading.Event()
    stopped = threading.Event()
    def receive(client, userdata, msg):
        inbox.put((msg.topic, bytes(msg.payload)))
    client = connect('colector-confort', on_message=receive,
                     subscriptions=[f'{ROOT}/+/telemetria'])
    ready.set()
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/health':
                code, kind, body = (200 if ready.is_set() and client.is_connected() else 503), 'text/plain', b'collector'
            elif self.path == '/api':
                with lock:
                    body = json.dumps(state, ensure_ascii=False).encode()
                code, kind = 200, 'application/json'
            elif self.path == '/':
                code, kind, body = 200, 'text/html', DASHBOARD.encode()
            else:
                code, kind, body = 404, 'text/plain', b'Not found'
            self.send_response(code)
            self.send_header('Content-Type', kind + '; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer((os.getenv('HTTP_BIND', '0.0.0.0'), int(os.getenv('HTTP_PORT', '8090'))), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for sig in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(sig, lambda *args: stopped.set())
    print('LISTO: MQTT suscrito y dashboard disponible', flush=True)
    try:
        with (directory/'telemetria.jsonl').open('a', encoding='utf-8') as raw, (directory/'rechazados.jsonl').open('a', encoding='utf-8') as rejected:
            while not stopped.is_set():
                try:
                    topic, data = inbox.get(timeout=0.2)
                except queue.Empty:
                    continue
                try:
                    p = json.loads(data)
                    validate(topic, p)
                except (ValueError, KeyError, TypeError, OverflowError) as error:
                    with lock:
                        state['rechazadas'] += 1
                    rejected.write(json.dumps({'topic': topic, 'error': str(error)}, ensure_ascii=False)+'\n')
                    rejected.flush()
                    print('RECHAZADO: ' + str(error), flush=True)
                    continue
                r = recommend(p)
                if not storage.save(p, r):
                    with lock:
                        state['duplicadas'] += 1
                    # QoS 1 permite reentrega: vuelve a publicar la recomendacion sin duplicar la fila.
                    client.publish(f"{ROOT}/{p['zona_id']}/recomendacion", json.dumps(r), qos=1)
                    continue
                raw.write(json.dumps({'topic': topic, 'telemetria': p, 'recomendacion': r}, ensure_ascii=False)+'\n')
                raw.flush()
                with lock:
                    state['recibidas'] += 1
                    state['zonas'][p['zona_id']] = dict(p, recomendacion=r)
                # Publicar desde el hilo de trabajo permite al hilo MQTT gestionar la confirmacion.
                info = client.publish(f"{ROOT}/{p['zona_id']}/recomendacion", json.dumps(r), qos=1)
                info.wait_for_publish(timeout=10)
                if not info.is_published():
                    raise TimeoutError('Recomendacion sin confirmacion MQTT')
                print(f"RECIBIDO {p['zona_id']} #{p['secuencia']} -> {r['confort_estimado']} / nivel {r['nivel_sugerido']}", flush=True)
    finally:
        ready.clear()
        server.shutdown()
        client.disconnect()
        client.loop_stop()
        storage.close()

if __name__ == '__main__':
    main()

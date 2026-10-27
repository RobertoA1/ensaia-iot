"""Usa el INMP441 por MQTT como entrada del servidor ENSAIA existente.

No modifica el servidor ni consulta a la IA directamente. El servidor sigue
siendo responsable de la clave API, el relevo, las metricas y la persistencia.
"""
import argparse
import asyncio
import contextlib
import json
from pathlib import Path
import re
import ssl
import struct
import sys
import time
from types import SimpleNamespace
from urllib.parse import urlsplit
import uuid

import httpx
from dotenv import dotenv_values
import websockets

HEADER = struct.Struct('<8sII')


def inspect_packet(packet):
    if len(packet) != 656:
        raise ValueError('El ESP32 debe enviar 320 muestras y una cabecera de 16 bytes')
    sid, seq, offset = HEADER.unpack_from(packet)
    sid = sid.decode('ascii')
    if not re.fullmatch('[a-f0-9]{8}', sid) or offset != seq * 320:
        raise ValueError('Cabecera de microfono invalida')
    return sid, seq


class MicrophoneBridge:
    def __init__(self, settings, link_factory):
        self.root = f'oratoria/v1/{settings.device_id}'
        self.sid = None
        self.audio = asyncio.Queue(maxsize=250)  # cinco segundos; nunca omitir audio en silencio
        self.commands = {}
        self.failure = asyncio.Event()
        self.error = ''
        self.received = 0
        self.forwarded = 0
        self.expected_frames = None
        self.device = {}
        self.device_at = 0
        self.link = link_factory(settings, 's3-mic-bridge-' + uuid.uuid4().hex[:8], [
            (self.root + '/up/mic_audio', 0),
            (self.root + '/up/mic_control', 0),
            (self.root + '/up/status', 0),
        ], self.receive)

    def fail(self, message):
        if not self.failure.is_set():
            self.error = message
            self.failure.set()

    async def receive(self, topic, data):
        try:
            if topic.endswith('/status'):
                self.device = json.loads(data)
                self.device_at = time.monotonic()
            elif topic.endswith('/mic_control'):
                event = json.loads(data)
                if event.get('op') == 'mic_error' and event.get('sid') == self.sid:
                    self.fail('El microfono interrumpio la captura: ' + str(event.get('error')))
                pending = self.commands.get(event.get('id'))
                if pending and not pending.done():
                    pending.set_result(event)
            elif topic.endswith('/mic_audio') and self.sid and not self.failure.is_set():
                sid, seq = inspect_packet(data)
                if sid != self.sid:
                    return
                if seq != self.received:
                    raise ValueError(f'Perdida o duplicacion de audio: esperaba {self.received}, recibio {seq}')
                self.audio.put_nowait(data)
                self.received += 1
        except (ValueError, UnicodeError, asyncio.QueueFull) as exc:
            self.fail('Audio MQTT incompleto o cola saturada: ' + type(exc).__name__ + ' ' + str(exc))

    async def command(self, op, timeout=7):
        event = {'id': uuid.uuid4().hex, 'sid': self.sid, 'op': op}
        future = asyncio.get_running_loop().create_future()
        self.commands[event['id']] = future
        try:
            for attempt in range(3):
                self.link.publish(self.root + '/down/mic_control', event, qos=0)
                try:
                    answer = await asyncio.wait_for(asyncio.shield(future), timeout / 3)
                    if answer.get('sid') != self.sid or answer.get('op') != op:
                        raise RuntimeError('Confirmacion MQTT de otra sesion u operacion')
                    if not answer.get('ok'):
                        raise RuntimeError('ESP32 rechazo la orden: ' + str(answer.get('error')))
                    return answer
                except TimeoutError:
                    if attempt == 2:
                        raise RuntimeError('El ESP32 no confirmo ' + op) from None
        finally:
            self.commands.pop(event['id'], None)

    async def forward(self, socket):
        try:
            while True:
                packet = await self.audio.get()
                try:
                    await asyncio.wait_for(socket.send(packet), 3)
                    self.forwarded += 1
                finally:
                    self.audio.task_done()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.fail('No se pudo entregar audio al servidor: ' + type(exc).__name__)

    async def observe(self):
        while True:
            await asyncio.sleep(.25)
            if not self.link.connected or self.link.dropped:
                self.fail('Conexion MQTT interrumpida o mensajes descartados')
                return
            if time.monotonic() - self.device_at > 8 or not self.device.get('online'):
                self.fail('El ESP32 dejo de enviar estado')
                return

    async def drain(self, expected, timeout=7):
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            raise ValueError('Numero de tramas final invalido')
        deadline = time.monotonic() + timeout
        while self.forwarded < expected and time.monotonic() < deadline:
            if self.failure.is_set():
                raise RuntimeError(self.error)
            await asyncio.sleep(.02)
        if self.received != expected or self.forwarded != expected:
            raise RuntimeError(f'Audio incompleto: capturadas={expected}, recibidas={self.received}, enviadas={self.forwarded}')


async def read_server(socket, ended, bridge):
    try:
        async for raw in socket:
            message = json.loads(raw)
            kind = message.get('type')
            if kind == 'device_event':
                event = message['event']
                if event.get('kind') == 'transcript.user':
                    print(event.get('text', ''), end='', flush=True)
                elif event.get('kind') == 'feedback.ai' and event.get('visible'):
                    print('\n[CONSEJO IA] ' + event.get('text', ''), flush=True)
            elif kind == 'warning':
                print('\n[AVISO] ' + message.get('text', ''), flush=True)
            elif kind == 'error':
                bridge.fail('Servidor: ' + message.get('text', 'error'))
            elif kind == 'ended':
                if not ended.done():
                    ended.set_result(message['summary'])
                return
        if not ended.done():
            bridge.fail('El servidor cerro la conexion antes de confirmar el guardado')
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        bridge.fail('Conexion de servidor interrumpida: ' + type(exc).__name__)


async def record(bridge, url, token, request, seconds, tls=None):
    url = url.rstrip('/')
    headers = {'Authorization': 'Bearer ' + token}
    sid = None
    tasks = []
    normal_end = False
    mic_stopped = False
    async with httpx.AsyncClient(headers=headers, verify=tls or True, timeout=45, trust_env=False) as http:
        response = await http.get(url + '/api/status')
        response.raise_for_status()
        status = response.json()
        if not status.get('device_online') or not status.get('mqtt_connected'):
            raise RuntimeError('El servidor no detecta la placa. Revisa MQTT y DEVICE_ID')
        if status.get('device', {}).get('firmware') != 'ensaia-s3-i2s-v1':
            raise RuntimeError('El servidor detecta otro firmware. Apaga el ESP8266/nodo virtual y conecta el S3')
        if status.get('active_sid'):
            raise RuntimeError('Ya existe una sesion activa. Finalizala antes de iniciar otra')
        if seconds >= status.get('max_seconds', 300) - 10:
            raise ValueError('La duracion debe ser al menos 10 s menor que MAX_SESSION_SECONDS del servidor')
        response = await http.post(url + '/api/sessions', json=request)
        response.raise_for_status()
        sid = response.json()['sid']
        bridge.sid = sid
        print(f'Sesion {sid}; participante {request["participant"]}; fase {request["phase"]}', flush=True)
        ws_url = ('wss' if url.startswith('https:') else 'ws') + url[url.index(':'):] + '/ws/' + sid
        ws_options = {'ssl': tls or ssl.create_default_context()} if ws_url.startswith('wss:') else {}
        try:
            async with websockets.connect(ws_url, max_size=131072, close_timeout=5, **ws_options) as socket:
                await socket.send(json.dumps({'token': token}))
                ready = json.loads(await asyncio.wait_for(socket.recv(), 8))
                if ready.get('type') != 'ready':
                    raise RuntimeError('El servidor no autorizo la entrada del microfono')
                ended = asyncio.get_running_loop().create_future()
                tasks = [asyncio.create_task(bridge.forward(socket)),
                         asyncio.create_task(read_server(socket, ended, bridge)),
                         asyncio.create_task(bridge.observe())]
                await bridge.command('mic_start')
                print(f'GRABANDO {seconds:g} s desde INMP441. Habla ahora. Ctrl+C finaliza y guarda.', flush=True)
                timer = asyncio.create_task(asyncio.sleep(seconds))
                failed = asyncio.create_task(bridge.failure.wait())
                tasks.extend([timer, failed])
                try:
                    await asyncio.wait([timer, failed, ended], return_when=asyncio.FIRST_COMPLETED)
                except asyncio.CancelledError:
                    # Primer Ctrl+C: guardar; un segundo Ctrl+C puede forzar la salida.
                    print('\nFinalizando y guardando...', flush=True)
                if bridge.failure.is_set():
                    raise RuntimeError(bridge.error)
                if not ended.done():
                    acknowledgement = await bridge.command('mic_stop')
                    mic_stopped = True
                    bridge.expected_frames = acknowledgement['frames']
                    await bridge.drain(acknowledgement['frames'])
                    await socket.send(json.dumps({'type': 'stop', 'frames': acknowledgement['frames']}))
                    await asyncio.wait_for(asyncio.shield(ended), 45)
                summary = ended.result()
                normal_end = True
                return sid, summary
        finally:
            if sid and not mic_stopped:
                with contextlib.suppress(Exception):
                    await bridge.command('mic_stop', timeout=3)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if sid and not normal_end:
                # El cierre WSS hace que ENSAIA marque la toma como interrumpida.
                # Si no se pudo abrir WSS, este endpoint libera la sesion inicializada.
                with contextlib.suppress(Exception):
                    detail = await http.get(url + '/api/sessions/' + sid)
                    if detail.json()['session']['status'] in ('starting', 'recording'):
                        await http.post(url + '/api/sessions/' + sid + '/stop')


def settings_from_file(project, env_path):
    if not (project / 'app/mqtt.py').is_file():
        raise ValueError('--proyecto debe apuntar a la carpeta ENSAIA que contiene app/ y run.py')
    if not env_path.is_file():
        raise ValueError('No existe el archivo de configuracion: ' + str(env_path))
    values = dotenv_values(env_path)
    required = ['APP_TOKEN', 'MQTT_USER', 'MQTT_PASSWORD', 'DEVICE_ID']
    if any(not values.get(key) for key in required):
        raise ValueError('Faltan credenciales locales en el archivo elegido; usa las del servidor en ejecucion')
    return SimpleNamespace(
        app_token=values['APP_TOKEN'], mqtt_host=values.get('MQTT_HOST') or '127.0.0.1',
        mqtt_port=int(values.get('MQTT_PORT') or 1883), mqtt_user=values['MQTT_USER'],
        mqtt_password=values['MQTT_PASSWORD'], device_id=values['DEVICE_ID'])


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--proyecto', type=Path, required=True, help='Carpeta del servidor ENSAIA existente')
    p.add_argument('--env', type=Path, help='El mismo .env o .env.emqx usado por el servidor')
    p.add_argument('--url', default='http://127.0.0.1:8765')
    p.add_argument('--ca', type=Path, help='certs/root-ca.crt si usas HTTPS local')
    p.add_argument('--participante', required=True, help='Codigo seudonimo, por ejemplo D001')
    p.add_argument('--fase', choices=['pre', 'post', 'practice'], default='practice')
    p.add_argument('--segundos', type=float, default=60)
    p.add_argument('--sin-consejos', action='store_true')
    p.add_argument('--demo-ia', action='store_true', help='Microfono REAL, IA SIMULADA; no consume API')
    p.add_argument('--registros', type=Path, default=Path(__file__).resolve().parent / 'registros',
                   help='Carpeta para el informe adicional de integridad de captura ESP32')
    p.add_argument('--consentimiento', action='store_true', help='Confirma que obtuviste aceptacion para grabar/procesar')
    return p


async def execute(args):
    project = args.proyecto.resolve()
    settings = settings_from_file(project, (args.env or project / '.env').resolve())
    sys.path.insert(0, str(project))
    from app.mqtt import MQTTLink
    bridge = MicrophoneBridge(settings, MQTTLink)
    tls = ssl.create_default_context(cafile=str(args.ca)) if args.ca else None
    result = None
    failure = None
    try:
        await bridge.link.start()
        # Espera heartbeat reciente antes de crear una sesion (no basta un retained viejo).
        await asyncio.sleep(2.1)
        sid, summary = await record(bridge, args.url, settings.app_token, {
            'participant': args.participante, 'phase': args.fase,
            'feedback': not args.sin_consejos, 'demo': args.demo_ia,
            'consent': True, 'play_audio': False,
        }, args.segundos, tls)
        result = summary
        print('\nGuardada sesion:', sid)
        print(json.dumps({key: summary.get(key) for key in [
            'audio_duration_ms', 'original_frames', 'relay_frames', 'audio_relay_complete',
            'provider_audio_complete', 'pending_device_events', 'demo', 'device_simulated',
        ]}, ensure_ascii=False, indent=2))
        print('Revisa y exporta la sesion desde ENSAIA en ' + args.url)
    except BaseException as exc:
        failure = type(exc).__name__ + ': ' + str(exc)
        raise
    finally:
        if bridge.sid:
            args.registros.mkdir(parents=True, exist_ok=True)
            path = args.registros / (bridge.sid + '_esp32.json')
            path.write_text(json.dumps({
                'sid': bridge.sid, 'source': 'ESP32-S3-INMP441', 'sample_rate': 16000,
                'samples_per_frame': 320, 'received_frames': bridge.received,
                'forwarded_frames': bridge.forwarded, 'expected_frames': bridge.expected_frames,
                'source_capture_complete': bool(result and bridge.expected_frames and
                    bridge.expected_frames == bridge.received == bridge.forwarded and
                    not failure and not bridge.failure.is_set()),
                'error': failure or bridge.error or None,
                'demo_ai': args.demo_ia,
                'note': 'Informe de la fuente; complementar con indicadores.json del servidor.',
            }, ensure_ascii=False, indent=2), encoding='utf-8')
            print('Informe de captura ESP32:', path)
        await bridge.link.close()


def main():
    p = parser()
    args = p.parse_args()
    if not args.consentimiento:
        p.error('Confirma la aceptacion de la persona grabada mediante --consentimiento')
    if not re.fullmatch('[A-Za-z0-9_-]{1,32}', args.participante):
        p.error('Codigo de participante invalido')
    if not 1 <= args.segundos <= 1790:
        p.error('--segundos debe estar entre 1 y 1790')
    address = urlsplit(args.url)
    if address.scheme not in ('http', 'https') or not address.hostname or address.username or address.password or address.path not in ('', '/') or address.query or address.fragment:
        p.error('--url debe ser http(s)://equipo:puerto sin rutas ni credenciales')
    if address.scheme == 'http' and address.hostname not in ('127.0.0.1', 'localhost', '::1'):
        p.error('HTTP solo se admite en localhost. Para otro equipo utiliza HTTPS y --ca')
    try:
        asyncio.run(execute(args))
    except KeyboardInterrupt:
        print('\nInterrumpido. Revisa el estado guardado en ENSAIA.', file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        # Evitar imprimir URLs completas, respuestas o objetos que contengan tokens.
        print('No se completo la toma: ' + str(exc), file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()

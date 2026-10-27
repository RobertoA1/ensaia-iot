#!/usr/bin/env python3
"""ENSAIA: transcripción local en fragmentos; no contiene la clave OpenAI."""
import asyncio, base64, json, os, sys
from pathlib import Path
import numpy as np
from faster_whisper import WhisperModel
from websockets.asyncio.client import connect
try:
    from .voice_server import start_voice_server
except ImportError:
    from voice_server import start_voice_server

ROOT = Path(__file__).resolve().parents[1]
PROVISION = Path(os.environ.get('ENSAIA_PROVISION', ROOT / '.private/provision.json'))
URL = os.environ.get('ENSAIA_WORKER_URL', 'wss://ensaia-oratoria.vercel.app/api/server?role=worker')
MODEL = os.environ.get('ENSAIA_WHISPER_MODEL', 'base')

def transcribe(model, pcm):
    audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
    if not len(audio) or np.sqrt(np.mean(audio * audio)) < 0.0005:
        return ''
    segments, _ = model.transcribe(audio, language='es', beam_size=1, vad_filter=False,
        condition_on_previous_text=False, no_speech_threshold=0.55)
    return ' '.join(s.text.strip() for s in segments if s.text.strip()).strip()

async def serve(model, cfg):
    while True:
        try:
            async with connect(URL, max_size=1024*1024, ping_interval=20, close_timeout=3) as ws:
                await ws.send(json.dumps({'type':'worker.auth','deviceId':cfg['deviceId'],'secret':cfg['deviceSecret']}))
                ready = json.loads(await asyncio.wait_for(ws.recv(), 15))
                if ready.get('type') != 'worker.ready':
                    raise RuntimeError('Servidor no autorizó la transcripción local')
                print('Whisper conectado. Deja esta ventana abierta.', flush=True)
                queue = asyncio.Queue(maxsize=8)
                async def sender(data): await ws.send(json.dumps(data, ensure_ascii=False))
                async def heartbeat():
                    while True:
                        await asyncio.sleep(5); await sender({'type':'worker.ping'})
                async def process():
                    while True:
                        sid, pcm, end, start_ms = await queue.get()
                        try:
                            if pcm:
                                text = await asyncio.to_thread(transcribe, model, pcm)
                                if text: await sender({'type':'transcript','sid':sid,'text':text,'start_ms':start_ms,'end_ms':start_ms+len(pcm)//32})
                            if end: await sender({'type':'ended','sid':sid})
                        except Exception:
                            await sender({'type':'error','sid':sid,'text':'Error de transcripción local'})
                        queue.task_done()
                ping = asyncio.create_task(heartbeat()); processor = asyncio.create_task(process())
                sid = ''; expected = 0; buf = bytearray(); sample_offset = 0
                try:
                    async for raw in ws:
                        m = json.loads(raw); kind = m.get('type')
                        if kind == 'start':
                            sid=m['sid']; expected=0; sample_offset=0; buf.clear(); print('Transcripción iniciada.',flush=True)
                        elif kind == 'audio' and sid and m.get('sid')==sid:
                            if m.get('seq') != expected: raise RuntimeError('Se perdió un fragmento de audio')
                            expected+=1;buf.extend(base64.b64decode(m['audio'],validate=True))
                            if len(buf)>=128000:
                                await asyncio.wait_for(queue.put((sid,bytes(buf),False,sample_offset)),2);sample_offset+=len(buf)//32;buf.clear()
                        elif kind == 'end' and sid and m.get('sid')==sid:
                            if m.get('seq') != expected: raise RuntimeError('Faltan fragmentos al finalizar')
                            await asyncio.wait_for(queue.put((sid,bytes(buf),True,sample_offset)),2);buf.clear();sid=''
                finally:
                    ping.cancel();processor.cancel()
                    await asyncio.gather(ping,processor,return_exceptions=True)
        except asyncio.CancelledError: raise
        except Exception as exc:
            print('Whisper desconectado:',type(exc).__name__,str(exc)[:140],flush=True)
            await asyncio.sleep(4)

async def main():
    if not PROVISION.exists(): raise RuntimeError('Falta .private/provision.json: usa la carpeta privada del proyecto.')
    cfg=json.loads(PROVISION.read_text());print('Cargando Whisper local:',MODEL,'(CPU, int8)...',flush=True)
    model=await asyncio.to_thread(WhisperModel,MODEL,device='cpu',compute_type='int8',cpu_threads=4)
    voice=None if os.environ.get('ENSAIA_VOICE_DISABLE')=='1' else await asyncio.to_thread(start_voice_server)
    if voice: print('Voz local lista en la laptop.',flush=True)
    try: await serve(model,cfg)
    finally:
        if voice: voice.shutdown();voice.server_close()
if __name__=='__main__':
    try: asyncio.run(main())
    except KeyboardInterrupt: print('\nWhisper detenido.')
    except Exception as exc: print('No se pudo iniciar Whisper:',exc,file=sys.stderr);sys.exit(1)

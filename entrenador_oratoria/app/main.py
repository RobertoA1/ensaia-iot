import asyncio
from contextlib import asynccontextmanager
import csv
import io
import json
import re
import secrets
import zipfile
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect, Depends
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Literal
from .config import BASE, Settings
from .device_sim import SimulatedDevice
from .engine import Engine
from .mqtt import start_broker
from .protocol import SID, utcnow

class SessionRequest(BaseModel):
    participant: str = Field(pattern=r'^[A-Za-z0-9_-]{1,32}$')
    phase: Literal['pre','post','practice'] = 'practice'
    feedback: bool = True
    demo: bool = False
    consent: Literal[True]

class Annotation(BaseModel):
    reviewer: str = Field(pattern=r'^[A-Za-z0-9_-]{1,32}$')
    event_id: str | None = None
    label: Literal['confirmed','rejected','uncertain','missed_in_transcript']
    note: str = Field(default='',max_length=1000)

def csv_cell(value):
    value='' if value is None else str(value)
    return "'"+value if value.startswith(('=','+','-','@','\t','\r')) else value

def create_app(settings=None):
    settings=settings or Settings()
    @asynccontextmanager
    async def lifespan(app):
        settings.validate()
        settings.data_dir.mkdir(parents=True,exist_ok=True)
        broker=None
        node=None
        engine=None
        try:
            if settings.builtin_broker:
                broker=await start_broker(settings)
            engine=Engine(settings)
            app.state.engine=engine
            await engine.start()
            if settings.simulate_device:
                node=SimulatedDevice(settings)
                await node.start()
            yield
        finally:
            if engine:
                await engine.close()
            if node:
                await node.close()
            if broker:
                await broker.shutdown()

    app=FastAPI(title='Entrenador de exposiciones',lifespan=lifespan,docs_url=None,redoc_url=None)
    app.state.settings=settings
    async def authenticate(authorization: str | None=Header(default=None)):
        expected='Bearer '+settings.app_token
        if not authorization or not secrets.compare_digest(authorization,expected):
            raise HTTPException(401,'Token de acceso local incorrecto')

    def session(sid):
        if not SID.fullmatch(sid):
            raise HTTPException(404,'Sesion no encontrada')
        row=app.state.engine.store.session(sid)
        if row is None:
            raise HTTPException(404,'Sesion no encontrada')
        return row

    @app.middleware('http')
    async def headers(request,call_next):
        response=await call_next(request)
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Cache-Control']='no-store'
        response.headers['Permissions-Policy']='microphone=(self), camera=()'
        response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'"
        return response

    @app.get('/')
    async def home():
        return FileResponse(BASE/'web/index.html')

    @app.get('/health')
    async def health():
        return {'ready':app.state.engine.link.connected}

    @app.get('/api/status',dependencies=[Depends(authenticate)])
    async def status():
        engine=app.state.engine
        return {'mqtt_connected':engine.link.connected,'device_online':engine.device_online,
            'device':engine.device,'model':settings.live_model,'api_key_configured':bool(settings.api_key),
            'allow_demo':settings.allow_demo,'max_seconds':settings.max_seconds,
            'active_sid':engine.active.sid if engine.active and not engine.active.finished else None}

    @app.post('/api/sessions',dependencies=[Depends(authenticate)])
    async def start(request:SessionRequest):
        try:
            recording=await app.state.engine.begin(request.participant,request.phase,request.feedback,request.demo)
            return {'sid':recording.sid,'sample_rate':16000,'samples_per_frame':320,
                    'demo':request.demo,'device_simulated':app.state.engine.device.get('simulated',False)}
        except (ValueError,ConnectionError,TimeoutError) as exc:
            raise HTTPException(409,str(exc)) from exc
        except Exception as exc:
            raise HTTPException(502,'No se pudo abrir GPT-Live. Revisa acceso al modelo, saldo, red y registro del servidor.') from exc

    @app.get('/api/sessions',dependencies=[Depends(authenticate)])
    async def sessions():
        return app.state.engine.store.sessions()

    @app.get('/api/sessions/{sid}',dependencies=[Depends(authenticate)])
    async def detail(sid:str):
        row=session(sid)
        return {'session':row,'summary':json.loads(row['summary_json']),
                'events':[dict(e,payload=json.loads(e['payload_json'])) for e in app.state.engine.store.events(sid)]}

    @app.post('/api/sessions/{sid}/stop',dependencies=[Depends(authenticate)])
    async def stop(sid:str):
        session(sid)
        engine=app.state.engine
        if not engine.active or engine.active.sid!=sid:
            raise HTTPException(409,'La sesion no esta activa')
        return await engine.active.stop()

    @app.post('/api/sessions/{sid}/annotations',dependencies=[Depends(authenticate)])
    async def annotate(sid:str,p:Annotation):
        session(sid)
        store=app.state.engine.store
        if p.event_id:
            found=store.db.execute('SELECT id FROM events WHERE id=? AND sid=?',(p.event_id,sid)).fetchone()
            if not found:
                raise HTTPException(400,'El evento no pertenece a esta sesion')
        store.db.execute('INSERT INTO annotations(sid,event_id,reviewer,label,note,created_at) VALUES (?,?,?,?,?,?)',
                         (sid,p.event_id,p.reviewer,p.label,p.note,utcnow()))
        store.db.commit()
        return {'saved':True}

    @app.get('/api/sessions/{sid}/export',dependencies=[Depends(authenticate)])
    async def export(sid:str):
        row=session(sid)
        if row['status'] in ('starting','recording','closing'):
            raise HTTPException(409,'Finaliza la sesion antes de exportar el audio WAV')
        store=app.state.engine.store
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('sesion.json',json.dumps(row,ensure_ascii=False,indent=2))
            rows=store.events(sid)
            archive.writestr('eventos.json',json.dumps(rows,ensure_ascii=False,indent=2))
            output=io.StringIO()
            writer=csv.writer(output)
            writer.writerow(['event_id','tipo','hora_utc','confirmado_esp8266','texto','datos_json'])
            for e in rows:
                p=json.loads(e['payload_json'])
                writer.writerow([csv_cell(x) for x in [e['id'],e['kind'],e['created_at'],e['device_confirmed_at'],p.get('text',''),e['payload_json']]])
            archive.writestr('eventos.csv',output.getvalue())
            annotations=[dict(r) for r in store.db.execute('SELECT * FROM annotations WHERE sid=?',(sid,))]
            archive.writestr('revision_humana.json',json.dumps(annotations,ensure_ascii=False,indent=2))
            for path in (store.directory/sid).iterdir():
                if path.is_file() and path.suffix in {'.wav','.txt','.json','.jsonl'}:
                    archive.write(path,path.name)
        return Response(buffer.getvalue(),media_type='application/zip',
                        headers={'Content-Disposition':f'attachment; filename=sesion-{sid}.zip'})

    @app.websocket('/ws/{sid}')
    async def microphone(ws:WebSocket,sid:str):
        await ws.accept()
        current=None
        try:
            auth=await asyncio.wait_for(ws.receive_json(),8)
            if not isinstance(auth,dict) or not secrets.compare_digest(str(auth.get('token','')),settings.app_token):
                await ws.close(code=1008)
                return
            candidate=app.state.engine.active
            if not candidate or candidate.sid!=sid or candidate.finished or candidate.clients:
                await ws.close(code=1008,reason='Sesion invalida o microfono ya conectado')
                return
            current=candidate
            current.clients.add(ws)
            await ws.send_json({'type':'ready','sid':sid,'demo':current.demo,
                                'feedback_enabled':current.feedback})
            while not current.finished:
                packet=await ws.receive()
                if packet['type']=='websocket.disconnect':
                    break
                if packet.get('bytes') is not None:
                    await current.original_audio(packet['bytes'])
                elif packet.get('text'):
                    data=json.loads(packet['text'])
                    if data.get('type')=='stop':
                        await current.stop(expected_frames=data.get('frames'))
                        break
                    if data.get('type')=='ping':
                        await ws.send_json({'type':'pong'})
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            with __import__('contextlib').suppress(Exception):
                await ws.send_json({'type':'error','text':str(exc)[:500]})
        finally:
            if current:
                current.clients.discard(ws)
                if not current.finished:
                    await asyncio.shield(app.state.engine.schedule_stop(current,'browser_disconnected'))
            with __import__('contextlib').suppress(Exception):
                await ws.close()

    app.mount('/static',StaticFiles(directory=BASE/'web'),name='static')
    return app

app=create_app()

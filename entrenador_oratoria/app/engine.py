import asyncio
import base64
import contextlib
import json
import time
import wave
import zlib
from pathlib import Path
from .analysis import SpeechAnalysis
from .live import LiveConnection, DemoConnection
from .mqtt import MQTTLink
from .protocol import MAX_PACKET, new_id, pack_audio, text_parts, unpack_audio, utcnow
from .storage import Store

class Recording:
    def __init__(self, engine, sid, feedback, demo):
        self.engine, self.sid = engine, sid
        self.feedback, self.demo = feedback, demo
        self.analysis=SpeechAnalysis()
        self.created=time.monotonic()
        self.capture_start=None
        self.capture_end=None
        self.last_browser=time.monotonic()
        self.original_seq=0
        self.original_samples=0
        self.relay_seq=0
        self.relay_samples=0
        self.relay_gaps=0
        self.relay_duplicates=0
        self.relay_bytes=0
        self.original_checksums={}
        self.mqtt_drops_at_start=engine.link.dropped
        self.seen_cloud=set()
        self.clients=set()
        self.last_context=0
        self.closing=False
        self.finished=False
        self.stop_lock=asyncio.Lock()
        self.provider_ready=False
        self.raw_log=(engine.store.directory/sid/'provider_events.jsonl').open('a',encoding='utf-8')
        self.audio_out=None
        self.original=self._wav('microfono_original.wav')
        self.relay=self._wav('audio_via_esp8266.wav')
        factory=DemoConnection if demo else LiveConnection
        self.provider=factory(engine.settings,self.provider_event)

    def _wav(self,name):
        f=wave.open(str(self.engine.store.directory/self.sid/name),'wb')
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        return f

    async def broadcast(self, payload):
        for client in list(self.clients):
            try:
                await asyncio.wait_for(client.send_json(payload),2)
            except Exception:
                self.clients.discard(client)

    async def event(self,kind,text=None,**fields):
        if self.finished:
            return
        parts=list(text_parts(text)) if text else [None]
        for part in parts:
            event={'id':new_id(),'sid':self.sid,'kind':kind,'at':utcnow(),**fields}
            if part is not None:
                event['text']=part
            encoded=json.dumps(event,ensure_ascii=False,separators=(',',':')).encode()
            if len(encoded)>1500:
                raise ValueError('Evento demasiado grande para el firmware')
            self.engine.store.event(event)
            try:
                self.engine.link.publish(self.engine.root+'/down/event',encoded)
            except ConnectionError:
                pass  # El evento ya esta en el outbox persistente y se reintentara.

    async def original_audio(self,packet):
        if self.closing or not self.provider_ready:
            raise ValueError('La sesion no esta lista para recibir audio')
        sid,seq,offset,pcm=unpack_audio(packet)
        if sid!=self.sid or seq!=self.original_seq or offset!=self.original_samples:
            raise ValueError('Secuencia u offset del microfono inconsistente; iniciar otra sesion')
        if not self.engine.device_online:
            raise ConnectionError('ESP8266 desconectado; audio conservado hasta la ultima trama recibida')
        self.last_browser=time.monotonic()
        if self.capture_start is None:
            self.capture_start=utcnow()
        self.original.writeframesraw(pcm)
        self.original_checksums[seq]=zlib.crc32(pcm)
        self.analysis.audio(pcm)
        self.original_seq+=1
        self.original_samples+=len(pcm)//2
        self.engine.link.publish(self.engine.root+'/down/audio',packet,qos=0)
        if seq%25==0:
            await self.broadcast({'type':'meters','metrics':self.analysis.metrics(),
                                  'frames_sent':self.original_seq,'frames_relayed':self.relay_seq})

    async def relayed_audio(self,packet):
        sid,seq,offset,pcm=unpack_audio(packet)
        if sid!=self.sid or self.finished or not self.provider_ready:
            return
        if seq < self.relay_seq or offset < self.relay_samples:
            self.relay_duplicates+=1
            return
        if seq>=self.original_seq or offset+len(pcm)//2>self.original_samples:
            raise ValueError('El dispositivo publico una trama no recibida del microfono')
        if self.original_checksums.get(seq)!=zlib.crc32(pcm):
            raise ValueError('El audio retransmitido no coincide con el original')
        missing=offset-self.relay_samples
        if missing:
            self.relay_gaps+=seq-self.relay_seq
            silence=b'\0'*(missing*2)
            self.relay.writeframesraw(silence)
            await self.provider.audio(silence)
            await self.broadcast({'type':'warning','text':'Se detecto perdida de audio en el relevo MQTT; sesion marcada con incidencia.'})
        self.relay.writeframesraw(pcm)
        self.relay_bytes+=len(pcm)
        self.relay_samples=offset+len(pcm)//2
        self.relay_seq=seq+1
        await self.provider.audio(pcm)

    async def provider_event(self,p):
        if self.finished:
            return
        kind=p.get('type','unknown')
        event_id=p.get('event_id')
        if event_id and event_id in self.seen_cloud:
            return
        if event_id:
            self.seen_cloud.add(event_id)
        if kind=='session.output_audio.delta':
            audio=base64.b64decode(p.get('delta',''),validate=True)
            if len(audio)%2:
                raise ValueError('Audio de salida PCM16 incompleto')
            if self.audio_out is None:
                self.audio_out=self._wav('respuesta_gpt.wav')
            self.audio_out.writeframesraw(audio)
            # Salida oral opcional; el feedback principal es visual y serie, confirmado por el ESP.
            if self.feedback:
                await self.broadcast({'type':'assistant_audio','pcm':p['delta']})
            return
        self.raw_log.write(json.dumps(p,ensure_ascii=False)+'\n')
        self.raw_log.flush()
        if kind=='session.input_transcript.delta':
            text=p.get('delta','')
            if not isinstance(text,str):
                raise ValueError('Delta textual invalido')
            start,end=p.get('start_ms'),p.get('end_ms')
            await self.event('transcript.user',text,start_ms=start,end_ms=end)
            for candidate in self.analysis.append_text(text,start,end):
                await self.event('speech.candidate',candidate_kind=candidate['kind'],
                                 **{k:v for k,v in candidate.items() if k!='kind'})
            if self.feedback and time.monotonic()-self.last_context>=15:
                self.last_context=time.monotonic()
                await self.provider.context('Indicadores exploratorios no validados por humanos: '+json.dumps(self.analysis.metrics(),ensure_ascii=False))
        elif kind=='session.output_transcript.delta':
            await self.event('feedback.ai',p.get('delta',''),start_ms=p.get('start_ms'),end_ms=p.get('end_ms'),
                             visible=self.feedback)
        elif kind=='session.started':
            await self.event('provider.started',provider_session_id=p.get('session',{}).get('id'),demo=self.demo)
        elif kind=='session.closed':
            await self.event('provider.closed',usage=p.get('usage',{}),reason=p.get('reason'))
        elif kind=='session.usage.updated':
            await self.broadcast({'type':'usage','usage':p.get('usage',{})})
        elif kind=='session.delegation.created':
            # El flujo actual no necesita herramientas. Responder con contexto ya observado.
            await self.provider.context('Este prototipo solo entrena exposiciones. No hay herramientas externas. '+
                                        json.dumps(self.analysis.metrics(),ensure_ascii=False))
        elif kind in ('error','transport.error'):
            message=(p.get('error',{}).get('message') or p.get('message') or 'Error del proveedor')[:600]
            await self.event('provider.error',message)
            await self.broadcast({'type':'error','text':message})
            if self.provider_ready and not self.closing:
                self.engine.schedule_stop(self,'provider_error')

    async def stop(self,reason='user',expected_frames=None):
        async with self.stop_lock:
            if self.finished:
                return self.engine.store.session(self.sid)
            self.closing=True
            self.capture_end=utcnow()
            self.engine.store.update(self.sid,status='closing')
            # Los mensajes finales del navegador se procesaron antes del comando stop.
            deadline=time.monotonic()+2
            while self.relay_seq<self.original_seq and time.monotonic()<deadline:
                await asyncio.sleep(.03)
            if self.provider_ready:
                # Tiempo acotado para que el proveedor procese el final del discurso.
                try:
                    if not self.demo and self.relay_bytes:
                        await self.provider.audio(b'\0'*16000)
                        await asyncio.sleep(.5)
                    finalized=await self.provider.close()
                except Exception as exc:
                    finalized=False
                    await self.event('provider.error','No se confirmo el cierre: '+type(exc).__name__)
                    with contextlib.suppress(Exception):
                        await self.provider.abort()
            else:
                finalized=False
                await self.provider.abort()
            for candidate in self.analysis.finish():
                await self.event('speech.candidate',candidate_kind=candidate['kind'],
                                 **{k:v for k,v in candidate.items() if k!='kind'})
            duration_ms=round((time.monotonic()-self.created)*1000)
            metrics=self.analysis.metrics()
            mqtt_drops=self.engine.link.dropped-self.mqtt_drops_at_start
            complete_audio=self.original_samples>0 and self.original_samples==self.relay_samples and self.relay_gaps==0 and mqtt_drops==0
            summary={'metrics':metrics,'capture_started_at':self.capture_start,'capture_ended_at':self.capture_end,
                'audio_duration_ms':round(self.original_samples/16),'session_wall_duration_ms':duration_ms,
                'original_frames':self.original_seq,'relay_frames':self.relay_seq,
                'relay_missing_frames':self.relay_gaps+max(0,self.original_seq-self.relay_seq),
                'relay_duplicates':self.relay_duplicates,'audio_relay_complete':complete_audio,
                'provider_finalization_confirmed':finalized,'reason':reason,'demo':self.demo,
                'device_simulated':self.engine.device.get('simulated',False),
                'browser_expected_frames':expected_frames,'mqtt_internal_drops':mqtt_drops,
                'measurement_status':'requires_human_audio_review'}
            if expected_frames is not None and expected_frames!=self.original_seq:
                summary['audio_relay_complete']=False
            await self.event('session.ended',reason=reason,duration_ms=duration_ms,
                             audio_duration_ms=summary['audio_duration_ms'],relay_complete=summary['audio_relay_complete'])
            await self.event('metrics.final',metrics=metrics)
            deadline=time.monotonic()+3
            while self.engine.store.pending(self.sid) and time.monotonic()<deadline:
                await asyncio.sleep(.05)
            summary['pending_device_events']=self.engine.store.pending_count(self.sid)
            self.engine.store.update(self.sid,status='ended' if reason=='user' else 'interrupted',
                ended_at=utcnow(),duration_ms=duration_ms,summary_json=json.dumps(summary,ensure_ascii=False))
            directory=self.engine.store.directory/self.sid
            (directory/'transcripcion_estudiante.txt').write_text(self.analysis.text,encoding='utf-8')
            (directory/'indicadores.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
            (directory/'silencios.json').write_text(json.dumps(self.analysis.silences,indent=2),encoding='utf-8')
            self.finished=True
            for file in [self.original,self.relay,self.audio_out,self.raw_log]:
                if file:
                    file.close()
            with contextlib.suppress(Exception):
                await self.engine.control({'op':'stop','sid':self.sid},timeout=2)
            await self.broadcast({'type':'ended','summary':summary})
            return self.engine.store.session(self.sid)

class Engine:
    def __init__(self,settings,provider_factory=None):
        self.settings=settings
        self.root=settings.root
        self.store=Store(settings.data_dir)
        self.active=None
        self.device={}
        self.device_seen=0
        self.controls={}
        self.link=MQTTLink(settings,'oratoria-laptop',[self.root+'/up/#'],self.receive)
        self.task=None
        self.start_lock=asyncio.Lock()
        self.stop_tasks=set()

    def schedule_stop(self,current,reason):
        task=asyncio.create_task(current.stop(reason))
        self.stop_tasks.add(task)
        def done(t):
            self.stop_tasks.discard(t)
            if not t.cancelled():
                t.exception()  # recuperar excepciones incluso si el navegador ya se desconecto
        task.add_done_callback(done)
        return task

    @property
    def device_online(self):
        return bool(self.device.get('online')) and time.monotonic()-self.device_seen<8

    async def start(self):
        await self.link.start()
        self.task=asyncio.create_task(self.housekeeping())

    async def receive(self,topic,data):
        if topic.endswith('/status'):
            p=json.loads(data)
            self.device=p
            self.device_seen=time.monotonic()
            if (self.active and self.active.provider_ready and not self.active.closing and
                not self.active.finished and p.get('online') and p.get('sid')!=self.active.sid):
                self.schedule_stop(self.active,'device_restarted')
        elif topic.endswith('/control'):
            p=json.loads(data)
            pending=self.controls.get(p.get('id'))
            if pending and not pending.done():
                pending.set_result(p)
        elif topic.endswith('/event'):
            event=json.loads(data)
            first=self.store.confirm(event)
            if first and self.active and event.get('sid')==self.active.sid:
                await self.active.broadcast({'type':'device_event','event':event,
                                            'metrics':self.active.analysis.metrics()})
        elif topic.endswith('/audio') and self.active:
            try:
                await self.active.relayed_audio(data)
            except Exception as exc:
                await self.active.broadcast({'type':'error','text':str(exc)[:500]})
                if not self.active.closing:
                    self.schedule_stop(self.active,'audio_error')

    async def control(self,payload,timeout=5):
        payload=dict(payload,id=new_id())
        future=asyncio.get_running_loop().create_future()
        self.controls[payload['id']]=future
        try:
            for attempt in range(2):
                self.link.publish(self.root+'/down/control',payload)
                try:
                    return await asyncio.wait_for(asyncio.shield(future),timeout/2)
                except TimeoutError:
                    if attempt:
                        raise TimeoutError('El ESP8266 no confirmo la orden')
        finally:
            self.controls.pop(payload['id'],None)

    async def begin(self,participant,phase,feedback,demo):
        async with self.start_lock:
            if self.active and not self.active.finished:
                raise ValueError('Ya existe una sesion activa en este dispositivo')
            if not self.device_online:
                raise ConnectionError('No hay ESP8266 conectado. Para pruebas sin placa usa --demo')
            if not demo and not self.settings.api_key:
                raise ValueError('Configura OPENAI_API_KEY en el archivo .env de la laptop')
            if demo and not self.settings.allow_demo:
                raise ValueError('Las demostraciones estan deshabilitadas')
            sid=new_id()[:8]
            self.store.create(sid,participant,phase,feedback,demo)
            current=Recording(self,sid,feedback,demo)
            self.active=current
            try:
                await self.control({'op':'start','sid':sid,'feedback':feedback})
                await current.provider.open()
                current.provider_ready=True
                current.last_browser=time.monotonic()
                self.store.update(sid,status='recording')
                await current.event('session.started',participant=participant,phase=phase,
                                    feedback_enabled=feedback,demo=demo,consent_recorded=True)
                return current
            except BaseException:
                await asyncio.shield(self.schedule_stop(current,'startup_error'))
                raise

    async def housekeeping(self):
        while True:
            await asyncio.sleep(.5)
            if self.link.connected:
                for event in self.store.pending():
                    try:
                        self.link.publish(self.root+'/down/event',event)
                    except ConnectionError:
                        break
            current=self.active
            if current and current.provider_ready and not current.finished and not current.closing:
                reason=None
                if time.monotonic()-current.created>self.settings.max_seconds:
                    reason='time_limit'
                elif time.monotonic()-current.last_browser>20:
                    reason='microphone_timeout'
                elif not self.device_online:
                    reason='device_disconnected'
                if reason:
                    self.schedule_stop(current,reason)

    async def close(self):
        if self.active and not self.active.finished:
            await self.active.stop('server_shutdown')
        if self.stop_tasks:
            await asyncio.gather(*self.stop_tasks,return_exceptions=True)
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task,return_exceptions=True)
        await self.link.close()
        self.store.close()

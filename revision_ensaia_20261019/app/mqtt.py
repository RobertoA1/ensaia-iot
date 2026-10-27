import asyncio
import json
from pathlib import Path
import paho.mqtt.client as mqtt

class MQTTLink:
    def __init__(self, settings, name, subscriptions, receive):
        self.settings, self.name = settings, name
        self.subscriptions, self.receive = subscriptions, receive
        self.ready = asyncio.Event()
        self.connected = False
        self.last_error = None
        self.disconnects = 0
        self.connections = 0
        self.failed = asyncio.Event()
        self.loop = asyncio.get_running_loop()
        self.inbox = asyncio.Queue(maxsize=4096)
        self.worker = None
        self.dropped = 0
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=name,
                                  protocol=mqtt.MQTTv311)
        self.client.username_pw_set(settings.mqtt_user, settings.mqtt_password)
        self.client.on_connect = self._connected
        self.client.on_subscribe = self._subscribed
        self.client.on_disconnect = self._disconnected
        self.client.on_connect_fail = self._connect_failed
        self.client.on_message = self._message
        self.client.reconnect_delay_set(1,5)

    def _connected(self, client, userdata, flags, reason, properties):
        if not reason.is_failure:
            self.loop.call_soon_threadsafe(self._connection_ok)
            if self.subscriptions:
                client.subscribe([t if isinstance(t, tuple) else (t,1) for t in self.subscriptions])
            else:
                self.loop.call_soon_threadsafe(self.ready.set)
        else:
            self.loop.call_soon_threadsafe(self._reject,'MQTT rechazo la conexion; revisa usuario, contrasena y permisos')

    def _connection_ok(self):
        self.connected=True
        self.connections+=1
        self.last_error=None
        self.failed.clear()

    def _reject(self,message):
        self.last_error=message
        self.ready.clear()
        self.failed.set()

    def _connect_failed(self,*args):
        self.loop.call_soon_threadsafe(self._unavailable)

    def _unavailable(self):
        self.last_error='Broker MQTT no disponible; revisa servicio, host, puerto y firewall'

    def _subscribed(self, client, userdata, mid, reasons, properties):
        if all(not r.is_failure for r in reasons):
            self.loop.call_soon_threadsafe(self.ready.set)
        else:
            self.loop.call_soon_threadsafe(self._reject,'MQTT rechazo una suscripcion; revisa los permisos de topicos')

    def _disconnected(self, *args):
        self.loop.call_soon_threadsafe(self._connection_lost)

    def _connection_lost(self):
        self.disconnects+=int(self.connected)
        self.connected = False
        self.ready.clear()
        self.last_error='Conexion MQTT interrumpida; reintentando'

    def _message(self, client, userdata, message):
        self.loop.call_soon_threadsafe(self._put, message.topic, bytes(message.payload))

    def _put(self, topic, data):
        try:
            self.inbox.put_nowait((topic,data))
        except asyncio.QueueFull:
            self.dropped += 1

    async def _work(self):
        while True:
            topic, data = await self.inbox.get()
            try:
                await self.receive(topic,data)
            except Exception:
                import logging
                logging.getLogger(__name__).exception('Mensaje MQTT rechazado')
            finally:
                self.inbox.task_done()

    async def start(self):
        self.worker = asyncio.create_task(self._work())
        self.client.connect_async(self.settings.mqtt_host, self.settings.mqtt_port, 15)
        self.client.loop_start()
        ready=asyncio.create_task(self.ready.wait())
        failed=asyncio.create_task(self.failed.wait())
        try:
            done,_=await asyncio.wait([ready,failed],timeout=15,return_when=asyncio.FIRST_COMPLETED)
            if failed in done:
                raise ConnectionError(self.last_error)
            if ready not in done:
                raise ConnectionError(self.last_error or 'Tiempo agotado esperando conexion y suscripcion MQTT')
        except Exception:
            await self.close()
            raise
        finally:
            ready.cancel();failed.cancel()
            await asyncio.gather(ready,failed,return_exceptions=True)

    def publish(self, topic, payload, qos=1, retain=False):
        if not isinstance(payload, (bytes,str)):
            payload=json.dumps(payload, ensure_ascii=False, separators=(',',':'))
        result=self.client.publish(topic,payload,qos=qos,retain=retain)
        if result.rc != mqtt.MQTT_ERR_SUCCESS:
            raise ConnectionError('MQTT no conectado; no se ha publicado el mensaje')
        return result

    async def close(self):
        self.client.disconnect()
        await asyncio.to_thread(self.client.loop_stop)
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)

async def start_broker(settings):
    from amqtt.broker import Broker
    from passlib.hash import sha512_crypt
    class LocalBroker(Broker):
        async def _shutdown_broadcast_loop(self):
            try:
                await super()._shutdown_broadcast_loop()
            except asyncio.CancelledError:
                # amqtt 0.11.3 puede propagar la cancelacion de una entrega QoS
                # al cerrar un cliente. No confundirla con cancelar el servidor.
                if asyncio.current_task().cancelling():
                    raise
                self.logger.debug('Entrega MQTT cancelada durante el cierre del broker')
    password_path=settings.data_dir/'broker-passwords'
    password_path.write_text(settings.mqtt_user+':'+sha512_crypt.hash(settings.mqtt_password)+'\n')
    password_path.chmod(0o600)
    broker=LocalBroker({'listeners': {'default': {'type':'tcp',
                         'bind':f'{settings.mqtt_bind}:{settings.mqtt_port}'}},
                   'plugins': {'amqtt.plugins.authentication.FileAuthPlugin': {
                         'password_file':str(password_path)}}})
    await broker.start()
    return broker

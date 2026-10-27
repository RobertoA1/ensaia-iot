"""Cliente sin logs de credenciales, con limites y resuscripcion automatica."""
import json
from datetime import datetime,timezone
from pathlib import Path
import queue
import threading
import time
from uuid import uuid4
import paho.mqtt.client as mqtt

class Client:
    def __init__(self,config,role,subscribe=False,credentials=True,protocol=mqtt.MQTTv311):
        self.config=config
        self.subscribe=subscribe
        self.connected=threading.Event();self.ready=threading.Event();self.rejected=threading.Event()
        self.inbox=queue.Queue(maxsize=10000)
        self.error=None;self.connections=0;self.disconnects=0;self.dropped=0
        self.subscription_rejected=False
        self.client=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,client_id=f'lab-{role}-{uuid4().hex[:12]}',
            protocol=protocol)
        if credentials:
            self.client.username_pw_set(config.user,config.password)
        self.client.reconnect_delay_set(1,5)
        self.client.on_connect=self._connect
        self.client.on_connect_fail=lambda *a:setattr(self,'error','Broker no disponible; revisa servicio, host, puerto y firewall')
        self.client.on_disconnect=self._disconnect
        self.client.on_subscribe=self._subscribe
        self.client.on_message=self._message
        self.publish_reasons={}
        self.client.on_publish=self._published
        self.started=False

    def _connect(self,client,userdata,flags,reason,properties):
        if reason.is_failure:
            self.error='Conexion rechazada: revisa autenticacion y permisos';self.rejected.set();return
        self.connections+=1;self.error=None;self.rejected.clear();self.connected.set()
        if self.subscribe:
            client.subscribe(self.config.topic,qos=self.config.qos)
        else:
            self.ready.set()

    def _subscribe(self,client,userdata,mid,reasons,properties):
        if any(r.is_failure for r in reasons):
            self.subscription_rejected=True
            self.error='Suscripcion rechazada por el broker';self.rejected.set()
        else:
            self.ready.set()

    def _disconnect(self,*args):
        self.disconnects+=int(self.connected.is_set());self.connected.clear();self.ready.clear()

    def _message(self,client,userdata,message):
        try:
            self.inbox.put_nowait({'topic':message.topic,'raw':bytes(message.payload),'retained':message.retain,
                'received_at':datetime.now(timezone.utc).isoformat()})
        except queue.Full:
            self.dropped+=1

    def _published(self,client,userdata,mid,reason,properties):
        # Solo conservar rechazos; los PUBACK satisfactorios no acumulan memoria.
        if reason.is_failure:self.publish_reasons[mid]=True

    def start(self):
        self.client.connect_async(self.config.host,self.config.port,15)
        self.client.loop_start();self.started=True
        deadline=time.monotonic()+self.config.timeout
        while time.monotonic()<deadline:
            if self.rejected.is_set():
                self.close();raise ConnectionError(self.error)
            if self.ready.wait(.05):return self
        self.close()
        raise ConnectionError(self.error or 'Tiempo agotado esperando conexion o suscripcion MQTT')

    def publish(self,payload,topic=None):
        if not self.ready.is_set():raise ConnectionError('MQTT sin conexion; espera la reconexion')
        data=payload if isinstance(payload,(str,bytes)) else json.dumps(payload,ensure_ascii=False,separators=(',',':'))
        info=self.client.publish(topic or self.config.topic,data,qos=self.config.qos,retain=False)
        if info.rc!=mqtt.MQTT_ERR_SUCCESS:raise ConnectionError('No se pudo publicar el mensaje MQTT')
        info.wait_for_publish(timeout=self.config.timeout)
        if not info.is_published():raise TimeoutError('Tiempo agotado al enviar el mensaje MQTT')
        if self.publish_reasons.pop(info.mid,False):raise PermissionError('Publicacion rechazada por el broker')

    def close(self):
        if self.started:
            self.client.disconnect();self.client.loop_stop();self.started=False

    def __enter__(self):return self.start()
    def __exit__(self,*args):self.close()

def message(run_id,sequence):
    return {'ejecucion':run_id,'secuencia':sequence,'texto':f'Prueba MQTT del entrenador {sequence}'}

def run_id(value=None):
    value=value or uuid4().hex
    if not value or len(value)>64 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in value):
        raise ValueError('ID de ejecucion invalido: usa letras, numeros, guion o guion bajo (maximo 64)')
    return value

def log(path,row):
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    with Path(path).open('a',encoding='utf-8') as f:
        f.write(json.dumps(row,ensure_ascii=False)+'\n')

def decoded(row):
    return {k:v for k,v in row.items() if k!='raw'} | {'payload':json.loads(row['raw'])}

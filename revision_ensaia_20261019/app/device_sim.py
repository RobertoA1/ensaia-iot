"""Nodo de pruebas por MQTT. No representa hardware verificado."""
import asyncio
import json
from .mqtt import MQTTLink
from .protocol import unpack_audio

class SimulatedDevice:
    def __init__(self, settings):
        self.settings=settings
        self.sid=''
        self.link=MQTTLink(settings,'simulated-esp8266',[
            (settings.root+'/down/audio',0),
            (settings.root+'/down/control',0), (settings.root+'/down/event',0),
        ],self.receive)
        self.task=None

    async def start(self):
        self.link.client.will_set(self.settings.root+'/up/status',
            json.dumps({'online':False,'simulated':True}),qos=1,retain=True)
        await self.link.start()
        self.task=asyncio.create_task(self.heartbeat())

    async def heartbeat(self):
        while True:
            self.link.publish(self.settings.root+'/up/status',{'online':True,'simulated':True,'sid':self.sid},retain=True)
            await asyncio.sleep(2)

    async def receive(self, topic, data):
        if topic.endswith('/control'):
            p=json.loads(data)
            if p.get('op')=='start':
                self.sid=p['sid']
            self.link.publish(self.settings.root+'/up/control',p)
            if p.get('op')=='stop':
                self.sid=''
        elif topic.endswith('/audio'):
            sid,seq,offset,pcm=unpack_audio(data)
            if sid==self.sid:
                self.link.publish(self.settings.root+'/up/audio',data,qos=0)
        elif topic.endswith('/event'):
            p=json.loads(data)
            # Tambien permite entregar registros pendientes de una sesion cerrada.
            self.link.publish(self.settings.root+'/up/event',data,qos=0)

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task,return_exceptions=True)
        self.link.publish(self.settings.root+'/up/status',{'online':False,'simulated':True},retain=True)
        await self.link.close()

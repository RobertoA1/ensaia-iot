import argparse
from dataclasses import dataclass, field
from pathlib import Path
import os
from dotenv import dotenv_values

@dataclass(frozen=True)
class Config:
    host: str='127.0.0.1'
    port: int=1884
    user: str='laboratorio'
    password: str=field(default='',repr=False)
    topic: str='laboratorio/oratoria/prueba'
    qos: int=0
    timeout: float=10

    @classmethod
    def load(cls,path):
        if not Path(path).is_file():
            raise ValueError('Falta el archivo de configuracion del laboratorio; copia laboratorio/.env.example')
        values={**dotenv_values(path),**{k:v for k,v in os.environ.items() if k.startswith('MQTT_')}}
        try:
            result=cls(host=values.get('MQTT_HOST','127.0.0.1'),port=int(values.get('MQTT_PORT','1884')),
                user=values.get('MQTT_USER',''),password=values.get('MQTT_PASSWORD',''),
                topic=values.get('MQTT_TOPIC','laboratorio/oratoria/prueba'),qos=int(values.get('MQTT_QOS','0')),
                timeout=float(values.get('MQTT_TIMEOUT','10')))
        except (TypeError,ValueError):
            raise ValueError('Puerto, QoS o tiempo limite invalidos') from None
        result.validate()
        return result

    def validate(self):
        if not self.host or any(c.isspace() for c in self.host) or any(c in self.host for c in '/@?#'):
            raise ValueError('MQTT_HOST debe ser IP o nombre de equipo, sin URL')
        if not 1<=self.port<=65535 or self.qos not in (0,1,2) or not 0<self.timeout<=120:
            raise ValueError('Puerto, QoS o tiempo limite fuera de rango')
        if not self.topic.startswith('laboratorio/oratoria/') or any(c in self.topic for c in '+#\0'):
            raise ValueError('Usa un topico exacto dentro de laboratorio/oratoria/ separado de sesiones reales')
        if not self.user or not self.password or self.password=='CAMBIAR':
            raise ValueError('Completa el usuario y contrasena del laboratorio')

def parser(description):
    p=argparse.ArgumentParser(description=description)
    p.add_argument('--env-file',default='laboratorio/.env')
    p.add_argument('--log-dir',type=Path,default=Path('evidencias/emqx'))
    p.add_argument('--run-id',help='Compartir este ID entre publicador y suscriptor')
    p.add_argument('--count',type=int,default=10)
    return p

from dataclasses import dataclass, field
import os
from pathlib import Path
from dotenv import load_dotenv

BASE = Path(__file__).resolve().parents[1]
if not os.getenv('ORATORIA_ENV_LOADED'):
    load_dotenv(BASE / '.env')

def env(name, default='', convert=str):
    return field(default_factory=lambda: convert(os.getenv(name,default)))

def port_value(value):
    try:
        port=int(value)
    except (ValueError,TypeError):
        raise ValueError('MQTT_PORT debe ser un numero entre 1 y 65535') from None
    if not 1<=port<=65535:
        raise ValueError('MQTT_PORT debe estar entre 1 y 65535')
    return port

def host_value(value):
    if not value or value!=value.strip() or any(c.isspace() for c in value) or any(c in value for c in '/@?#'):
        raise ValueError('MQTT_HOST debe contener solo IP o nombre de equipo, sin URL ni credenciales')
    return value

@dataclass
class Settings:
    app_token: str = env('APP_TOKEN')
    api_key: str = env('OPENAI_API_KEY')
    live_model: str = env('LIVE_MODEL','gpt-live-1')
    voice: str = env('LIVE_VOICE','marin')
    mqtt_host: str = env('MQTT_HOST','127.0.0.1',host_value)
    mqtt_port: int = env('MQTT_PORT','1883',port_value)
    mqtt_bind: str = env('MQTT_BIND','0.0.0.0')
    mqtt_user: str = env('MQTT_USER','oratoria')
    mqtt_password: str = env('MQTT_PASSWORD')
    device_id: str = env('DEVICE_ID','esp8266-oratoria')
    builtin_broker: bool = env('BUILTIN_BROKER','true',lambda v:v.lower()=='true')
    simulate_device: bool = env('SIMULATE_DEVICE','false',lambda v:v.lower()=='true')
    allow_demo: bool = env('ALLOW_DEMO','true',lambda v:v.lower()=='true')
    max_seconds: int = env('MAX_SESSION_SECONDS','300',int)
    data_dir: Path = env('DATA_DIR','data',lambda v:BASE/Path(v))

    @property
    def root(self):
        return f'oratoria/v1/{self.device_id}'

    def validate(self):
        host_value(self.mqtt_host)
        port_value(self.mqtt_port)
        if len(self.app_token) < 20 or len(self.mqtt_password) < 16:
            raise ValueError('Ejecuta tools/configurar.py para generar las credenciales locales')
        if self.live_model != 'gpt-live-1':
            raise ValueError('Este adaptador implementa GPT-Live 1; no acepta modelos de Realtime como sustitutos')
        if not 30 <= self.max_seconds <= 1800:
            raise ValueError('MAX_SESSION_SECONDS debe estar entre 30 y 1800')

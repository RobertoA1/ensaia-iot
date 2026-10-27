from dataclasses import dataclass
import os
from pathlib import Path
from dotenv import load_dotenv

BASE = Path(__file__).resolve().parents[1]
load_dotenv(BASE / '.env')

@dataclass
class Settings:
    app_token: str = os.getenv('APP_TOKEN', '')
    api_key: str = os.getenv('OPENAI_API_KEY', '')
    live_model: str = os.getenv('LIVE_MODEL', 'gpt-live-1')
    voice: str = os.getenv('LIVE_VOICE', 'marin')
    mqtt_host: str = os.getenv('MQTT_HOST', '127.0.0.1')
    mqtt_port: int = int(os.getenv('MQTT_PORT', '1883'))
    mqtt_bind: str = os.getenv('MQTT_BIND', '0.0.0.0')
    mqtt_user: str = os.getenv('MQTT_USER', 'oratoria')
    mqtt_password: str = os.getenv('MQTT_PASSWORD', '')
    device_id: str = os.getenv('DEVICE_ID', 'esp8266-oratoria')
    builtin_broker: bool = os.getenv('BUILTIN_BROKER', 'true').lower() == 'true'
    simulate_device: bool = os.getenv('SIMULATE_DEVICE', 'false').lower() == 'true'
    allow_demo: bool = os.getenv('ALLOW_DEMO', 'true').lower() == 'true'
    max_seconds: int = int(os.getenv('MAX_SESSION_SECONDS', '300'))
    data_dir: Path = BASE / os.getenv('DATA_DIR', 'data')

    @property
    def root(self):
        return f'oratoria/v1/{self.device_id}'

    def validate(self):
        if len(self.app_token) < 20 or len(self.mqtt_password) < 16:
            raise ValueError('Ejecuta tools/configurar.py para generar las credenciales locales')
        if self.live_model != 'gpt-live-1':
            raise ValueError('Este adaptador implementa GPT-Live 1; no acepta modelos de Realtime como sustitutos')
        if not 30 <= self.max_seconds <= 1800:
            raise ValueError('MAX_SESSION_SECONDS debe estar entre 30 y 1800')

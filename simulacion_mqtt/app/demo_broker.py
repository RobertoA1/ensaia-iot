"""Broker alternativo solo para verificar MQTT local cuando Docker no esta disponible."""
import asyncio
import os
from amqtt.broker import Broker

async def main():
    broker = Broker({'listeners': {'default': {'type': 'tcp',
                    'bind': f"127.0.0.1:{os.getenv('MQTT_PORT', '18883')}"}},
                    'plugins': {'amqtt.plugins.authentication.AnonymousAuthPlugin': {'allow_anonymous': True}}})
    await broker.start()
    try:
        await asyncio.Event().wait()
    finally:
        await broker.shutdown()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

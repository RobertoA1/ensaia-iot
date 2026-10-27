import argparse
import os
from pathlib import Path
from dotenv import load_dotenv

BASE=Path(__file__).resolve().parent

def main():
    parser=argparse.ArgumentParser(description='Entrenador IoT de exposiciones')
    parser.add_argument('--demo',action='store_true',help='Usar nodo virtual; no sustituye una prueba con placa')
    parser.add_argument('--localhost',action='store_true',help='HTTP solo en la laptop, permitido para microfono en localhost')
    parser.add_argument('--port',type=int,default=None)
    args=parser.parse_args()
    load_dotenv(BASE/'.env')
    if args.demo:
        os.environ['SIMULATE_DEVICE']='true'
    import uvicorn
    from app.main import app
    options={'host':'127.0.0.1' if args.localhost else '0.0.0.0',
             'port':args.port or (8765 if args.localhost else 8443),
             'ws_max_size':4096,'ws_max_queue':128}
    if not args.localhost:
        certificate=BASE/'certs/server.crt'
        private_key=BASE/'certs/server.key'
        if not certificate.exists() or not private_key.exists():
            raise SystemExit('Primero ejecuta: python tools/configurar.py --ip IP_DE_LA_LAPTOP')
        options.update(ssl_certfile=str(certificate),ssl_keyfile=str(private_key))
    uvicorn.run(app,**options)

if __name__=='__main__':
    main()

import sys
import time
from .config import Config,parser
from .client import Client,log,message,run_id

def main():
    p=parser('Publicar mensajes numerados en el laboratorio MQTT')
    p.add_argument('--interval',type=float,default=.2)
    args=p.parse_args()
    try:
        if not 1<=args.count<=10000 or not 0<=args.interval<=60:raise ValueError('Cantidad o intervalo fuera de rango')
        cfg=Config.load(args.env_file);execution=run_id(args.run_id)
        print(f'Ejecucion: {execution}. Inicia primero el suscriptor con este mismo --run-id.',flush=True)
        with Client(cfg,'pub') as client:
            for sequence in range(1,args.count+1):
                payload=message(execution,sequence);client.publish(payload)
                row={'type':'sent','topic':cfg.topic,'payload':payload}
                log(args.log_dir/f'{execution}-sent.jsonl',row)
                print(f'Enviado {sequence}/{args.count}: {payload["texto"]}',flush=True)
                if args.interval:time.sleep(args.interval)
        return 0
    except KeyboardInterrupt:return 130
    except (ValueError,ConnectionError,TimeoutError,OSError,RuntimeError) as exc:
        detail=str(exc) if isinstance(exc,(ValueError,ConnectionError,TimeoutError)) else 'Revisa configuracion, broker, autenticacion y permisos.'
        print('No se completo la publicacion. '+detail,file=sys.stderr)
        return 1

if __name__=='__main__':raise SystemExit(main())

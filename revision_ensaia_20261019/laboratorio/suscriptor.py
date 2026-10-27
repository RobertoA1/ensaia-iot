import json
import queue
import sys
import time
from .config import Config,parser
from .client import Client,decoded,log,message,run_id

def main():
    p=parser('Suscriptor MQTT; confirma suscripcion antes de iniciar el publicador')
    p.add_argument('--duration',type=float,default=60,help='Segundos para recibir; reconecta automaticamente durante este plazo')
    args=p.parse_args()
    try:
        if not 1<=args.count<=10000 or not 0<args.duration<=3600:raise ValueError('Cantidad o duracion fuera de rango')
        cfg=Config.load(args.env_file);execution=run_id(args.run_id)
        seen=set();duplicates=0;errors=0
        with Client(cfg,'sub',subscribe=True) as client:
            print(f'SUSCRIPCION CONFIRMADA: {cfg.topic}; ejecucion {execution}',flush=True)
            deadline=time.monotonic()+args.duration
            while time.monotonic()<deadline and len(seen)<args.count:
                try:row=client.inbox.get(timeout=min(.2,max(.001,deadline-time.monotonic())))
                except queue.Empty:continue
                try:row=decoded(row)
                except (ValueError,UnicodeError):errors+=1;continue
                payload=row['payload']
                if not isinstance(payload,dict) or payload.get('ejecucion')!=execution:continue
                log(args.log_dir/f'{execution}-received.jsonl',row)
                sequence=payload.get('secuencia')
                if type(sequence)!=int or not 1<=sequence<=args.count or payload!=message(execution,sequence) or row['retained']:
                    errors+=1
                else:
                    duplicates+=int(sequence in seen);seen.add(sequence)
                print(json.dumps(row,ensure_ascii=False),flush=True)
            summary={'type':'summary','ejecucion':execution,'received':len(seen),'missing':sorted(set(range(1,args.count+1))-seen),
                'duplicates':duplicates,'errors':errors,'disconnects':client.disconnects,'dropped':client.dropped}
            log(args.log_dir/f'{execution}-received.jsonl',summary)
            print(json.dumps(summary,ensure_ascii=False))
            return 0 if len(seen)==args.count and not duplicates and not errors and not client.dropped else 1
    except KeyboardInterrupt:return 130
    except (ValueError,ConnectionError,TimeoutError,OSError,RuntimeError) as exc:
        detail=str(exc) if isinstance(exc,(ValueError,ConnectionError,TimeoutError)) else 'Revisa configuracion, broker, autenticacion y permisos.'
        print('Suscriptor no disponible. '+detail,file=sys.stderr)
        return 1

if __name__=='__main__':raise SystemExit(main())

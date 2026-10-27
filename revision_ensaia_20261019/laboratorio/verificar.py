"""Dos clientes TCP reales; el informe no presume que el broker sea EMQX."""
from dataclasses import replace
import json
import queue
import sys
import time
from uuid import uuid4
from .config import Config,parser
from .client import Client,decoded,log,message,run_id

def authentication(config,anonymous=False):
    invalid=replace(config,password=uuid4().hex)
    probe=Client(invalid,'auth-negative',credentials=not anonymous)
    try:
        probe.start()
        return {'passed':False,'reason':'El broker acepto una conexion que debia rechazar'}
    except ConnectionError:
        return {'passed':probe.rejected.is_set(),'reason':'Rechazo explicito del broker' if probe.rejected.is_set() else 'Sin respuesta; no prueba rechazo de autenticacion'}
    finally:probe.close()

def verify(config,execution,count=10,log_dir=None,security=False):
    report={'execution':execution,'topic':config.topic,'qos':config.qos,'broker_identity':'No comprobada por el protocolo MQTT',
        'sent':0,'received':0,'missing':list(range(1,count+1)),'duplicates':0,'errors':[],
        'disconnects':0,'dropped':0,'other_topic_isolated':False,'passed':False}
    seen=set()
    try:
        with Client(config,'verify-sub',subscribe=True) as sub,Client(config,'verify-pub') as pub:
            for sequence in range(1,count+1):
                payload=message(execution,sequence);pub.publish(payload);report['sent']+=1
                if log_dir:log(log_dir/f'{execution}-wire.jsonl',{'type':'sent','topic':config.topic,'payload':payload})
            # Un topico distinto, dentro del espacio autorizado del laboratorio.
            pub.publish({'ejecucion':execution,'probe':'other_topic'},topic=config.topic+'/otro')
            deadline=time.monotonic()+config.timeout;settle=None;leaked=False
            while time.monotonic()<deadline:
                if settle is not None and time.monotonic()>=settle:break
                try:row=sub.inbox.get(timeout=.05)
                except queue.Empty:continue
                try:row=decoded(row)
                except (ValueError,UnicodeError):report['errors'].append('Mensaje no JSON');continue
                payload=row['payload']
                if not isinstance(payload,dict) or payload.get('ejecucion')!=execution:continue
                if log_dir:log(log_dir/f'{execution}-wire.jsonl',{'type':'received',**row})
                if row['topic']!=config.topic or payload.get('probe')=='other_topic':leaked=True;continue
                sequence=payload.get('secuencia')
                if type(sequence)!=int or not 1<=sequence<=count or payload!=message(execution,sequence) or row['retained']:
                    report['errors'].append('Contenido, secuencia o retained incorrecto');continue
                report['duplicates']+=int(sequence in seen);seen.add(sequence)
                if len(seen)==count and settle is None:settle=time.monotonic()+min(.5,config.timeout/2)
            report.update(received=len(seen),missing=sorted(set(range(1,count+1))-seen),
                disconnects=sub.disconnects+pub.disconnects,dropped=sub.dropped,
                other_topic_isolated=not leaked)
            if security:
                report['authentication']={'wrong_password':authentication(config),'anonymous':authentication(config,True)}
            report['passed']=(report['sent']==count and len(seen)==count and not report['duplicates'] and not report['errors']
                and not report['disconnects'] and not report['dropped'] and not leaked
                and all(v['passed'] for v in report.get('authentication',{}).values()))
    except (ConnectionError,TimeoutError,OSError,RuntimeError):
        report['errors'].append('No se completo la conexion o envio MQTT. Revisa servicio, host, puerto, autenticacion y permisos.')
    if log_dir:
        log(log_dir/f'{execution}-report.jsonl',report)
    return report

def main():
    p=parser('Verificador MQTT con dos clientes reales y mensajes aislados por ejecucion')
    p.add_argument('--security',action='store_true',help='Exige rechazo de contrasena incorrecta y acceso anonimo')
    args=p.parse_args()
    try:
        if not 1<=args.count<=10000:raise ValueError('Cantidad fuera de rango')
        cfg=Config.load(args.env_file);execution=run_id(args.run_id)
        report=verify(cfg,execution,args.count,args.log_dir,args.security)
        print(json.dumps(report,ensure_ascii=False,indent=2))
        return 0 if report['passed'] else 1
    except (ValueError,OSError):
        print('Configuracion o ruta de salida invalida. Copia laboratorio/.env.example y completa los datos.',file=sys.stderr)
        return 2
    except KeyboardInterrupt:return 130

if __name__=='__main__':raise SystemExit(main())

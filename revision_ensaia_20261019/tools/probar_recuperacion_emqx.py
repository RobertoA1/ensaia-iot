"""Prueba explicita de corte/reinicio SOLO del contenedor EMQX de este proyecto."""
import json
import subprocess
import time
from laboratorio.client import Client,log,message,run_id
from laboratorio.config import Config
from .preparar_emqx import BASE

COMPOSE=['docker','compose','-f',str(BASE/'infra/emqx/compose.yaml')]

def wait_for(predicate,seconds):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if predicate():return
        time.sleep(.1)
    raise TimeoutError('No se observo el cambio de estado esperado')

def main():
    cfg=Config.load(BASE/'laboratorio/.env');execution=run_id()
    report={'execution':execution,'passed':False,'before_received':False,'cut_observed':False,
        'after_received':False,'lost_during_cut':'No cuantificable; no se publicaron mensajes durante el corte (QoS 0)'}
    try:
        with Client(cfg,'restart-sub',subscribe=True) as sub,Client(cfg,'restart-pub') as pub:
            pub.publish(message(execution,1));before=sub.inbox.get(timeout=cfg.timeout)
            report['before_received']=json.loads(before['raw'])==message(execution,1)
            try:
                subprocess.run(COMPOSE+['stop','emqx'],check=True,stdout=subprocess.DEVNULL,timeout=40)
                wait_for(lambda:not sub.connected.is_set() and not pub.connected.is_set(),8)
                report['cut_observed']=True
            finally:
                # Restablecer servicio incluso si la observacion del corte falla.
                subprocess.run(COMPOSE+['up','-d','emqx'],check=True,stdout=subprocess.DEVNULL,timeout=40)
            wait_for(lambda:sub.ready.is_set() and pub.ready.is_set(),90)
            pub.publish(message(execution,2));after=sub.inbox.get(timeout=cfg.timeout)
            report['after_received']=json.loads(after['raw'])==message(execution,2)
            time.sleep(.5)
            report['duplicate_after_restart']=not sub.inbox.empty()
            report['disconnects']=sub.disconnects+pub.disconnects
            report['passed']=report['before_received'] and report['cut_observed'] and report['after_received'] and not report['duplicate_after_restart']
    except Exception:
        report['error']='No se completo el corte/recuperacion; consultar estado de Docker y broker'
    log(BASE/'evidencias/emqx'/f'{execution}-recovery.jsonl',report)
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report['passed'] else 1

if __name__=='__main__':raise SystemExit(main())

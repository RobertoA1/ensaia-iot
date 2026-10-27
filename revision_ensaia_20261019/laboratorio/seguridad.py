"""Pruebas negativas MQTT 5: exige rechazo explicito, no presume permisos por silencio."""
from dataclasses import replace
import json
import sys
import paho.mqtt.client as mqtt
from .config import Config,parser
from .client import Client,log,run_id
from .verificar import authentication

def verify_security(cfg,execution):
    report={'execution':execution,'wrong_password':authentication(cfg),'anonymous':authentication(cfg,True),
        'forbidden_subscription':False,'forbidden_publish':False,'passed':False,
        'note':'Requiere MQTT 5, denegacion explicita de ACL y ausencia de reglas generales allow.'}
    denied=replace(cfg,topic='laboratorio_restringido/oratoria/prueba',qos=1)
    sub=Client(denied,'acl-sub',subscribe=True,protocol=mqtt.MQTTv5)
    try:
        sub.start()
    except ConnectionError:
        report['forbidden_subscription']=sub.subscription_rejected
    finally:sub.close()
    try:
        with Client(denied,'acl-pub',protocol=mqtt.MQTTv5) as pub:
            try:pub.publish({'execution':execution,'test':'denied'})
            except PermissionError:report['forbidden_publish']=True
    except (ConnectionError,TimeoutError,OSError,RuntimeError):
        report['publish_error']='Sin rechazo explicito verificable'
    report['passed']=(report['wrong_password']['passed'] and report['anonymous']['passed']
        and report['forbidden_subscription'] and report['forbidden_publish'])
    return report

def main():
    p=parser('Comprobar rechazo de acceso anonimo, contrasena incorrecta y topicos no permitidos')
    args=p.parse_args()
    try:
        cfg=Config.load(args.env_file);execution=run_id(args.run_id)
        report=verify_security(cfg,execution)
        log(args.log_dir/f'{execution}-security.jsonl',report)
        print(json.dumps(report,ensure_ascii=False,indent=2))
        return 0 if report['passed'] else 1
    except (ValueError,ConnectionError,TimeoutError,OSError,RuntimeError):
        print('No se completo la prueba de seguridad. Revisa broker, MQTT 5 y configuracion.',file=sys.stderr)
        return 2
    except KeyboardInterrupt:return 130

if __name__=='__main__':raise SystemExit(main())

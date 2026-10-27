"""Registra version, clientes, suscripciones y contadores reales, sin tokens ni claves."""
from contextlib import ExitStack
import json
from pathlib import Path
import time
from urllib.request import Request,urlopen
from laboratorio.config import Config
from laboratorio.client import Client,message,run_id

BASE=Path(__file__).resolve().parents[1]

def snapshot():
    credentials=json.loads((BASE/'infra/emqx/private/credentials.json').read_text(encoding='utf-8'))
    base='http://127.0.0.1:18083/api/v5'
    login=Request(base+'/login',data=json.dumps({'username':'admin','password':credentials['dashboard_password']}).encode(),
        headers={'Content-Type':'application/json'},method='POST')
    with urlopen(login,timeout=10) as response:token=json.load(response)['token']
    def get(path):
        with urlopen(Request(base+path,headers={'Authorization':'Bearer '+token}),timeout=10) as response:return json.load(response)
    config=Config.load(BASE/'laboratorio/.env');execution=run_id()
    with ExitStack() as stack:
        sub=stack.enter_context(Client(config,'evidence-sub',subscribe=True))
        pub=stack.enter_context(Client(config,'evidence-pub'))
        before=get('/stats')
        for i in range(1,11):pub.publish(message(execution,i))
        for _ in range(10):sub.inbox.get(timeout=config.timeout)
        time.sleep(1)
        # Seleccion de campos: no exportar usuarios del Dashboard, API keys ni secretos.
        nodes=get('/nodes');clients=get('/clients');subscriptions=get('/subscriptions')
        report={'execution':execution,'product':'EMQX (API del broker)',
            'nodes':[{k:n.get(k) for k in ('node','version','node_status','uptime')} for n in nodes],
            'clients':[{k:c.get(k) for k in ('clientid','connected','subscriptions_cnt')} for c in clients.get('data',[])],
            'subscriptions':[{k:s.get(k) for k in ('clientid','topic','qos')} for s in subscriptions.get('data',[])],
            'stats_before':before,'stats_after':get('/stats'),'metrics':get('/metrics')}
    path=BASE/'evidencias/emqx/broker_snapshot.json';path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Evidencia real guardada en evidencias/emqx/broker_snapshot.json. Sin claves ni tokens.')

if __name__=='__main__':
    try:snapshot()
    except Exception:
        raise SystemExit('No se pudo obtener evidencia: revisa EMQX, credenciales del panel y configuracion del laboratorio.') from None

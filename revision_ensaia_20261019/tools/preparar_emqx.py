"""Genera archivos privados una sola vez; conserva el .env y las credenciales existentes."""
import argparse
import csv
import io
import json
from pathlib import Path
import re
import secrets
from dotenv import dotenv_values

BASE=Path(__file__).resolve().parents[1]

def private_write(path,text):
    # Nunca reemplazar credenciales que ya se hayan usado para inicializar el volumen.
    if path.exists():return
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x',encoding='utf-8',newline='') as f:f.write(text)
    path.chmod(0o600)

def prepare(base=BASE,port=1884):
    if not 1<=port<=65535:raise ValueError('Puerto fuera de rango')
    source=dotenv_values(base/'.env')
    infra=base/'infra/emqx';private=infra/'private'
    private.mkdir(parents=True,exist_ok=True)
    state_file=private/'credentials.json'
    if state_file.exists():state=json.loads(state_file.read_text(encoding='utf-8'))
    else:
        state={'dashboard_password':secrets.token_urlsafe(24),'lab_password':secrets.token_urlsafe(24),
            'project_user':source.get('MQTT_USER') or 'oratoria',
            'project_password':source.get('MQTT_PASSWORD') or secrets.token_urlsafe(24),
            'device_id':source.get('DEVICE_ID') or 'esp8266-oratoria','mqtt_port':port}
        for value in [state['project_user'],state['device_id']]:
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',value):raise ValueError('Usuario o ID no compatible con las reglas de laboratorio')
        private_write(state_file,json.dumps(state,indent=2))
    if 'node_cookie' not in state:
        state['node_cookie']=secrets.token_hex(32)
        state_file.write_text(json.dumps(state,indent=2),encoding='utf-8')
    private_write(private/'node.env',f'EMQX_NODE__COOKIE={state["node_cookie"]}\n')
    private_write(infra/'.env',f'EMQX_MQTT_PORT={state["mqtt_port"]}\nEMQX_DASHBOARD_PASSWORD={state["dashboard_password"]}\n')
    buffer=io.StringIO();writer=csv.writer(buffer);writer.writerow(['user_id','password','is_superuser'])
    writer.writerow(['laboratorio',state['lab_password'],'false'])
    writer.writerow([state['project_user'],state['project_password'],'false'])
    private_write(private/'users.csv',buffer.getvalue())
    user=json.dumps(state['project_user']);topic=json.dumps('oratoria/v1/'+state['device_id']+'/#')
    private_write(private/'acl.conf','{allow, {username, "laboratorio"}, all, ["laboratorio/oratoria/#"]}.\n'
        +f'{{allow, {{username, {user}}}, all, [{topic}]}}.\n'+'{deny, all}.\n')
    private_write(base/'laboratorio/.env',f'MQTT_HOST=127.0.0.1\nMQTT_PORT={state["mqtt_port"]}\nMQTT_USER=laboratorio\n'
        +f'MQTT_PASSWORD={state["lab_password"]}\nMQTT_TOPIC=laboratorio/oratoria/prueba\nMQTT_QOS=0\nMQTT_TIMEOUT=10\n')
    values={**source,'MQTT_HOST':'127.0.0.1','MQTT_PORT':str(state['mqtt_port']),
        'MQTT_USER':state['project_user'],'MQTT_PASSWORD':state['project_password'],
        'DEVICE_ID':state['device_id'],'BUILTIN_BROKER':'false',
        'APP_TOKEN':source.get('APP_TOKEN') or secrets.token_urlsafe(30)}
    private_write(base/'.env.emqx',''.join(f'{key}={json.dumps(str(value or ""))}\n' for key,value in values.items()))
    return state['mqtt_port']

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--port',type=int,default=1884);args=p.parse_args()
    port=prepare(port=args.port)
    print(f'Archivos privados preparados/conservados. MQTT: {port}. Panel: http://localhost:18083')
    print('Usuario panel: admin. Contrasena: infra/emqx/private/credentials.json (dashboard_password).')
    print('No se imprimieron claves. El .env habitual y secrets.h se conservan.')

if __name__=='__main__':main()

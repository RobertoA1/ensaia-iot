"""Actualiza SOLO MQTT de secrets.h; conserva Wi-Fi y crea respaldo privado."""
import argparse
import ipaddress
import json
from pathlib import Path
import re
from dotenv import dotenv_values
from .preparar_emqx import BASE,private_write

def configure(ip,base=BASE):
    address=ipaddress.ip_address(ip)
    if address.version!=4 or address.is_loopback or not address.is_private:
        raise ValueError('Indica la IPv4 privada de la laptop en Wi-Fi, no localhost')
    values=dotenv_values(base/'.env.emqx')
    path=base/'firmware/EntrenadorESP8266/secrets.h'
    content=path.read_text(encoding='utf-8')
    replacements={'MQTT_HOST':str(address),'MQTT_USER':values['MQTT_USER'],
        'MQTT_PASSWORD':values['MQTT_PASSWORD'],'DEVICE_ID':values['DEVICE_ID']}
    updated=content
    for key,value in replacements.items():
        updated,n=re.subn(r'(static const char '+key+r'\[\]\s*=\s*)"(?:\\.|[^"\\])*"',
            lambda m:m[1]+json.dumps(value,ensure_ascii=True),updated)
        if n!=1:raise ValueError('No se encontro una unica declaracion de '+key)
    port=int(values['MQTT_PORT'])
    if not 1<=port<=65535:raise ValueError('Puerto invalido')
    updated,n=re.subn(r'(static const uint16_t MQTT_PORT\s*=\s*)\d+',lambda m:m[1]+str(port),updated)
    if n!=1:raise ValueError('No se encontro MQTT_PORT')
    private_write(base/'infra/emqx/private/secrets.previous.h',content)
    path.write_text(updated,encoding='utf-8')

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--ip',required=True);args=p.parse_args()
    configure(args.ip)
    print('MQTT actualizado en secrets.h; Wi-Fi conservado. Falta compilar y subir fisicamente a la placa.')

if __name__=='__main__':main()

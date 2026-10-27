"""Genera credenciales del piloto y una CA local para HTTPS; no instala certificados."""
import argparse
from datetime import datetime,timezone,timedelta
import ipaddress
from pathlib import Path
import secrets
import re
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from dotenv import dotenv_values

BASE=Path(__file__).resolve().parents[1]

def save_key(path,key):
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,
                                      serialization.NoEncryption()))
    path.chmod(0o600)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--ip',required=True,help='IPv4 privada de la laptop en la misma Wi-Fi del celular y ESP')
    args=parser.parse_args()
    address=ipaddress.ip_address(args.ip)
    if address.version!=4:
        raise SystemExit('Este prototipo usa una direccion IPv4 local')
    env_path=BASE/'.env'
    if not env_path.exists():
        template=(BASE/'.env.example').read_text()
        template=template.replace('APP_TOKEN=CAMBIAR','APP_TOKEN='+secrets.token_urlsafe(30))
        template=template.replace('MQTT_PASSWORD=CAMBIAR','MQTT_PASSWORD='+secrets.token_urlsafe(24))
        env_path.write_text(template)
        env_path.chmod(0o600)
    config=dotenv_values(env_path)
    certs=BASE/'certs'
    certs.mkdir(exist_ok=True)
    ca_file,ca_key_file=certs/'root-ca.crt',certs/'root-ca.key'
    if ca_file.exists() and ca_key_file.exists():
        ca=x509.load_pem_x509_certificate(ca_file.read_bytes())
        ca_key=serialization.load_pem_private_key(ca_key_file.read_bytes(),password=None)
    else:
        ca_key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Oratoria - CA local del laboratorio')])
        now=datetime.now(timezone.utc)
        ca=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1))
            .not_valid_after(now+timedelta(days=365))
            .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True,key_encipherment=False,key_cert_sign=True,
                crl_sign=True,content_commitment=False,data_encipherment=False,key_agreement=False,
                encipher_only=None,decipher_only=None),critical=True).sign(ca_key,hashes.SHA256()))
        save_key(ca_key_file,ca_key)
        ca_file.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    now=datetime.now(timezone.utc)
    name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,args.ip)])
    cert=(x509.CertificateBuilder().subject_name(name).issuer_name(ca.subject).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1))
        .not_valid_after(now+timedelta(days=90))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(address),
            x509.IPAddress(ipaddress.ip_address('127.0.0.1')),x509.DNSName('localhost')]),critical=False)
        .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),critical=False)
        .sign(ca_key,hashes.SHA256()))
    save_key(certs/'server.key',key)
    (certs/'server.crt').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    firmware=BASE/'firmware/EntrenadorESP8266/secrets.h'
    if not firmware.exists():
        content=(firmware.parent/'secrets.example.h').read_text()
        content=content.replace('192.168.1.10',args.ip).replace('CLAVE_MQTT_GENERADA',config['MQTT_PASSWORD'])
        firmware.write_text(content)
        firmware.chmod(0o600)
    else:
        # Cambiar la IP conserva las credenciales Wi-Fi que ya haya ingresado el usuario.
        content=firmware.read_text()
        content=re.sub(r'(static const char MQTT_HOST\[\] = ")[^"]*(")',
                       lambda match:match.group(1)+args.ip+match.group(2),content)
        firmware.write_text(content)
    print(f'HTTPS del celular: https://{args.ip}:8443')
    print('Credenciales conservadas en .env; edita OPENAI_API_KEY y los datos Wi-Fi de secrets.h.')
    print('Instala SOLO certs/root-ca.crt como CA de confianza en tu celular de pruebas.')
    print('No compartas .env, secrets.h ni archivos .key. No se han instalado certificados en el sistema.')

if __name__=='__main__':
    main()

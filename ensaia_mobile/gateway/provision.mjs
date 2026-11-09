import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [host, deviceId = 'ensaia-mobile'] = process.argv.slice(2);
if (!host || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(host) || !/^[a-z0-9_-]{3,32}$/.test(deviceId)) {
  console.error('Uso: npm run provision -- IP_DE_LA_PC [id-del-dispositivo]');
  process.exit(1);
}

const gitOpenSsl = join(process.env.ProgramFiles || 'C:/Program Files', 'Git/mingw64/bin/openssl.exe');
const openssl = process.env.OPENSSL || (existsSync(gitOpenSsl) ? gitOpenSsl : 'openssl');
const privateDir = join(root, '.private');
const lab = join(privateDir, 'lab');
const certs = join(root, 'certs');
const write = (path, content) => writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
const secret = () => randomBytes(24).toString('hex');

function exportCa() {
  mkdirSync(certs, { recursive: true });
  copyFileSync(join(lab, 'broker-ca.crt'), join(certs, 'broker-ca.crt'));
  copyFileSync(join(lab, 'broker-host.txt'), join(certs, 'broker-host.txt'));
}

if (existsSync(lab)) {
  exportCa();
  console.log('Se conservó la configuración existente de .private/lab. La CA pública está en certs/.');
  process.exit(0);
}

mkdirSync(privateDir, { recursive: true });
const stage = mkdtempSync(join(privateDir, 'setup-'));
const broker = join(stage, 'broker');
mkdirSync(broker);
try {
  const run = (...args) => execFileSync(openssl, args, { cwd: stage, stdio: ['ignore', 'ignore', 'pipe'] });
  write(join(stage, 'request.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
  const subjectAltName = `${isIP(host) ? 'IP' : 'DNS'}:${host}`;
  write(join(stage, 'server.ext'), `subjectAltName=${subjectAltName}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  run('req', '-config', 'request.cnf', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365', '-keyout', 'ca.key',
    '-out', 'broker-ca.crt', '-subj', '/CN=ENSAIA Laboratorio MQTT', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  run('req', '-config', 'request.cnf', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'broker/server.key',
    '-out', 'server.csr', '-subj', `/CN=${host}`);
  run('x509', '-req', '-sha256', '-days', '365', '-in', 'server.csr', '-CA', 'broker-ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-extfile', 'server.ext', '-out', 'broker/server.crt');
  for (const name of ['request.cnf', 'server.ext', 'server.csr', 'broker-ca.srl', 'ca.key']) unlinkSync(join(stage, name));

  const mobilePassword = secret();
  const gatewayPassword = secret();
  const cloudSecret = secret();
  const cloudUsername = `ensaia_m_${randomBytes(4).toString('hex')}`;
  const endpoint = `wss://${host}:8084/mqtt`;
  const prefix = `ensaia/v1/${deviceId}/mobile`;
  write(join(broker, 'users.csv'), `user_id,password,is_superuser\nmobile,${mobilePassword},false\ngateway,${gatewayPassword},false\n`);
  write(join(broker, 'acl.conf'), [
    `{allow, {username, "mobile"}, publish, ["${prefix}/command"]}.`,
    `{allow, {username, "mobile"}, subscribe, ["${prefix}/state", "${prefix}/result"]}.`,
    `{allow, {username, "gateway"}, subscribe, ["${prefix}/command"]}.`,
    `{allow, {username, "gateway"}, publish, ["${prefix}/state", "${prefix}/result"]}.`,
    '{deny, all}.',
  ].join('\n') + '\n');
  write(join(stage, 'broker.env'), `ENSAIA_BROKER_BIND=${isIP(host) === 4 ? host : '0.0.0.0'}\n` +
    `EMQX_NODE__COOKIE=${secret()}\nEMQX_DASHBOARD__DEFAULT_PASSWORD=${secret()}\n`);
  write(join(stage, 'gateway.env'), `MQTT_URL=${endpoint}\nMQTT_USERNAME=gateway\nMQTT_PASSWORD=${gatewayPassword}\n` +
    'MQTT_CA_FILE=.private/lab/broker-ca.crt\nENSAIA_CLOUD_URL=https://ensaia-oratoria.vercel.app\n' +
    `ENSAIA_DEVICE_ID=${deviceId}\nENSAIA_DEVICE_SECRET=${cloudSecret}\nENSAIA_USERNAME=${cloudUsername}\n` +
    `ENSAIA_PASSWORD=${secret()}\nENSAIA_MODE=live\n`);
  write(join(stage, 'mobile.json'), JSON.stringify({ url: endpoint, deviceId, username: 'mobile', password: mobilePassword }, null, 2));
  write(join(stage, 'device-secrets.json'), JSON.stringify({ [deviceId]: createHash('sha256').update(cloudSecret).digest('hex') }, null, 2));
  write(join(stage, 'broker-host.txt'), `${host}\n`);
  renameSync(stage, lab);
  exportCa();
  console.log('Configuración preparada en .private/lab. Usa mobile.json en el teléfono y registra device-secrets.json en ENSAIA.');
} catch (error) {
  if (existsSync(stage)) {
    for (const name of readdirSync(broker)) unlinkSync(join(broker, name));
    rmdirSync(broker);
    for (const name of readdirSync(stage)) unlinkSync(join(stage, name));
    rmdirSync(stage);
  }
  const opensslError = error.stderr?.toString().trim().split(/\r?\n/).at(-1);
  console.error(`No se pudo preparar el laboratorio: ${opensslError || error.code || 'revisa OpenSSL'}.`);
  process.exitCode = 1;
}

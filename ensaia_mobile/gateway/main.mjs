import { readFileSync } from 'node:fs';
import { connect } from 'mqtt';
import { topics } from '../protocol.ts';
import { CloudApi, VirtualDevice } from './cloud.mjs';
import { MobileControl } from './control.mjs';

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Falta ${key} en .private/lab/gateway.env.`);
  return value;
};

const cloud = new URL(required('ENSAIA_CLOUD_URL'));
const localCloud = cloud.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(cloud.hostname);
if (!localCloud && cloud.protocol !== 'https:') throw new Error('ENSAIA_CLOUD_URL debe usar HTTPS.');
const broker = new URL(required('MQTT_URL'));
if (broker.protocol !== 'wss:') throw new Error('MQTT_URL debe usar WSS.');
const mode = process.env.ENSAIA_MODE || 'live';
if (!['live', 'whisper'].includes(mode)) throw new Error('ENSAIA_MODE debe ser live o whisper.');

const origin = cloud.origin;
const deviceId = required('ENSAIA_DEVICE_ID');
const username = required('ENSAIA_USERNAME');
const password = required('ENSAIA_PASSWORD');
const secret = required('ENSAIA_DEVICE_SECRET');
const routes = topics(deviceId);
const device = new VirtualDevice({ origin, deviceId, secret, username, password });
const api = new CloudApi(origin, username, password);
const offline = JSON.stringify({ online: false, at: 0, session: null });
const mqtt = connect(broker.href, {
  clientId: `gateway-${deviceId}`,
  username: required('MQTT_USERNAME'),
  password: required('MQTT_PASSWORD'),
  protocolVersion: 5,
  clean: true,
  resubscribe: false,
  reconnectPeriod: 3_000,
  connectTimeout: 8_000,
  ...(process.env.MQTT_CA_FILE && { wsOptions: { ca: readFileSync(process.env.MQTT_CA_FILE) } }),
  will: { topic: routes.state, payload: offline, qos: 1, retain: true },
});

const control = new MobileControl({
  api, device, deviceId, mode,
  publishState: (state) => {
    if (mqtt.connected) mqtt.publish(routes.state, JSON.stringify(state), {
      qos: 1, retain: true, properties: { messageExpiryInterval: 8 },
    });
  },
  publishResult: (result) => {
    if (mqtt.connected) mqtt.publish(routes.result, JSON.stringify(result), {
      qos: 1, properties: { messageExpiryInterval: 15 },
    });
  },
});

mqtt.on('connect', () => {
  mqtt.subscribe(routes.command, { qos: 1, rap: true, rh: 2 }, (error, grants) => {
    if (error || grants?.[0]?.qos !== 1) {
      console.error('EMQX rechazó la suscripción de la pasarela. Revisa su ACL.');
      void shutdown(1);
      return;
    }
    console.log(`Pasarela MQTT conectada para ${deviceId}.`);
    control.broadcast();
    void control.poll();
  });
});
mqtt.on('message', (topic, data, packet) => {
  if (topic === routes.command) void control.receive(data.toString(), packet.retain);
});
mqtt.on('error', (error) => console.error('Error MQTT de la pasarela:', error.message));

device.connect();
const timer = setInterval(() => void control.poll(), 2_000);

async function shutdown(code = 0) {
  clearInterval(timer);
  device.close();
  if (mqtt.connected) {
    const timeout = setTimeout(() => mqtt.end(true), 2_000);
    try { await mqtt.publishAsync(routes.state, offline, { qos: 1, retain: true }); }
    catch { /* Si el broker se perdió, la presencia también caduca en el móvil. */ }
    finally { clearTimeout(timeout); }
  }
  mqtt.end(true);
  process.exitCode = code;
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

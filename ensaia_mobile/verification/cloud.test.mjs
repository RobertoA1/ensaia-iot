import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { connectAsync } from 'mqtt';
import { makeFrame } from '../gateway/cloud.mjs';
import { parseResult, parseState, requestLifetime, topics } from '../protocol.ts';
import { startCloudSandbox } from './cloud-sandbox.mjs';

async function waitFor(read, timeout = 18_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = read();
    if (value) return value;
    await delay(40);
  }
  throw new Error('Tiempo agotado esperando el estado de la práctica por MQTT');
}

test('EMQX ↔ pasarela ↔ ENSAIA real con Redis local', { timeout: 45_000 }, async (t) => {
  const { ENSAIA_DEVICE_ID: deviceId, ENSAIA_DEVICE_SECRET: secret, ENSAIA_USERNAME: username,
    ENSAIA_PASSWORD: password, MQTT_CA_FILE: caPath } = process.env;
  const lab = JSON.parse(readFileSync('.private/lab/mobile.json', 'utf8'));
  const sandbox = await startCloudSandbox({ deviceId, secret });
  const gateway = spawn(process.execPath, ['--experimental-strip-types', 'gateway/main.mjs'], {
    env: { ...process.env, ENSAIA_MODE: 'whisper', ENSAIA_CLOUD_URL: sandbox.origin },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let mqtt, sid;
  const status = [], results = [];
  const route = topics(deviceId);
  const send = (value, retain = false) => mqtt.publishAsync(route.command, JSON.stringify(value), { qos: 1, retain });
  const request = (action, options) => fetch(`${sandbox.origin}/api/server?action=${action}`, options);
  const start = { id: 'android-qa-start', op: 'start', sentAt: 0, title: 'Laboratorio MQTT', seconds: 30, consent: true };
  const result = (id) => waitFor(() => results.find((value) => value.id === id));

  try {
    await t.test('conexión MQTT 5 por WSS y presencia del dispositivo autorizado', async () => {
      const options = { protocolVersion: 5, username: lab.username, password: lab.password,
        wsOptions: { ca: readFileSync(caPath) }, reconnectPeriod: 0, connectTimeout: 5_000 };
      mqtt = await connectAsync(lab.url, options, false);
      mqtt.on('message', (topic, data) => {
        if (topic === route.state) {
          const value = parseState(data.toString());
          if (value) status.push(value);
        } else if (topic === route.result) {
          const value = parseResult(data.toString());
          if (value) results.push(value);
        }
      });
      assert.deepEqual((await mqtt.subscribeAsync([route.state, route.result], { qos: 1 })).map((x) => x.qos), [1, 1]);
      await waitFor(() => status.at(-1)?.online);
      assert.equal((await request('history')).status, 401);
    });

    await t.test('comandos vencidos, retenidos o sin consentimiento no crean una práctica', async () => {
      try {
        await send({ ...start, id: 'android-qa-expired', sentAt: Date.now() - requestLifetime - 500 });
        await send({ ...start, id: 'android-qa-retained', sentAt: Date.now() }, true);
        await send({ ...start, id: 'android-qa-denied', sentAt: Date.now(), consent: false });
        const snapshots = status.length;
        await waitFor(() => status.length > snapshots);
        assert.equal(status.at(-1).session, null);
        assert.equal(results.length, 0);
      } finally {
        await mqtt.publishAsync(route.command, '', { qos: 1, retain: true });
      }
    });

    await t.test('inicia desde MQTT, deduplica el inicio y rechaza detener otra sesión', async () => {
      start.sentAt = Date.now();
      await send(start);
      assert.equal((await result(start.id)).ok, true);
      const recording = await waitFor(() => status.at(-1)?.session?.status === 'recording' && status.at(-1).session);
      sid = recording.id;
      await send(start);
      await waitFor(() => results.filter((value) => value.id === start.id).length === 2);
      assert.equal(status.at(-1).session.id, sid);
      await send({ id: 'android-qa-wrong-session', op: 'stop', sid: '0000000000000000', sentAt: Date.now() });
      assert.equal((await result('android-qa-wrong-session')).ok, false);
      assert.equal(status.at(-1).session.status, 'recording');
    });

    await t.test('detiene desde MQTT y ENSAIA devuelve el WAV íntegro en su historial', async () => {
      assert.ok(sid, 'Falta la práctica iniciada en la prueba anterior');
      await send({ id: 'android-qa-stop', op: 'stop', sid, sentAt: Date.now() });
      assert.equal((await result('android-qa-stop')).ok, true);
      await waitFor(() => status.at(-1)?.session?.status === 'completed' && status.at(-1).session.audioSaved);

      const login = await request('login', { method: 'POST', headers: {
        Origin: sandbox.origin, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ username, password }) });
      assert.equal(login.status, 200);
      const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
      const history = await (await request('history', { headers })).json();
      assert.equal(history.sessions.length, 1);
      assert.equal(history.sessions[0].id, sid);
      assert.equal(history.sessions[0].title, '[Demo MQTT] Laboratorio MQTT');
      const report = await (await request(`presentation&id=${sid}`, { headers })).json();
      assert.equal(report.sourceComplete, true);
      assert.equal(report.providerFinalized, true);
      assert.equal(report.archived, true);
      assert.ok(report.metrics.frames > 0);

      const response = await request(`audio&id=${sid}`, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'audio/wav');
      const wav = Buffer.from(await response.arrayBuffer());
      assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
      assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
      assert.equal(wav.readUInt32LE(24), 16_000);
      const expected = Buffer.concat(Array.from({ length: report.metrics.frames }, (_, seq) => makeFrame(sid, seq).subarray(24)));
      assert.equal(wav.readUInt32LE(40), expected.length);
      assert.equal(sandbox.audio.get(sid), expected.length);
      assert.deepEqual(wav.subarray(44), expected);
    });

    await t.test('el broker avisa cuando la pasarela se desconecta', async () => {
      assert.equal(status.at(-1).online, true);
      const closed = once(gateway, 'exit');
      gateway.kill();
      await closed;
      await waitFor(() => status.at(-1)?.online === false);
      assert.equal(status.at(-1).at, 0);
      const health = await request('health');
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
    });
  } finally {
    mqtt?.end(true);
    if (gateway.exitCode === null && gateway.signalCode === null) {
      const exit = once(gateway, 'exit');
      gateway.kill();
      await exit;
    }
    await sandbox.close();
  }
});

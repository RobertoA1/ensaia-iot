import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { connectAsync } from 'mqtt';
import { WebSocketServer } from 'ws';
import { parseCommand, parseState, requestLifetime, topics } from '../protocol.ts';
import { CloudApi, VirtualDevice } from './cloud.mjs';
import { MobileControl } from './control.mjs';

const realBroker = Boolean(process.env.MQTT_URL && process.env.MQTT_CA_FILE && process.env.ENSAIA_DEVICE_ID);
const id = realBroker ? process.env.ENSAIA_DEVICE_ID : 'ensaia-mobile';
const sid = 'abcdef0123456789';
const cookie = `ensaia_session=${'0'.repeat(64)}`;
const command = (fields) => JSON.stringify({ id: 'command-1', sentAt: Date.now(), ...fields });

test('rechaza IDs con comodines, estado inválido, comandos vencidos y falta de consentimiento', () => {
  assert.throws(() => topics('another/+/node'));
  assert.equal(parseState('{"online":true,"at":0}'), null);
  assert.equal(parseCommand(command({ op: 'stop', sid, sentAt: Date.now() - requestLifetime - 1 })), null);
  assert.equal(parseCommand(command({ op: 'start', title: 'Prueba', seconds: 30, consent: false })), null);
  assert.equal(parseCommand(command({ op: 'stop', sid })).sid, sid);
});

async function until(check) {
  const end = Date.now() + 4_000;
  while (!await check()) {
    if (Date.now() > end) throw new Error('Tiempo agotado esperando el flujo de captura');
    await delay(20);
  }
}

test(`inicio y parada con ${realBroker ? 'broker MQTT real' : 'mensajes MQTT simulados'} y audio del nodo virtual`, async () => {
  let origin, deviceSocket, presentation;
  let starts = 0;
  let frames = 0;
  const observed = [];
  const results = [];
  const server = createServer(async (req, res) => {
    const action = new URL(req.url, origin).searchParams.get('action');
    const send = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const read = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    if (action === 'login') {
      assert.equal(req.headers.origin, origin);
      assert.deepEqual(await read(), { username: 'demo', password: 'pass' });
      res.setHeader('Set-Cookie', `${cookie}; HttpOnly; Path=/`);
      return send({ username: 'demo' });
    }
    assert.equal(req.headers.cookie, cookie);
    if (action === 'state') return send({
      deviceId: id, device: { online: true, at: Date.now() }, aiConfigured: true,
      presentation: presentation?.status === 'completed' ? null : presentation,
    });
    if (action === 'presentation') return send(presentation);
    if (action === 'start') {
      const payload = await read();
      assert.equal(payload.consent, true);
      assert.match(payload.title, /^\[Demo MQTT\]/);
      starts++;
      presentation = { id: sid, status: 'pending' };
      deviceSocket.send(JSON.stringify({ type: 'capture.start', sid, sampleRate: 16000, samplesPerFrame: 320, maxSeconds: 30 }));
      return send(presentation, 201);
    }
    assert.equal(action, 'stop');
    assert.deepEqual(await read(), { id: sid });
    deviceSocket.send(JSON.stringify({ type: 'capture.stop', sid }));
    send({ ok: true }, 202);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    deviceSocket = socket;
    socket.on('message', (raw, binary) => {
      if (binary) {
        assert.equal(raw.length, 664);
        assert.equal(raw.subarray(0, 16).toString(), sid);
        assert.equal(raw.readUInt32LE(16), frames);
        assert.equal(raw.readUInt32LE(20), frames * 320);
        frames++;
        return;
      }
      const message = JSON.parse(raw);
      if (message.type === 'device.auth') {
        assert.deepEqual(message, { type: 'device.auth', deviceId: id, secret: 'test', username: 'demo', password: 'pass' });
        socket.send(JSON.stringify({ type: 'auth.ok' }));
      } else if (message.type === 'capture.started') presentation.status = 'recording';
      else if (message.type === 'capture.ended') {
        assert.equal(message.frames, frames);
        presentation.status = 'completed';
        presentation.audioSaved = true;
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;

  let mqtt, gateway;
  const device = new VirtualDevice({ origin, deviceId: id, username: 'demo', password: 'pass', secret: 'test' });
  const control = new MobileControl({
    api: new CloudApi(origin, 'demo', 'pass'), device, deviceId: id, mode: 'live',
    publishState: (state) => observed.push(state), publishResult: (result) => results.push(result),
  });
  try {
    let receive = (raw, retained) => control.receive(raw, retained);
    if (realBroker) {
      const { url, username, password } = JSON.parse(readFileSync('.private/lab/mobile.json', 'utf8'));
      const options = {
        username, password, protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 3_000,
        wsOptions: { ca: readFileSync(process.env.MQTT_CA_FILE) },
      };
      await assert.rejects(connectAsync(url, { ...options, wsOptions: {} }, false));
      await assert.rejects(connectAsync(url, { ...options, password: 'invalid' }, false), (error) => [134, 135].includes(error.code));
      mqtt = await connectAsync(url, options, false);
      const routes = topics(id);
      mqtt.on('message', (topic, data) => {
        const value = JSON.parse(data.toString());
        if (topic === routes.state) observed.push(value);
        if (topic === routes.result) results.push(value);
      });
      const granted = await mqtt.subscribeAsync([routes.state, routes.result], { qos: 1 });
      assert.deepEqual(granted.map((subscription) => subscription.qos), [1, 1]);
      const other = await connectAsync(url, options, false);
      try {
        let rejection;
        other.on('packetreceive', (packet) => {
          if (packet.cmd === 'suback') rejection = packet.granted[0];
        });
        await assert.rejects(other.subscribeAsync('ensaia/v1/other/mobile/state', { qos: 1 }), /Not authorized/);
        assert.equal(rejection, 135);
        await assert.rejects(other.publishAsync(routes.state, '{}', { qos: 1 }), { code: 135 });
      } finally {
        other.end(true);
      }
      gateway = spawn(process.execPath, ['--experimental-strip-types', 'gateway/main.mjs'], {
        env: { ...process.env, ENSAIA_CLOUD_URL: origin, ENSAIA_USERNAME: 'demo', ENSAIA_PASSWORD: 'pass',
          ENSAIA_DEVICE_SECRET: 'test', ENSAIA_MODE: 'live' },
        stdio: 'inherit',
      });
      receive = (raw) => mqtt.publishAsync(routes.command, raw, { qos: 1 });
    } else {
      device.connect();
      await until(() => device.online);
      await control.poll();
    }
    await until(() => observed.at(-1)?.online === true);
    const start = command({ op: 'start', title: 'Ensayo', seconds: 30, consent: true });
    if (!realBroker) await receive(start, true);
    assert.equal(starts, 0);
    await receive(start);
    await until(() => results.length === 1);
    await receive(start);
    await until(() => results.length === 2);
    assert.equal(starts, 1);
    assert.deepEqual(results.map((entry) => entry.ok), [true, true]);
    await until(() => frames >= 3);
    await receive(command({ id: 'bad-stop', op: 'stop', sid: '0123456789abcdef' }));
    await until(() => results.at(-1)?.id === 'bad-stop');
    assert.equal(results.at(-1).ok, false);
    await receive(command({ id: 'command-2', op: 'stop', sid }));
    await until(() => results.at(-1)?.id === 'command-2');
    assert.equal(results.at(-1).ok, true);
    await until(() => presentation.status === 'completed');
    await until(async () => {
      if (!realBroker) await control.poll();
      return observed.at(-1).session?.status === 'completed';
    });
    assert.deepEqual(observed.at(-1).session, { id: sid, status: 'completed', audioSaved: true });
  } finally {
    mqtt?.end(true);
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      const exit = once(gateway, 'exit');
      gateway.kill();
      await exit;
    }
    device.close();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

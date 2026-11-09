import WebSocket from 'ws';

const sampleRate = 16_000;
const samplesPerFrame = 320;
const frameMs = 20;
const sidPattern = /^[a-f0-9]{16}$/;

export class CloudApi {
  #cookie;

  constructor(origin, username, password) {
    this.origin = origin;
    this.username = username;
    this.password = password;
  }

  async #send(action, body, sid) {
    const url = new URL('/api/server', this.origin);
    url.searchParams.set('action', action);
    if (sid) url.searchParams.set('id', sid);
    return fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body && { 'Content-Type': 'application/json', Origin: this.origin }),
        ...(this.#cookie && { Cookie: this.#cookie }),
      },
      body: body && JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
  }

  async call(action, body, sid) {
    if (!this.#cookie) {
      const login = await this.#send('login', { username: this.username, password: this.password });
      this.#cookie = login.headers.get('set-cookie')?.match(/^ensaia_session=[a-f0-9]{64}(?=;|$)/)?.[0];
      await login.body?.cancel();
      if (!login.ok || !this.#cookie) throw new Error('ENSAIA rechazó las credenciales de la pasarela.');
    }

    const response = await this.#send(action, body, sid);
    if (response.status === 401) this.#cookie = undefined;
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'ENSAIA rechazó la operación.');
    return payload;
  }
}

export function makeFrame(sid, seq) {
  const frame = Buffer.alloc(24 + samplesPerFrame * 2);
  frame.write(sid, 'ascii');
  frame.writeUInt32LE(seq, 16);
  const offset = seq * samplesPerFrame;
  frame.writeUInt32LE(offset, 20);
  for (let i = 0; i < samplesPerFrame; i++) {
    const t = (offset + i) / sampleRate;
    const amplitude = 700 + 1_500 * Math.sin(Math.PI * 2 * 1.3 * t) ** 2;
    frame.writeInt16LE(Math.round(amplitude * Math.sin(Math.PI * 2 * 220 * t)), 24 + i * 2);
  }
  return frame;
}

export class VirtualDevice {
  #socket;
  #heartbeat;
  #retry;
  #capture;
  #closed = false;
  #authorized = false;

  constructor(config) {
    this.config = config;
  }

  get online() { return this.#authorized && this.#socket?.readyState === WebSocket.OPEN; }

  connect() {
    const { origin, deviceId, secret, username, password } = this.config;
    const url = new URL('/api/server?role=device', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { handshakeTimeout: 8_000, maxPayload: 4096 });
    this.#socket = socket;
    socket.on('open', () => this.#send({ type: 'device.auth', deviceId, secret, username, password }));
    socket.on('message', (raw, binary) => {
      if (binary) return;
      try { this.#receive(JSON.parse(raw.toString())); }
      catch { socket.close(1002, 'Control inválido'); }
    });
    socket.on('error', () => console.error('No se pudo conectar el nodo virtual con ENSAIA.'));
    socket.on('close', () => {
      this.#authorized = false;
      clearInterval(this.#heartbeat);
      this.#stopCapture();
      if (!this.#closed) this.#retry = setTimeout(() => this.connect(), 3_000);
    });
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#retry);
    clearInterval(this.#heartbeat);
    this.#stopCapture();
    this.#socket?.close();
  }

  #send(data) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(data));
  }

  #status() {
    this.#send({ type: 'device.status', peak: this.#capture ? 2_200 : 0 });
  }

  #receive(event) {
    if (event.type === 'auth.ok') {
      this.#authorized = true;
      this.#status();
      clearInterval(this.#heartbeat);
      this.#heartbeat = setInterval(() => this.#status(), 2_000);
    } else if (event.type === 'auth.error') {
      console.error('ENSAIA no autorizó el dispositivo virtual. Revisa su registro y credenciales.');
      this.close();
    } else if (event.type === 'reconnect') {
      this.#socket.close();
    } else if (this.online && event.type === 'capture.start') {
      this.#startCapture(event);
    } else if (event.type === 'capture.stop' && this.#capture?.sid === event.sid) {
      this.#finishCapture();
    }
  }

  #startCapture({ sid, sampleRate: rate, samplesPerFrame: count, maxSeconds }) {
    if (this.#capture) return;
    if (!sidPattern.test(sid) || rate !== sampleRate || count !== samplesPerFrame ||
        !Number.isInteger(maxSeconds) || maxSeconds < 15 || maxSeconds > 180) {
      this.#send({ type: 'capture.error', sid, reason: 'Formato de captura inválido' });
      return;
    }
    const maxFrames = maxSeconds * 1_000 / frameMs;
    const started = performance.now();
    const capture = { sid, frames: 0, timer: undefined };
    this.#capture = capture;
    this.#send({ type: 'capture.started', sid });

    const tick = () => {
      if (!this.online) return this.#stopCapture();
      if (this.#socket.bufferedAmount > 64 * 1024) {
        this.#stopCapture();
        this.#send({ type: 'capture.error', sid, reason: 'La conexión no puede enviar el audio a tiempo' });
        return;
      }
      this.#socket.send(makeFrame(sid, capture.frames));
      capture.frames++;
      if (capture.frames === maxFrames) return this.#finishCapture();
      const nextFrame = started + (capture.frames + 1) * frameMs;
      capture.timer = setTimeout(tick, Math.max(1, nextFrame - performance.now()));
    };
    capture.timer = setTimeout(tick, frameMs);
  }

  #finishCapture() {
    const { sid, frames } = this.#capture;
    this.#stopCapture();
    this.#send({ type: 'capture.ended', sid, frames, reason: 'user' });
  }

  #stopCapture() {
    clearTimeout(this.#capture?.timer);
    this.#capture = undefined;
  }
}

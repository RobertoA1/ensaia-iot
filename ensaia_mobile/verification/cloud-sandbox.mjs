import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const blobApi = 'https://ensaia-qa-storage.test';
const blobFiles = 'https://ensaiaqa.private.blob.vercel-storage.com';
const openai = 'https://api.openai.com';
const cloudRequire = createRequire(new URL('../../ensaia_cloud/package.json', import.meta.url));

async function startLocalServices() {
  const blobs = new Map();
  const service = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/storage') {
      if (req.method === 'PUT') {
        const pathname = url.searchParams.get('pathname');
        if (blobs.has(pathname) && req.headers['x-allow-overwrite'] !== '1') {
          return json({ error: { code: 'blob_already_exists', message: 'Blob already exists' } }, 400);
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const data = Buffer.concat(chunks);
        const metadata = {
          pathname, url: `${blobFiles}/${pathname}`, downloadUrl: `${blobFiles}/${pathname}?download=1`,
          size: data.length, uploadedAt: new Date().toISOString(),
          contentType: req.headers['x-content-type'] || 'application/octet-stream',
          etag: createHash('sha256').update(data).digest('hex'),
        };
        blobs.set(pathname, { data, metadata });
        return json(metadata);
      }
      const prefix = url.searchParams.get('prefix') || '';
      return json({ hasMore: false, blobs: [...blobs.values()]
        .map(({ metadata }) => metadata).filter(({ pathname }) => pathname.startsWith(prefix)) });
    }
    if (url.pathname.startsWith('/files/')) {
      const blob = blobs.get(decodeURIComponent(url.pathname.slice('/files/'.length)));
      if (!blob) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': blob.metadata.contentType, 'Content-Length': String(blob.data.length),
      });
      res.end(blob.data);
      return;
    }
    if (url.pathname === '/model/v1/responses') {
      for await (const _chunk of req) { /* Drena el cuerpo de la solicitud. */ }
      const text = 'Resumen de prueba con una sugerencia para organizar la exposición.';
      return json({ output: [{ content: [{ type: 'output_text', text }] }] });
    }
    res.writeHead(404);
    res.end();
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const serviceOrigin = `http://127.0.0.1:${service.address().port}`;
  const { Agent, getGlobalDispatcher, setGlobalDispatcher } = cloudRequire('undici');
  const original = getGlobalDispatcher();
  const agent = new Agent();
  const routes = new Map([[blobApi, '/storage'], [blobFiles, '/files'], [openai, '/model']]);
  setGlobalDispatcher({ dispatch(options, handler) {
    const origin = String(options.origin);
    const prefix = routes.get(origin);
    if (prefix) return agent.dispatch({ ...options, origin: serviceOrigin, path: prefix + options.path.replace(/^\/(?=\?|$)/, '') }, handler);
    if (new URL(origin).hostname === '127.0.0.1') return agent.dispatch(options, handler);
    throw new Error(`La prueba bloqueó una solicitud externa a ${origin}`);
  } });
  return async () => {
    setGlobalDispatcher(original);
    await agent.close();
    await new Promise((resolve) => service.close(resolve));
  };
}

export async function startCloudSandbox({ deviceId, secret, port = 0 }) {
  if (!deviceId || !secret) throw new Error('Faltan las credenciales de laboratorio del nodo.');
  const stopServices = await startLocalServices();
  Object.assign(process.env, {
    REDIS_URL: 'redis://127.0.0.1:6388',
    REDIS_PREFIX: `ensaia:mobile-qa:${randomBytes(8).toString('hex')}`,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    DEVICE_SECRETS: JSON.stringify({ [deviceId]: createHash('sha256').update(secret).digest('hex') }),
    // Tokens ficticios para pruebas locales únicamente — NO son credenciales reales.
    // El sufijo '_local' en BLOB_READ_WRITE_TOKEN y el valor 'local-test-only' en OPENAI_API_KEY
    // son marcadores de posición que el sandbox intercepta antes de llegar a la red.
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_ensaiaqa_local',
    VERCEL_BLOB_API_URL: blobApi,
    OPENAI_API_KEY: 'local-test-only',
  });
  const { default: server } = await import('../../ensaia_cloud/api/server.ts');
  const store = await import('../../ensaia_cloud/lib/store.ts');
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  let worker, keepalive, restart, closed = false;
  const audio = new Map();
  function startWorker() {
    worker = new WebSocket(`${origin.replace('http:', 'ws:')}/api/server?role=worker`);
    worker.on('open', () => worker.send(JSON.stringify({ type: 'worker.auth', deviceId, secret })));
    worker.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'worker.ready') {
        keepalive = setInterval(() => worker.send('{"type":"worker.ping"}'), 4_000);
      } else if (message.type === 'audio') {
        const bytes = Buffer.from(message.audio, 'base64');
        audio.set(message.sid, (audio.get(message.sid) ?? 0) + bytes.length);
        worker.send(JSON.stringify({ type: 'transcript', sid: message.sid,
          text: 'Texto sintético para la prueba de oratoria.', start_ms: 0, end_ms: 1000 }));
      } else if (message.type === 'end') worker.send(JSON.stringify({ type: 'ended', sid: message.sid }));
    });
    worker.on('error', () => {});
    worker.on('close', () => {
      clearInterval(keepalive);
      if (!closed) restart = setTimeout(startWorker, 1_000);
    });
  }
  startWorker();

  return {
    origin, audio,
    async close() {
      closed = true;
      clearTimeout(restart);
      clearInterval(keepalive);
      if (worker.readyState !== WebSocket.CLOSED) {
        const closing = once(worker, 'close');
        worker.close();
        await closing.catch(() => {});
      }
      await delay(150);
      await new Promise((resolve) => server.close(resolve));
      await (await store.db()).close();
      await stopServices();
    },
  };
}

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, devices } from 'playwright-core';
import { createServer } from '../../ensaia_cloud/node_modules/vite/dist/node/index.js';
import { voiceBridge } from '../cloud-webview.ts';

const cloud = fileURLToPath(new URL('../../ensaia_cloud/', import.meta.url));
const browserPath = process.env.ENSAIA_CHROMIUM || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find(existsSync);
let server, browser, origin;

before(async () => {
  if (!browserPath) throw Error('Indica la ruta a Chrome o Chromium con ENSAIA_CHROMIUM.');
  server = await createServer({ root: cloud, configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const transcript = 'Bueno, una idea clara ayuda a que el público recuerde los pasos.';
const advice = 'Haz una pausa antes de la idea central.';
const dimension = { score: 80, evidence: 'una idea clara', suggestion: 'Agrega un ejemplo.', startMs: 1000, endMs: 3000 };
function presentation(id, title, score, createdAt) {
  return {
    id, title, createdAt, phase: 'practice', status: 'completed', sourceComplete: true, archived: true,
    audioSaved: true, feedback: true, transcript, advice, summary: '## Próximo paso\nPractica con **un ejemplo**.',
    summarySource: 'text-ai',
    metrics: {
      seconds: 35, words: 20, wordsPerMinute: 90, fillerCandidates: 1, fillers: [{ token: 'bueno', count: 1 }],
      repetitions: 0, longPauses: 1, peak: 123, recentRms: 0.1,
    },
    events: [{ id: 1, kind: 'advice', text: advice, audioMs: 2000 }, { id: 2, kind: 'transcript', text: transcript, audioMs: 34000 }],
    assessments: [{
      seconds: 35, total: score, complexity: 'Idea explicada con claridad.',
      dimensions: { clarity: dimension, organization: dimension, development: dimension },
    }],
  };
}
const earlier = presentation('0000000000000001', 'Primera práctica', 60, '2026-01-01T12:00:00Z');
const later = presentation('0000000000000002', 'Segunda práctica', 80, '2026-01-02T12:00:00Z');
const recorded = presentation('0000000000000003', 'Práctica actual', 80, '2026-01-03T12:00:00Z');

async function fixture(t, options = {}) {
  const context = await browser.newContext({
    ...(options.desktop ? { viewport: { width: 1280, height: 900 } } : devices['Pixel 7']),
    acceptDownloads: true,
  });
  const sessionCookie = 'ensaia_session=fixture';
  if (options.signedIn !== false) {
    await context.addCookies([{ name: 'ensaia_session', value: 'fixture', url: origin, httpOnly: true, sameSite: 'Strict' }]);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(7_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, []);
  });
  await page.addInitScript({ content: `
    window.voiceMessages = [];
    window.ReactNativeWebView = { postMessage: data => window.voiceMessages.push(JSON.parse(data)) };
    ${voiceBridge}
  ` });
  const state = { online: options.online !== false, active: null, calls: [] };
  const sessions = options.empty ? [] : [later, earlier];
  await page.route('**/api/server?**', async route => {
    const request = route.request();
    const query = new URL(request.url()).searchParams;
    const action = query.get('action');
    const data = request.postDataJSON();
    const id = query.get('id');
    const send = (json, status = 200) => route.fulfill({ status, json });
    state.calls.push({ action, data });
    if (action === 'login') {
      if (data.username !== 'demo' || data.password !== 'prueba') return send({ error: 'Usuario o contraseña incorrectos' }, 401);
      return route.fulfill({ json: { username: 'demo' }, headers: {
        'set-cookie': sessionCookie + '; HttpOnly; SameSite=Strict; Path=/',
      } });
    }
    const cookies = (await request.headerValue('cookie') || '').split(/;\s*/);
    if (!cookies.includes(sessionCookie)) return send({ error: 'Inicia sesión para acceder' }, 401);
    if (action === 'logout') {
      return route.fulfill({ json: { ok: true }, headers: {
        'set-cookie': 'ensaia_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/',
      } });
    }
    if (action === 'state') return send({
      username: 'demo', deviceId: 'fixture', device: { online: state.online, at: Date.now(), rssi: -53 },
      aiConfigured: true, workerOnline: true, maxSeconds: 180, presentation: state.active, legacyAdmin: Boolean(options.adminReport),
    });
    if (action === 'legacy-report') {
      return options.adminReport ? send(options.adminReport) : send({error:'Acceso administrativo requerido'},403);
    }
    if (action === 'start') {
      state.active = { ...recorded, ...data, status: 'recording' };
      if (!data.feedback) state.active.events = [];
      return send(state.active);
    }
    if (action === 'stop') {
      sessions.unshift({ ...state.active, status: 'completed' });
      state.active = null;
      return send({ ok: true });
    }
    if (action === 'history') return send({ sessions: sessions.map(p => ({ ...p, score: p.assessments[0].total })) });
    const item = sessions.find(p => p.id === id);
    if (!item) return send({ error: 'Presentación no encontrada' }, 404);
    if (action === 'presentation') return send(item);
    if (action === 'audio' || action === 'export') {
      const audio = action === 'audio';
      const body = audio ? Buffer.from('RIFF-fixture-WAVE') : JSON.stringify(item);
      return route.fulfill({ body, headers: {
        'content-type': audio ? 'audio/wav' : 'application/json',
        'content-disposition': `attachment; filename="ENSAIA-${id}.${audio ? 'wav' : 'json'}"`,
      } });
    }
    return send({ error: 'Ruta inesperada' }, 404);
  });
  await page.goto(origin);
  return { page, state };
}

const visible = (page, selector) => page.locator(selector).waitFor({ state: 'visible' });
const content = async (page, selector, expected) => {
  await visible(page, selector);
  assert.match(await page.locator(selector).innerText(), expected);
};
const tab = (page, name) => page.locator(`[data-tab="${name}"]`).click();

const reportPre = {
  id: earlier.id, originalId: '00000001', code: 'D001', phase: 'pre', date: earlier.createdAt,
  simulated: false, complete: true, feedback: true, missingFrames: 0, providerFinalized: true,
  seconds: 40, words: 100, wordsPerMinute: 150, fillers: 3, repetitions: 2, pauses: 1,
};
const reportPost = {
  ...reportPre, id: later.id, originalId: '00000002', phase: 'post', date: later.createdAt, fillers: 0,
};
const aggregate = row => ({
  ...row, count: 1, medianWordsPerMinute: row.wordsPerMinute,
  fillersPerMinute: row.fillers * 60 / row.seconds, fillersPer100Words: row.fillers * 100 / row.words,
});
const adminReport = {
  inventory: {
    sessions: 2, pre: 1, post: 1, practice: 0, wav: 4, audio: {original:2, relay:2, assistant:0},
    transcribed: 2, simulated: 0, occurrences: 6, unreviewed: 6, fillers: 3, repetitions: 2, pauses: 1,
    sourceEvents: 20, corrected: 0, humanEvaluations: 0,
  },
  comparison: {pre: aggregate(reportPre), post: aggregate(reportPost)},
  exercises: [{
    code: 'D001', script: 'Organización del tiempo · A', preCount: 1, postCount: 1,
    ambiguous: false, pair: {pre: reportPre, post: reportPost},
  }],
  sessions: [reportPost, reportPre],
};

for (const desktop of [false, true]) {
  test(`administración en ${desktop ? 'escritorio' : 'pantalla móvil'}: comparación, filtros y detalle`, async t => {
    const {page, state} = await fixture(t, {desktop, adminReport, online:false});
    await content(page, '#admin-view h1', /Panel de administración/);
    await content(page, '#admin-count', /2 de 2 sesiones/);
    const table = page.getByRole('table', {name:'Indicadores de los pares técnicamente completos'});
    const row = table.getByRole('row', {name:'Candidatos a muletilla 3 0', exact:true});
    await row.waitFor();
    await page.locator('.admin-exercise summary').click();
    await page.getByRole('table', {name:'Comparación del ejercicio D001'}).waitFor();
    await page.locator('#admin-phase').selectOption('post');
    await content(page, '#admin-count', /1 de 2 sesiones/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.locator('#admin-sessions button').click();
    await content(page, '#summary', /Próximo paso/);
    assert.ok(state.calls.some(call => call.action === 'legacy-report'));
    await tab(page,'admin');
    await page.locator('#admin-refresh').click();
    await content(page, '#admin-count', /2 de 2 sesiones/);
  });
}

test('acceso: contraseña visible, credenciales inválidas, sesión y cierre', async t => {
  const { page } = await fixture(t, { signedIn: false });
  await content(page, 'h2', /Qué bueno tenerte aquí/);
  await page.locator('#username').fill(' Demo ');
  await page.locator('#password').fill('incorrecta');
  await page.locator('#show-password').click();
  assert.equal(await page.locator('#password').getAttribute('type'), 'text');
  await page.locator('#login-submit').click();
  await content(page, '#login-error', /Usuario o contraseña incorrectos/);
  await page.locator('#password').fill('prueba');
  await page.locator('#login-submit').click();
  await content(page, '#top-status', /Dispositivo conectado/);
  assert.equal(await page.locator('[data-tab="admin"]').count(), 0);
  await page.reload();
  await content(page, '#top-status', /Dispositivo conectado/);
  await page.locator('#logout').click();
  await visible(page, '#login-form');
  await page.reload();
  await visible(page, '#login-form');
});

test('mi práctica: dispositivo, Whisper y GPT-Live, formulario y consentimiento', async t => {
  const { page, state } = await fixture(t, { online: false });
  await content(page, '#top-status', /Dispositivo desconectado/);
  assert.ok(await page.locator('#start').isDisabled());
  assert.deepEqual(await page.locator('#seconds option').evaluateAll(items => items.map(o => o.value)), ['60', '120', '180', '30']);
  await content(page, '#engine-status', /Whisper conectado/);
  state.online = true;
  await page.getByText('Dispositivo conectado', { exact: true }).waitFor();
  await content(page, '#signal-value', /-53 dBm/);
  await page.locator('#engine').selectOption('live');
  await content(page, '#engine-status', /GPT-Live procesa el audio/);
  await page.locator('#title').fill('   Mi tema   ');
  await page.locator('#audience').fill('Mi público');
  await page.locator('#ideal-text').fill('Mi guion');
  await page.locator('#phase').selectOption('pre');
  await page.locator('#seconds').selectOption('120');
  await page.locator('#start').click();
  await content(page, '#toast', /Confirma la aceptación/);
  assert.equal(state.calls.some(x => x.action === 'start'), false);
  await page.locator('#consent').check();
  await page.locator('#start').click();
  await visible(page, '#stop');
  assert.deepEqual(state.calls.find(x => x.action === 'start').data, {
    title: 'Mi tema', audience: 'Mi público', idealText: 'Mi guion', phase: 'pre',
    seconds: 120, feedback: true, mode: 'live', consent: true,
  });
});

test('captura: voz, transcripción, consejos, métricas, rúbrica y resumen al finalizar', async t => {
  const { page, state } = await fixture(t);
  await page.locator('#voice-test').click();
  assert.match((await page.evaluate(() => window.voiceMessages))[0].text, /Así escucharás los consejos/);
  await page.locator('#title').fill('Práctica actual');
  await page.locator('#consent').check();
  await page.locator('#start').click();
  await content(page, '#duration', /00:35/);
  await content(page, '#transcript', /una idea clara/);
  await content(page, '#advice', /Haz una pausa/);
  await content(page, '#word-count', /20 palabras/);
  assert.equal(await page.locator('#metrics .metric-card').count(), 4);
  assert.deepEqual(await page.locator('.rubric-item strong').allTextContents(), ['Claridad', 'Organización', 'Desarrollo de ideas']);
  await content(page, '.score-big', /80/);
  await content(page, '.rubric-item:first-child .evidence-time', /00:01–00:03/);
  await content(page, '.filler-context mark', /Bueno/i);
  await content(page, '.analysis-detail', /Señal recibida.*Ritmo reciente/s);
  await page.waitForFunction(() => window.voiceMessages.some(m => m.text === 'Haz una pausa antes de la idea central.'));
  await page.locator('#stop').click();
  await content(page, '#summary h3', /Próximo paso/);
  await content(page, '#summary strong', /un ejemplo/);
  await content(page, '#quality-note', /Audio completo y presentación guardada/);
  assert.deepEqual(state.calls.find(x => x.action === 'stop').data, { id: recorded.id });
  assert.equal((await page.evaluate(() => window.voiceMessages)).at(-1).type, 'cancel');
});

test('sin retroalimentación: conserva el discurso y muestra la evaluación al finalizar', async t => {
  const { page } = await fixture(t);
  await page.locator('#title').fill('Práctica sin consejos');
  await page.locator('#feedback').uncheck();
  await page.locator('#consent').check();
  await page.locator('#start').click();
  await content(page, '#no-feedback-note', /Sin consejos durante esta toma/);
  await content(page, '#transcript', /una idea clara/);
  await content(page, '#advice', /Consejos en vivo desactivados/);
  assert.equal(await page.locator('#metrics').isVisible(), false);
  assert.equal(await page.locator('#analysis-panel').isVisible(), false);
  await page.locator('#stop').click();
  await content(page, '#analysis-panel', /Tu evolución durante la práctica/);
});

test('historial: estado vacío y regreso a la práctica', async t => {
  const { page } = await fixture(t, { empty: true });
  await tab(page, 'history');
  await content(page, '#history-list', /Tu primera práctica te espera/);
  await page.locator('#first-practice').click();
  await visible(page, '#presentation-form');
});

test('historial: actualización, detalle y descarga de informe JSON y audio WAV', async t => {
  const { page } = await fixture(t);
  await tab(page, 'history');
  await page.locator('#refresh-history').click();
  await content(page, `[data-id="${later.id}"]`, /Segunda práctica.*Guardada/s);
  await page.locator(`[data-id="${later.id}"]`).click();
  await content(page, '#summary', /Próximo paso/);
  for (const [selector, ext] of [['.export-button', 'json'], ['#audio-download', 'wav']]) {
    const [file] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
    assert.equal(file.suggestedFilename(), `ENSAIA-${later.id}.${ext}`);
    const bytes = readFileSync(await file.path());
    if (ext === 'json') assert.equal(JSON.parse(bytes).id, later.id);
    else assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  }
});

test('mi progreso: tendencia, comparación de métricas y validación de selección', async t => {
  const { page } = await fixture(t);
  await tab(page, 'report');
  await content(page, '#history-trend', /Primera práctica.*60\/100.*Segunda práctica.*80\/100.*\+20/s);
  await page.locator('#compare').click();
  await content(page, '.score-compare', /60 → 80 \(\+20 puntos\)/);
  assert.equal(await page.locator('#comparison tbody tr').count(), 5);
  await page.locator('#compare-a').selectOption(later.id);
  await page.locator('#compare').click();
  await content(page, '#toast', /Selecciona dos presentaciones diferentes/);
  await page.locator('#compare-b').selectOption(earlier.id);
  await page.locator('#compare').click();
  await content(page, '#comparison .warning', /posterior a la segunda/);
});

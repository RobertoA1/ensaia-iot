import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCloudSandbox } from './cloud-sandbox.mjs';

const { ANDROID_SERIAL: serial, ADB: adbPath = 'adb', ENSAIA_DEVICE_ID: deviceId, ENSAIA_DEVICE_SECRET: secret,
  ENSAIA_USERNAME: username, ENSAIA_PASSWORD: password, ENSAIA_EXPO_URL: expoUrl } = process.env;
if (!/^emulator-\d+$/.test(serial || '')) throw new Error('Selecciona un emulador con ANDROID_SERIAL.');

function adb(...args) {
  try {
    return execFileSync(adbPath, ['-s', serial, ...args], {
      timeout: 12_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Los argumentos de input text pueden contener la contraseña MQTT.
    throw new Error(`ADB ${args.slice(0, 2).join(' ')} falló en ${serial} (${error.status ?? error.code}).`);
  }
}
const shell = (...args) => adb('shell', ...args).toString();
const find = (xml, label, className) => [...xml.matchAll(/<node\s[^>]+>/g)].map(([node]) => node)
  .find((node) => (!className || node.includes(`class="${className}"`)) &&
    (node.includes(`text="${label}"`) || node.includes(`content-desc="${label}"`)));

function ui() {
  shell('uiautomator', 'dump', '/sdcard/ensaia-mobile-qa.xml');
  return shell('cat', '/sdcard/ensaia-mobile-qa.xml');
}

async function waitFor(label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const node = find(ui(), label);
    if (node) return node;
    await delay(300);
  }
  throw new Error(`Android no mostró «${label}» dentro del plazo.`);
}

function tap(node) {
  const match = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
  assert.ok(match, 'Android no devolvió la posición del control');
  const [, x1, y1, x2, y2] = match.map(Number);
  shell('input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
}

function enter(label, value) {
  const node = find(ui(), label, 'android.widget.EditText');
  assert.ok(node, `Falta el campo ${label}`);
  tap(node);
  const current = /text="([^"]*)"/.exec(node)?.[1] || '';
  if (current && !node.includes('hint="' + current + '"')) {
    shell('input', 'keyevent', '123');
    for (let i = 0; i < current.length; i++) shell('input', 'keyevent', '67');
  }
  // Los valores de laboratorio se componen de una URL WSS y credenciales alfanuméricas.
  assert.match(value, /^[a-zA-Z0-9_./:-]+$/);
  shell('input', 'text', value);
  if (/\b(?:mInputShown|mIsInputViewShown)=true\b/.test(shell('dumpsys', 'input_method'))) {
    shell('input', 'keyevent', '4');
  }
}

const lab = JSON.parse(readFileSync('.private/lab/mobile.json', 'utf8'));
const sandbox = await startCloudSandbox({ deviceId, secret });
const gateway = spawn(process.execPath, ['--experimental-strip-types', 'gateway/main.mjs'], {
  env: { ...process.env, ENSAIA_MODE: 'whisper', ENSAIA_CLOUD_URL: sandbox.origin },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  if (expoUrl) {
    shell('am', 'force-stop', 'host.exp.exponent');
    shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', expoUrl, 'host.exp.exponent');
  } else {
    shell('am', 'force-stop', 'pe.ensaia.mobile');
    shell('am', 'start', '-n', 'pe.ensaia.mobile/.MainActivity');
  }
  await waitFor('Conectar por MQTT', 120_000);
  await waitFor('Broker desconectado');
  enter('Dirección del broker', lab.url);
  if (lab.deviceId !== 'ensaia-mobile') enter('ID del dispositivo', lab.deviceId);
  if (lab.username !== 'mobile') enter('Usuario MQTT', lab.username);
  enter('Contraseña MQTT', lab.password);
  tap(await waitFor('Conectar por MQTT'));
  await waitFor('ENSAIA disponible');
  console.log('Android se conectó a EMQX por MQTT 5 sobre WSS.');

  assert.match(await waitFor('Iniciar práctica'), /enabled="false"/);
  tap(await waitFor('Aceptar el procesamiento del audio sintético'));
  tap(await waitFor('Iniciar práctica'));
  await waitFor('Grabando');
  console.log('El botón Iniciar publicó la orden y Android mostró el estado Grabando.');
  tap(await waitFor('Detener práctica'));
  await waitFor('Finalizada');
  await waitFor('WAV disponible en el historial de ENSAIA.');
  console.log('El botón Detener cerró la misma práctica y Android mostró el WAV disponible.');

  const url = `${sandbox.origin}/api/server?action=`;
  const login = await fetch(url + 'login', { method: 'POST', headers: {
    Origin: sandbox.origin, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ username, password }) });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const history = await (await fetch(url + 'history', { headers })).json();
  assert.equal(history.sessions.length, 1);
  const [{ id, status, sourceComplete }] = history.sessions;
  assert.equal(status, 'completed');
  assert.equal(sourceComplete, true);
  const wav = await fetch(url + `audio&id=${id}`, { headers });
  assert.equal(wav.status, 200);
  const bytes = Buffer.from(await wav.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  assert.ok(bytes.length > 44);
  console.log('La API de ENSAIA devolvió exactamente una práctica con audio completo y WAV.');

  if (process.env.ENSAIA_EVIDENCE_DIR) {
    const evidence = resolve(process.env.ENSAIA_EVIDENCE_DIR);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'android-mqtt-finalizada.png'), adb('exec-out', 'screencap', '-p'));
  }
} finally {
  if (gateway.exitCode === null && gateway.signalCode === null) {
    const exit = once(gateway, 'exit');
    gateway.kill();
    await exit;
  }
  await sandbox.close();
}

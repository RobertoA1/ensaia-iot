import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { startCloudSandbox } from './cloud-sandbox.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const renderer = require('react-test-renderer');

test('la pantalla React usa el cliente MQTT móvil contra EMQX', { timeout: 55_000 }, async () => {
  const lab = JSON.parse(readFileSync('.private/lab/mobile.json', 'utf8'));
  const sandbox = await startCloudSandbox({ deviceId: process.env.ENSAIA_DEVICE_ID, secret: process.env.ENSAIA_DEVICE_SECRET });
  const gateway = spawn(process.execPath, ['--experimental-strip-types', 'gateway/main.mjs'], {
    env: { ...process.env, ENSAIA_MODE: 'whisper', ENSAIA_CLOUD_URL: sandbox.origin },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  // Conserva el bundle ESM que carga Metro. La extensión .mjs evita que Node lo trate como CommonJS.
  const directory = mkdtempSync(join(tmpdir(), 'ensaia-mobile-'));
  const mobileBundle = join(directory, 'mqtt.mjs');
  copyFileSync(require.resolve('mqtt/dist/mqtt.esm'), mobileBundle);
  const widgets = ['Pressable', 'ScrollView', 'StatusBar', 'Switch', 'Text', 'TextInput', 'View', 'SafeAreaProvider', 'SafeAreaView'];
  const nativeModule = 'data:text/javascript,' + encodeURIComponent(widgets.map((widget) =>
    `export const ${widget} = props => globalThis.React.createElement('${widget}', props);`).join('\n') +
    '\nexport const StyleSheet = {create: styles => styles};');
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'react-native' || specifier === 'react-native-safe-area-context') return { url: nativeModule, shortCircuit: true };
    if (specifier === 'mqtt') return { url: pathToFileURL(mobileBundle).href, shortCircuit: true, format: 'module' };
    return next(specifier, context);
  } });
  const ca = readFileSync(process.env.MQTT_CA_FILE);
  globalThis.React = React;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'navigator', { value: { product: 'ReactNative' }, configurable: true });
  globalThis.WebSocket = class extends WebSocket {
    constructor(url, protocols) { super(url, protocols, { ca }); }
  };

  let tree;
  try {
    const { default: App } = await import('../MqttLab.tsx');
    await React.act(async () => { tree = renderer.create(React.createElement(App)); });
    const button = (label) => tree.root.findAllByType('Pressable')
      .find((node) => node.findAllByType('Text').some((text) => text.props.children === label));
    const field = (label) => tree.root.findAllByType('TextInput').find((node) => node.props.accessibilityLabel === label);
    const hasText = (label) => tree.root.findAllByType('Text').some((node) => node.props.children === label);
    async function waitFor(label) {
      const end = Date.now() + 18_000;
      while (!hasText(label) && Date.now() < end) await React.act(async () => { await delay(70); });
      assert.ok(hasText(label), `La pantalla no mostró «${label}».`);
    }
    const press = (label) => React.act(async () => { button(label).props.onPress(); });

    assert.equal(button('Iniciar práctica').props.disabled, true);
    await React.act(async () => {
      field('Dirección del broker').props.onChangeText(lab.url);
      field('ID del dispositivo').props.onChangeText(lab.deviceId);
      field('Usuario MQTT').props.onChangeText(lab.username);
      field('Contraseña MQTT').props.onChangeText('invalid');
    });
    await press('Conectar por MQTT');
    await waitFor('Error MQTT. Comprueba las credenciales, la red y el certificado del broker.');
    assert.equal(button('Iniciar práctica').props.disabled, true);

    await React.act(async () => { field('Contraseña MQTT').props.onChangeText(lab.password); });
    await press('Conectar por MQTT');
    await waitFor('ENSAIA disponible');
    assert.equal(button('Iniciar práctica').props.disabled, true);
    await React.act(async () => { tree.root.findByType('Switch').props.onValueChange(true); });
    assert.equal(button('Iniciar práctica').props.disabled, false);

    await press('Iniciar práctica');
    await waitFor('Grabando');
    await press('Detener práctica');
    await waitFor('Finalizada');
    await waitFor('WAV disponible en el historial de ENSAIA.');
    await press('Desconectar');
    assert.equal(button('Iniciar práctica').props.disabled, true);
  } finally {
    await React.act(async () => { tree?.unmount(); });
    hook.deregister();
    unlinkSync(mobileBundle);
    rmdirSync(directory);
    if (gateway.exitCode === null && gateway.signalCode === null) {
      const exit = once(gateway, 'exit');
      gateway.kill();
      await exit;
    }
    await sandbox.close();
  }
});

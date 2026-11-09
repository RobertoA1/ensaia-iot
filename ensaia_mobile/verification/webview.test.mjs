import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { cloudOrigin, isCloudUrl, readVoiceMessage, voiceBridge } from '../cloud-webview.ts';

test('la WebView y el puente de voz se limitan al origen HTTPS de ENSAIA', () => {
  const origin = cloudOrigin();
  assert.equal(origin, 'https://ensaia-oratoria.vercel.app');
  assert.equal(cloudOrigin(' https://QA.example:443/ '), 'https://qa.example');
  assert.equal(cloudOrigin('https://qa.example:8443'), 'https://qa.example:8443');
  for (const url of ['http://qa.example', 'https://qa.example:99999', 'https://qa.example/app', 'https://u:p@qa.example', 'https://qa.example?x=1']) {
    assert.throws(() => cloudOrigin(url), /origen HTTPS/);
  }
  assert.ok(isCloudUrl(origin, origin));
  assert.ok(isCloudUrl(origin + '/api/server?action=audio&id=123', origin));
  for (const url of [origin + '.example/', origin + '@example.org/', origin + ':8443/', 'https://example.org/?url=' + origin, 'file:///data/local']) {
    assert.equal(isCloudUrl(url, origin), false);
  }
});

test('el puente interpreta solo órdenes de voz válidas y limita el tamaño', () => {
  assert.deepEqual(readVoiceMessage('{"type":"cancel"}'), { type: 'cancel' });
  assert.deepEqual(readVoiceMessage('{"type":"speak","text":"  Hola  "}'), { type: 'speak', text: 'Hola' });
  assert.equal(readVoiceMessage(JSON.stringify({ type: 'speak', text: 'a'.repeat(900) })).text.length, 700);
  for (const data of ['invalid', 'null', '{"type":"open"}', '{"type":"speak","text":" "}', '{"type":"speak","text":10}', 'a'.repeat(8193)]) {
    assert.equal(readVoiceMessage(data), null);
  }
});

test('Android recibe voz y cancelación desde la interfaz web', () => {
  const messages = [];
  const window = {
    navigator: { userAgent: 'Chrome/123.0.0.0' },
    ReactNativeWebView: { postMessage: data => messages.push(JSON.parse(data)) },
  };
  window.top = window;
  runInNewContext(voiceBridge, { window });
  assert.equal(window.speechSynthesis.getVoices()[0].lang, 'es-PE');
  window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(''));
  window.speechSynthesis.speak(new window.SpeechSynthesisUtterance('Haz una pausa.'));
  window.speechSynthesis.cancel();
  assert.deepEqual(messages, [{ type: 'speak', text: 'Haz una pausa.' }, { type: 'cancel' }]);
});

test('una WebView antigua solicita actualización', () => {
  const messages = [];
  const window = {
    navigator: { userAgent: 'Chrome/52.0.0.0' },
    ReactNativeWebView: { postMessage: data => messages.push(readVoiceMessage(data)) },
  };
  window.top = window;
  runInNewContext(voiceBridge, { window });
  assert.deepEqual(messages, [{ type: 'update-webview' }]);
});

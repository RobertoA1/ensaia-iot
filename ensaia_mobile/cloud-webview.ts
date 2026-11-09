const production = 'https://ensaia-oratoria.vercel.app';

export function cloudOrigin(configured?: string): string {
  const value = configured?.trim() || production;
  const match = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::([1-9]\d{0,4}))?\/?$/i.exec(value);
  if (!match || Number(match[2]) > 65535) {
    throw new Error('EXPO_PUBLIC_ENSAIA_WEB_URL debe ser el origen HTTPS de ENSAIA.');
  }
  const [, host, port] = match;
  return `https://${host.toLowerCase()}${port && port !== '443' ? ':' + port : ''}`;
}

export function isCloudUrl(value: string, origin: string): boolean {
  // WebView supplies a canonical URL. Match the exact authority and its delimiter.
  return value === origin || value.startsWith(origin + '/');
}

type WebViewMessage = { type: 'cancel' | 'update-webview' } | { type: 'speak'; text: string };

export function readVoiceMessage(data: string): WebViewMessage | null {
  if (data.length > 8_192) return null;
  try {
    const message = JSON.parse(data);
    if (message?.type === 'cancel' || message?.type === 'update-webview') return { type: message.type };
    if (message?.type === 'speak' && typeof message.text === 'string' && message.text.trim()) {
      return { type: 'speak', text: message.text.trim().slice(0, 700) };
    }
  } catch {
    // Ignore messages outside the voice protocol.
  }
  return null;
}

// Use Android TTS for the site's SpeechSynthesis calls. Keep this script compatible
// with older WebViews so they can report that the current Vite build needs an update.
export const voiceBridge = `
  (function () {
    var bridge = window.ReactNativeWebView;
    if (!bridge || window !== window.top) return;
    function send(message) { bridge.postMessage(JSON.stringify(message)); }
    var chromium = /Chrome\\/(\\d+)/.exec(window.navigator.userAgent);
    if (chromium && Number(chromium[1]) < 111) {
      send({ type: 'update-webview' });
      return;
    }
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: function () { return [{ lang: 'es-PE' }]; },
        speak: function (utterance) {
          if (utterance.text.trim()) send({ type: 'speak', text: utterance.text.slice(0, 700) });
        },
        cancel: function () {
          send({ type: 'cancel' });
        }
      }
    });
  })();
  true;
`;

import { useEffect, useRef, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import WebView from 'react-native-webview';
import { cloudOrigin, isCloudUrl, readVoiceMessage, voiceBridge } from './cloud-webview';
import MqttLab from './MqttLab';

const origin = cloudOrigin(process.env.EXPO_PUBLIC_ENSAIA_WEB_URL);
const source = { uri: origin };

function Cloud() {
  const browser = useRef<WebView<object>>(null);
  const [needsUpdate, setNeedsUpdate] = useState(false);
  useEffect(() => () => { void Speech.stop(); }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        {needsUpdate ? (
          <View style={styles.error}>
            <Text style={styles.title}>Actualiza Android System WebView</Text>
            <Text>ENSAIA necesita una versión reciente para abrir el espacio de práctica.</Text>
          </View>
        ) : <WebView<object>
          ref={browser}
          source={source}
          style={styles.screen}
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={({ url }) => isCloudUrl(url, origin)}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          thirdPartyCookiesEnabled={false}
          mixedContentMode="never"
          allowFileAccess={false}
          injectedJavaScript={voiceBridge}
          onMessage={({ nativeEvent }) => {
            if (!isCloudUrl(nativeEvent.url, origin)) return;
            const message = readVoiceMessage(nativeEvent.data);
            if (message?.type === 'update-webview') setNeedsUpdate(true);
            if (message?.type === 'cancel') void Speech.stop();
            if (message?.type === 'speak') {
              Speech.speak(message.text, {
                language: 'es-PE',
                onError: () => ToastAndroid.show('Revisa la voz en español en los ajustes de Android.', ToastAndroid.LONG),
              });
            }
          }}
          renderError={() => (
            <View style={styles.error}>
              <Text style={styles.title}>No pudimos abrir ENSAIA</Text>
              <Text>Comprueba tu conexión e inténtalo de nuevo.</Text>
              <Pressable accessibilityRole="button" onPress={() => browser.current?.reload()} style={styles.button}>
                <Text style={styles.buttonText}>Reintentar</Text>
              </Pressable>
            </View>
          )}
        />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

export default function App() {
  return process.env.EXPO_PUBLIC_ENSAIA_MODE === 'mqtt' ? <MqttLab /> : <Cloud />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fafbf7' },
  error: { flex: 1, padding: 24, gap: 12, justifyContent: 'center', alignItems: 'center' },
  title: { color: '#173d35', fontSize: 22, fontWeight: '600' },
  button: { backgroundColor: '#173d35', paddingHorizontal: 22, paddingVertical: 12, borderRadius: 8 },
  buttonText: { color: '#fff', fontWeight: '600' },
});

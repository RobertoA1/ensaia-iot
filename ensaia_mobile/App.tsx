import { useEffect, useRef, useState } from 'react';
import {
  Pressable, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import mqttNative, { type MqttClient } from 'mqtt';
import {
  isActive, parseResult, parseState, presenceLifetime, requestLifetime, topics,
  type Command, type GatewayState, type SessionStatus,
} from './protocol';

const labels: Record<SessionStatus, string> = {
  pending: 'En espera', starting: 'Preparando', recording: 'Grabando', closing: 'Guardando',
  completed: 'Finalizada', interrupted: 'Interrumpida', error: 'Error de captura',
};

function Dashboard() {
  const client = useRef<MqttClient | null>(null);
  const routes = useRef<ReturnType<typeof topics> | null>(null);
  const pending = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [url, setUrl] = useState('');
  const [device, setDevice] = useState('ensaia-mobile');
  const [username, setUsername] = useState('mobile');
  const [password, setPassword] = useState('');
  const [connected, setConnected] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [gateway, setGateway] = useState<GatewayState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [title, setTitle] = useState('Práctica desde Android');
  const [seconds, setSeconds] = useState(30);
  const [consent, setConsent] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(timer);
      if (pending.current) clearTimeout(pending.current.timer);
      const current = client.current;
      client.current = null;
      current?.end(true);
    };
  }, []);

  function finishRequest() {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    setWaiting(false);
  }

  function disconnect() {
    const current = client.current;
    client.current = null;
    current?.end(true);
    finishRequest();
    setConnected(false);
    setConfigured(false);
    setGateway(null);
  }

  function openBroker() {
    const endpoint = url.trim();
    if (!/^wss:\/\/[a-z\d.-]+(?::\d+)?\/[^\s?#]*$/i.test(endpoint) || !username.trim() || !password) {
      setMessage('Completa la dirección wss:// del broker, el usuario y la contraseña.');
      return;
    }
    try {
      const selected = topics(device.trim());
      routes.current = selected;
      const mqtt = mqttNative.connect(endpoint, {
        username: username.trim(), password, clean: true, protocolVersion: 5,
        forceNativeWebSocket: true, resubscribe: false, reconnectPeriod: 3_000, connectTimeout: 8_000,
      });
      client.current = mqtt;
      setConfigured(true);
      setMessage('Conectando al broker…');

      mqtt.on('connect', () => {
        mqtt.subscribe([selected.state, selected.result], { qos: 1 }, (error, grants) => {
          if (client.current !== mqtt) return;
          if (error || grants?.length !== 2 || grants.some((grant) => grant.qos !== 1)) {
            disconnect();
            setMessage('El broker rechazó la suscripción. Revisa el ID y los permisos MQTT.');
            return;
          }
          setConnected(true);
          setMessage('');
        });
      });
      mqtt.on('close', () => {
        if (client.current !== mqtt) return;
        if (pending.current) finishRequest();
        setConnected(false);
        setGateway(null);
        setMessage('Conexión interrumpida. Esperando al broker…');
      });
      mqtt.on('error', (error) => {
        if (client.current !== mqtt) return;
        const code = (error as Error & { code?: number }).code;
        if (code === 134 || code === 135) disconnect();
        setMessage('Error MQTT. Comprueba las credenciales, la red y el certificado del broker.');
      });
      mqtt.on('message', (topic, payload) => {
        if (client.current !== mqtt) return;
        if (topic === selected.state) {
          const state = parseState(payload.toString());
          if (state) {
            setGateway(state);
            setNow(Date.now());
          }
        } else if (topic === selected.result) {
          const result = parseResult(payload.toString());
          if (!result || result.id !== pending.current?.id) return;
          finishRequest();
          setMessage(result.ok ? '' : result.message || 'ENSAIA rechazó el comando.');
        }
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo abrir la conexión MQTT.');
    }
  }

  const ready = connected && !!gateway?.online && Math.abs(now - gateway.at) <= presenceLifetime;
  const session = gateway?.session ?? null;
  const active = isActive(session);

  function send(op: Command['op']) {
    const mqtt = client.current;
    if (!ready || !mqtt?.connected || !routes.current || pending.current) return;
    const id = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const sentAt = Date.now();
    let command: Command;
    if (op === 'start') {
      if (active || !consent || !title.trim()) return;
      command = { id, sentAt, op, title: title.trim(), seconds, consent: true };
    } else {
      if (!session || !active || session.status === 'closing') return;
      command = { id, sentAt, op, sid: session.id };
    }
    const timer = setTimeout(() => {
      finishRequest();
      setMessage('Sin confirmación. Comprueba el estado de la sesión antes de reintentar.');
    }, requestLifetime);
    pending.current = { id, timer };
    setWaiting(true);
    setMessage('');
    mqtt.publish(routes.current.command, JSON.stringify(command), {
      qos: 1, properties: { messageExpiryInterval: requestLifetime / 1_000 },
    }, (error) => {
      if (!error || pending.current?.id !== id) return;
      finishRequest();
      setMessage('El broker rechazó el comando. Revisa los permisos MQTT.');
    });
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.brand}>ENSAIA<Text style={styles.accent}>.</Text></Text>
          <Text style={styles.overline}>LABORATORIO 11  /  MQTT MÓVIL</Text>
          <Text style={styles.heading}>Tu práctica de oratoria</Text>
          <Text style={styles.secondary}>Controla desde el teléfono una sesión con audio sintético generado en la PC.</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.cardTitle}>Conexión</Text>
            <Text style={[styles.badge, ready && styles.badgeOnline]}>
              {ready ? 'ENSAIA disponible' : connected ? 'Esperando pasarela' : 'Broker desconectado'}
            </Text>
          </View>
          {!configured && <>
            <Field label="Dirección del broker" value={url} setValue={setUrl} placeholder="wss://192.168.1.20:8084/mqtt" />
            <Field label="ID del dispositivo" value={device} setValue={setDevice} />
            <Field label="Usuario MQTT" value={username} setValue={setUsername} />
            <Field label="Contraseña MQTT" value={password} setValue={setPassword} secret />
          </>}
          <Button label={configured ? 'Desconectar' : 'Conectar por MQTT'} onPress={configured ? disconnect : openBroker} secondary={configured} />
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.cardTitle}>Práctica</Text>
            <Text style={styles.badge}>{session ? labels[session.status] : 'Sin sesión activa'}</Text>
          </View>
          {session?.audioSaved && <Text style={styles.secondary}>WAV disponible en el historial de ENSAIA.</Text>}
          <Field label="Tema" value={title} setValue={setTitle} maxLength={120} editable={!active} />
          <Text style={styles.label}>Duración máxima</Text>
          <View style={styles.options}>
            {[30, 60, 120, 180].map((value) => (
              <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: value === seconds }}
                disabled={active} onPress={() => setSeconds(value)} style={[styles.option, value === seconds && styles.selected]}>
                <Text style={styles.label}>{value} s</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.row}>
            <Text style={[styles.secondary, styles.consent]}>Acepto guardar el audio sintético y procesarlo con el modo configurado en ENSAIA.</Text>
            <Switch accessibilityLabel="Aceptar el procesamiento del audio sintético" value={consent}
              onValueChange={setConsent} disabled={active} />
          </View>
          {active
            ? <Button label="Detener práctica" onPress={() => send('stop')} disabled={!ready || waiting || session?.status === 'closing'} />
            : <Button label="Iniciar práctica" onPress={() => send('start')} disabled={!ready || waiting || !consent || !title.trim()} />}
          {waiting && <Text accessibilityLiveRegion="polite" style={styles.secondary}>Esperando confirmación de ENSAIA…</Text>}
        </View>
        {!!message && <Text accessibilityLiveRegion="polite" style={styles.notice}>{message}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, value, setValue, placeholder, secret, maxLength, editable }: {
  label: string; value: string; setValue: (value: string) => void; placeholder?: string;
  secret?: boolean; maxLength?: number; editable?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} style={styles.input} placeholder={placeholder} placeholderTextColor="#8798ac"
        value={value} onChangeText={setValue} autoCapitalize="none" autoCorrect={false}
        secureTextEntry={secret} maxLength={maxLength} editable={editable} />
    </View>
  );
}

function Button({ label, onPress, disabled, secondary }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled}
      style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, (disabled || pressed) && styles.dim]}>
      <Text style={[styles.buttonText, secondary && styles.label]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  return <SafeAreaProvider><Dashboard /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0e1929' },
  content: { padding: 20, paddingBottom: 32, gap: 16, alignSelf: 'center', width: '100%', maxWidth: 580 },
  header: { paddingVertical: 14, gap: 10 },
  brand: { color: '#f2f6fa', fontWeight: '800', fontSize: 24, letterSpacing: 2 },
  accent: { color: '#70e6be' },
  overline: { color: '#70e6be', fontWeight: '700', fontSize: 11, letterSpacing: 1.3 },
  heading: { color: '#f2f6fa', fontSize: 32, fontWeight: '700' },
  secondary: { color: '#bac9dc', fontSize: 14, lineHeight: 21 },
  card: { backgroundColor: '#17263a', borderRadius: 16, borderWidth: 1, borderColor: '#293e58', padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  cardTitle: { color: '#f2f6fa', fontSize: 19, fontWeight: '700' },
  badge: { color: '#dce7f2', backgroundColor: '#263b56', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, fontSize: 11 },
  badgeOnline: { color: '#9cf5d7', backgroundColor: '#234743' },
  field: { gap: 5 },
  label: { color: '#dce7f2', fontSize: 14, fontWeight: '600' },
  input: { minHeight: 44, padding: 10, color: '#f2f6fa', backgroundColor: '#101e30', borderRadius: 8, borderWidth: 1, borderColor: '#344c68' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  option: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#344c68' },
  selected: { backgroundColor: '#244742', borderColor: '#70e6be' },
  consent: { flex: 1 },
  button: { alignItems: 'center', padding: 13, backgroundColor: '#70e6be', borderRadius: 9 },
  buttonSecondary: { backgroundColor: '#263b56' },
  buttonText: { color: '#102921', fontSize: 15, fontWeight: '700' },
  dim: { opacity: 0.48 },
  notice: { color: '#ffd5a1', backgroundColor: '#3c2c21', borderRadius: 8, padding: 12, lineHeight: 20 },
});

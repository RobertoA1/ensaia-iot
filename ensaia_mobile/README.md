# ENSAIA para Android

La APK predeterminada abre [ENSAIA Cloud](https://ensaia-oratoria.vercel.app) en una WebView de Android. Usa la versión móvil de la misma interfaz web y la misma cuenta para acceder a la práctica, el historial, las descargas y la comparación de progreso. La captura sigue realizándose con el dispositivo ENSAIA asociado a la cuenta. Los consejos hablados usan el motor de voz de Android.

## Compilar y probar la réplica web

Desde `ensaia_mobile`, instala las dependencias con `npm ci`. Puedes compilar un APK con EAS usando el perfil `preview` o en local con Android SDK y Java:

```powershell
npx expo prebuild --platform android
.\android\gradlew.bat -p android :app:assembleRelease
```

La APK necesita conexión a Internet y Android System WebView actualizado. Para apuntar a un entorno de pruebas, define `EXPO_PUBLIC_ENSAIA_WEB_URL` con su origen HTTPS al empaquetar. Las credenciales de Redis, Blob e IA pertenecen al servidor.

Con las dependencias de `ensaia_cloud` también instaladas, ejecuta `npm run test:replica`. La suite carga la web del repositorio con un perfil de pantalla móvil y simula la API. Prueba acceso, configuración, consentimiento, captura, consejos, voz, rúbrica, métricas, historial, descargas, progreso y navegación segura. Si Chromium no está en una ruta habitual, indica su ejecutable mediante `ENSAIA_CHROMIUM`.

Para comprobar el APK en un emulador, define `ANDROID_SERIAL` y ejecuta `npm run test:apk -- <ruta-al-apk>`. La prueba instala la APK y espera la pantalla de acceso. En un emulador con WebView anterior a Chromium 111, `ENSAIA_EXPECT_LEGACY_WEBVIEW=1` permite verificar el aviso de actualización.

## Variante de laboratorio MQTT

La app React Native controla una práctica de ENSAIA Cloud desde Android. Publica **Iniciar** y **Detener** y se suscribe al estado por MQTT 5 sobre WSS. La pasarela en la PC usa la API HTTPS y el protocolo WSS de dispositivo de ENSAIA. Genera un tono PCM de prueba y marca la toma como `[Demo MQTT]` en el historial. La captura de voz desde el teléfono queda para otra etapa.

```text
Android ↔ MQTT sobre WSS ↔ EMQX ↔ pasarela en PC ↔ HTTPS/WSS ↔ ENSAIA Cloud
```

## Preparar el laboratorio en Windows

Desde `ensaia_mobile`, con Node.js 22.13+ dentro de la serie 22, Docker Compose, Git para Windows u OpenSSL y acceso administrativo al proyecto de ENSAIA Cloud:

```powershell
npm ci
npm run provision -- 192.168.1.20
docker compose --env-file .private/lab/broker.env -f infra/emqx/compose.yaml up -d
docker compose --env-file .private/lab/broker.env -f infra/emqx/compose.yaml ps
```

Sustituye `192.168.1.20` por la IPv4 Wi-Fi de la PC. El broker recibe conexiones en esa IP y el puerto `8084`. El panel de administración escucha en `127.0.0.1:18084`, con usuario `admin` y contraseña en `.private/lab/broker.env`. El teléfono y la PC deben estar en la misma red. Si Windows filtra la conexión, habilita `8084/TCP` para la red privada del laboratorio.

El aprovisionamiento genera dos usuarios MQTT, una CA de laboratorio y un certificado válido para la IP configurada. Conserva las credenciales en sucesivas ejecuciones. Reserva la IP de la PC para la demo. Para cambiarla, conserva una copia privada de la configuración, genera un laboratorio con la nueva IP y vuelve a compilar con su CA. Un volumen EMQX ya inicializado conserva sus usuarios. Usa el panel para gestionar credenciales si vuelves a aprovisionar el laboratorio.

1. Agrega el par `deviceId → hash` de `.private/lab/device-secrets.json` al JSON `DEVICE_SECRETS` de ENSAIA Cloud, conservando las entradas anteriores, y aplica la configuración al despliegue de pruebas.
2. Revisa `ENSAIA_CLOUD_URL` y `ENSAIA_MODE` en `.private/lab/gateway.env`. `live` usa la IA configurada en el servidor. Para `whisper` debe estar conectado el transcriptor correspondiente al ID virtual. La integración desplegada puede consumir API.
3. Ejecuta `npm run gateway` en otra terminal. El dispositivo virtual registra su cuenta al conectarse. Para ver el historial web de esa cuenta, usa `ENSAIA_USERNAME` y `ENSAIA_PASSWORD` del archivo privado de la pasarela.

## Compilar e instalar el APK

El perfil `mqtt` de Expo genera un APK de laboratorio para instalación directa. Desde `ensaia_mobile`, con una cuenta de Expo autenticada:

```powershell
npx eas-cli@latest build --platform android --profile mqtt
```

Si prefieres compilar en Windows con el SDK de Android y Java configurados, genera el proyecto nativo y ejecuta Gradle:

```powershell
$env:EXPO_PUBLIC_ENSAIA_MODE = 'mqtt'
npx expo prebuild --platform android
.\android\gradlew.bat -p android :app:assembleRelease
Remove-Item Env:EXPO_PUBLIC_ENSAIA_MODE
```

Gradle deja el APK en `android/app/build/outputs/apk/release/`. El plugin de Expo incluye la CA pública de `certs/` en la compilación Android, limitada al host del broker. Haz el aprovisionamiento antes de compilar si usas la CA local. Para un broker con certificado público puedes compilar sin `certs/`. Consulta la [guía de APK de Expo](https://docs.expo.dev/build-reference/apk/).

Instala el APK de laboratorio, abre **ENSAIA** y copia la dirección, el ID y las credenciales MQTT desde `.private/lab/mobile.json`. Conecta, acepta el procesamiento de la toma sintética y pulsa **Iniciar práctica**. Espera **Grabando**, pulsa **Detener práctica** y comprueba el resultado y el WAV en el historial web.

## Topics y verificación

Todos los topics parten de `ensaia/v1/{deviceId}/mobile` y usan QoS 1:

| Topic | Dirección | Retención |
| --- | --- | --- |
| `command` | App → pasarela | Sin retención. Comando con ID, hora, operación y consentimiento para iniciar o ID de sesión para detener. |
| `state` | Pasarela → app | Último estado con vencimiento. El *Last Will* anuncia desconexión. |
| `result` | Pasarela → app | Sin retención. Respuesta de aplicación correlacionada por ID. |

EMQX restringe publicación y suscripción por cuenta y topic. La pasarela descarta comandos retenidos, vencidos y duplicados, y aplica la validación de propietario de ENSAIA. Las credenciales del servidor quedan en la PC. El APK incluye únicamente la CA pública cuando se usa el broker local.

`npm run typecheck`, `npm run android:bundle` y `npm test` comprueban tipos, empaquetado Android y el flujo de control con un servidor HTTP/WSS de prueba. Con EMQX en ejecución y la pasarela normal detenida, `npm run test:broker` prueba el intercambio por MQTT real, las credenciales inválidas y una suscripción prohibida. Usa el servidor de prueba, por lo que no requiere Vercel ni llamadas de IA.

Para probar el servidor real del repositorio, ejecuta `npm ci` también en `ensaia_cloud` y levanta un Redis desechable:

```powershell
docker run --rm -d --name ensaia-mobile-qa-redis -p 127.0.0.1:6388:6379 redis:alpine
```

Desde `ensaia_mobile`, ejecuta `npm run test:cloud`. Comprueba presencia, consentimiento, vencimiento, deduplicación, inicio y parada, y compara el PCM del WAV recuperado con las tramas del nodo. La prueba usa las rutas HTTP y WSS de ENSAIA Cloud y Redis real. El almacenamiento Blob y el proveedor de transcripción se sustituyen por servicios locales de prueba.

`npm run test:mobile` ejecuta el componente React con controles nativos simulados y el mismo bundle MQTT que carga Metro para Android. Usa EMQX y el servidor de laboratorio para verificar credenciales, consentimiento, inicio, parada y el estado final. Las comprobaciones de componentes requieren Node 22.15+ o Node 24.

Con un emulador que ya tenga el APK instalado, define `ANDROID_SERIAL` con su ID de ADB y ejecuta `npm run test:android`. Puedes indicar la ruta de ADB con `ADB` y un directorio de capturas con `ENSAIA_EVIDENCE_DIR`. El script opera la interfaz, confirma que el inicio requiere consentimiento y verifica la práctica finalizada en la API local. Para probar con Expo Go, configura `ENSAIA_EXPO_URL` y usa un emulador de pruebas que confíe en la CA del broker. Abre la app una vez y cierra el aviso inicial y el menú de desarrollo de Expo Go antes de ejecutar la prueba.

Para la demostración en vivo, muestra ambos clientes en EMQX, una práctica iniciada y detenida desde Android y el WAV en el historial. Oculta los valores de `.private/lab/` en las capturas.

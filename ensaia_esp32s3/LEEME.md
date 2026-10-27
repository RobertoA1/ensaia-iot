# ENSAIA: ESP32-S3 N16R8 + INMP441

Este paquete sustituye el micrófono del celular por el INMP441. Una sola placa ESP32-S3 captura y retransmite audio. La laptop sigue ejecutando ENSAIA, EMQX y la conexión con la IA.

Se entrega un programa para Arduino IDE y un puente para la laptop. El servidor anterior **no acepta directamente una fuente de audio MQTT**: por eso el puente es necesario. No hace falta modificar el código ni las grabaciones anteriores del servidor.

## 1. Cableado

Conecta con el USB desconectado:

| INMP441 | ESP32-S3 |
|---|---|
| VDD/VCC | 3V3 |
| GND | GND |
| SCK/BCLK | GPIO4 |
| WS/LRCLK | GPIO5 |
| SD/DOUT | GPIO6 |
| L/R | GND, canal izquierdo |

Usa los nombres impresos en los conectores, no su posición física. El micrófono se alimenta con 3,3 V. Conecta el USB de datos de la laptop al puerto **UART/USB-to-UART** de la placa. El ESP8266 anterior debe estar apagado: ambos usarían el mismo identificador MQTT.

## 2. Arduino IDE

En Preferencias → URLs adicionales del Gestor de placas, agrega:

```text
https://espressif.github.io/arduino-esp32/package_esp32_index.json
```

En Gestor de placas instala **esp32 by Espressif Systems, versión 3.3.5**. En Gestor de bibliotecas instala:

- **PubSubClient**, Nick O'Leary, **2.8**.
- **ArduinoJson**, Benoit Blanchon, **6.21.5**. Este programa usa la API de la versión 6.

El controlador I2S ya está incluido en el paquete ESP32. No instales una biblioteca I2S de terceros.

Abre `firmware/ENSAIA_ESP32S3/ENSAIA_ESP32S3.ino`. La carpeta debe conservar también `config.h` y `audio_format.h`.

Selecciona:

| Herramientas | Valor |
|---|---|
| Board / Placa | ESP32S3 Dev Module |
| CPU Frequency | 240 MHz |
| Flash Size | 16 MB (128 Mb) |
| Flash Mode | QIO 80MHz |
| PSRAM | OPI PSRAM |
| Partition Scheme | 16M Flash (3MB APP/9.9MB FATFS), si aparece |
| USB CDC On Boot | Disabled, usando el puerto UART |
| Upload Speed | 115200 |
| Port / Puerto | El puerto de tu ESP32-S3 |
| Monitor Serie | 115200 baudios |

No selecciones una placa ESP8266, ESP32 clásico o Arduino Uno. El N16R8 usa 16 MB de flash y 8 MB de PSRAM. Si los nombres exactos de los menús cambian, conserva esos tamaños, memoria OPI y conexión UART.

## 3. Completar `config.h`

Completa:

```cpp
static const char WIFI_SSID[] = "NombreDeTuWifi";
static const char WIFI_PASSWORD[] = "ClaveDeTuWifi";
static const char MQTT_HOST[] = "192.168.1.10";
static const uint16_t MQTT_PORT = 1884;
static const char MQTT_USER[] = "UsuarioDelServidor";
static const char MQTT_PASSWORD[] = "ClaveMqttDelServidor";
static const char DEVICE_ID[] = "esp8266-oratoria";
```

Son ejemplos: reemplázalos por tus datos. `MQTT_HOST` es la IPv4 LAN de la laptop. No pongas `127.0.0.1`, `localhost`, `http://` ni el puerto del dashboard EMQX. El ESP32 necesita Wi-Fi de **2,4 GHz**.

Para EMQX usa los valores `MQTT_PORT`, `MQTT_USER`, `MQTT_PASSWORD` y `DEVICE_ID` de **`.env.emqx`** del servidor. En el laboratorio anterior el puerto exterior es **1884**. Si usas el broker integrado con `.env`, normalmente es **1883**. El puerto 18083 es la administración de EMQX y no sirve para el ESP32.

Conserva el `DEVICE_ID` existente aunque su texto diga `esp8266-oratoria`: es el identificador del canal, no una detección del procesador. Así se conservan las autorizaciones y los topics existentes. La clave OpenAI permanece exclusivamente en el servidor; no se necesita `APP_TOKEN` en la placa.

## 4. Cargar y comprobar el micrófono

1. Pulsa **Verificar** y después **Subir**.
2. Si no conecta al cargador, mantén **BOOT**, pulsa y suelta **RESET/EN** y luego suelta BOOT. Reintenta la carga.
3. Abre Monitor Serie a **115200** y pulsa RESET si hace falta.
4. Debe aparecer `ENSAIA | ESP32-S3 + INMP441` y memoria detectada `Flash: 16 MB | PSRAM: 8 MB`.
5. Habla cerca del micrófono: `[MIC] Pico=.../32768` debe subir respecto al silencio. Esta comprobación funciona sin broker y sin IA. Introduce `m` para ocultar o mostrar el medidor.
6. Con el broker accesible aparecerá `MQTT conectado. IP ESP32: ...`.

El valor pico no representa decibelios ni una calibración acústica. Si siempre es cero, comprueba VDD/GND, SD→6, SCK→4, WS→5 y L/R→GND. Si el nivel es bajo, acerca el micrófono y después prueba `MIC_GAIN = 2` o `4` en `config.h`; vuelve a cargar. Si aparecen muchas muestras saturadas, reduce la ganancia o aleja un poco el micrófono de la boca.

La placa muestrea localmente para el medidor, pero **no publica audio del micrófono al arrancar**. Solo lo transmite al iniciar una toma desde el puente.

## 5. Iniciar el servidor existente

Usa la versión reciente del proyecto, la del RAR con EMQX. Debe contener `run.py`, `app/`, `.env.emqx` y su entorno Python. Mantén EMQX ejecutándose y `SIMULATE_DEVICE=false`.

En una primera terminal, dentro de la carpeta del servidor:

```bash
# Linux: sustituye la ruta por la de tu servidor real.
.venv/bin/python run.py --localhost --env-file .env.emqx
```

En Windows, el equivalente es:

```powershell
.\.venv\Scripts\python.exe run.py --localhost --env-file .env.emqx
```

Esto abre ENSAIA en **http://127.0.0.1:8765**. La página ya no necesita capturar el micrófono del celular. Si tu entorno tiene otro nombre, usa su ejecutable Python habitual. Las dependencias necesarias ya forman parte de `requirements-lock.txt` del servidor.

No ejecutes dos servidores sobre la misma base de datos. Si tu servidor habitual ya está funcionando, usa su URL en `--url`; para HTTPS agrega `--ca RUTA/certs/root-ca.crt`. Se verifican el certificado y el nombre/IP. No se desactiva TLS para aceptar certificados incorrectos.

## 6. Primera toma sin consumir API

En una **segunda terminal**, dentro de este paquete, ejecuta con el mismo Python del servidor:

```bash
/RUTA/AL/SERVIDOR/.venv/bin/python puente_esp32.py \
  --proyecto /RUTA/AL/SERVIDOR \
  --env /RUTA/AL/SERVIDOR/.env.emqx \
  --participante PRUEBA_S3 --fase practice --segundos 20 \
  --demo-ia --consentimiento
```

En Windows puede escribirse todo en una sola línea:

```powershell
C:\RUTA\SERVIDOR\.venv\Scripts\python.exe puente_esp32.py --proyecto C:\RUTA\SERVIDOR --env C:\RUTA\SERVIDOR\.env.emqx --participante PRUEBA_S3 --fase practice --segundos 20 --demo-ia --consentimiento
```

Sustituye las rutas de ejemplo. `--proyecto` apunta a la carpeta que contiene `app/` y `run.py`. `--env` tiene que ser exactamente la configuración del servidor que está ejecutándose.

Espera **GRABANDO** y habla. La toma se detiene y guarda al terminar el tiempo. Un primer **Ctrl+C** durante la grabación solicita el cierre normal; un segundo puede forzar la interrupción. En esta prueba **el micrófono es real y la IA es simulada**: el texto de demostración no corresponde a tus palabras. El WAV sí debe contener tu voz. No uses esta toma como evidencia de transcripción real.

Comprueba el WAV desde las sesiones guardadas en la interfaz existente, entrando con su `APP_TOKEN`. No pulses allí Iniciar con micrófono mientras utilizas el puente. Este sistema admite una toma activa.

## 7. Usar la IA y hacer Antes/Después

Cuando esté comprobado el WAV, verifica que el servidor tenga configurada su clave de API y acceso al modelo. Usa el comando anterior **quitando `--demo-ia`**. Esto sí puede consumir API. La placa no hace llamadas directas al proveedor.

Para una toma inicial sin consejos:

```bash
/RUTA/AL/SERVIDOR/.venv/bin/python puente_esp32.py --proyecto /RUTA/AL/SERVIDOR --env /RUTA/AL/SERVIDOR/.env.emqx --participante D001 --fase pre --segundos 60 --sin-consejos --consentimiento
```

Para otra toma con consejos:

```bash
/RUTA/AL/SERVIDOR/.venv/bin/python puente_esp32.py --proyecto /RUTA/AL/SERVIDOR --env /RUTA/AL/SERVIDOR/.env.emqx --participante D001 --fase post --segundos 60 --consentimiento
```

Son configuraciones de ejemplo para **nuevas** tomas; no describen ni modifican el protocolo histórico de David. Si el estudio mide recomendaciones revisadas antes de la segunda lectura, revisa esas recomendaciones antes de grabar y usa `--sin-consejos` también en Después para evitar añadir una intervención durante la lectura.

El puente exige `--consentimiento`: úsalo cuando la persona haya aceptado la grabación y el procesamiento. No equivale a una aprobación ética institucional.

Las recomendaciones aparecerán como `[CONSEJO IA]` en Monitor Serie y terminal. No hay salida de audio ni pantalla agregada en este montaje.

## 8. Registros y comprobación de integridad

El servidor conserva sus WAV, transcripciones, indicadores, eventos, horas y base de datos habituales. Por compatibilidad, el archivo del relevo sigue llamándose **`audio_via_esp8266.wav`**, aunque esta nueva toma pasa por el ESP32-S3.

El puente añade **`registros/ID_esp32.json`** en este paquete. Debe acompañar la exportación de ENSAIA: no se añade automáticamente a su ZIP. Puedes elegir otro destino con `--registros RUTA`.

Comprueba conjuntamente:

- En el informe ESP32: `source_capture_complete=true`, y tramas esperadas = recibidas = enviadas.
- En `indicadores.json` del servidor: `audio_relay_complete=true`, `provider_audio_complete=true` y `pending_device_events=0`.
- Para una toma con IA real: `demo=false` y `device_simulated=false`.

El indicador del servidor solo verifica el tramo de audio que logró recibir. El informe adicional comprueba la captura anterior a ese tramo. Si alguno falla, conserva la toma como evidencia de incidencia y no la presentes como audio íntegro. Aunque el transporte sea completo, la transcripción necesita revisión humana.

## 9. Flujo implementado

```text
INMP441 → ESP32-S3 → MQTT up/mic_audio → puente laptop → entrada WSS/WS de ENSAIA
ENSAIA → MQTT down/audio → mismo ESP32-S3 → MQTT up/audio → ENSAIA → IA
IA → ENSAIA → MQTT down/event → ESP32-S3 → MQTT up/event → registro confirmado
```

Se mantiene el relevo anterior para no cambiar los criterios de registro del servidor. Hay tres trayectos de audio por el broker, aproximadamente 96 kB/s de PCM más cabeceras MQTT; esta versión prioriza compatibilidad. No es una medición de latencia garantizada. El paquete no necesita el ESP8266.

Los topics nuevos, bajo el mismo prefijo `oratoria/v1/DEVICE_ID`, son `up/mic_audio`, `down/mic_control` y `up/mic_control`. La ACL del laboratorio permite `oratoria/v1/DEVICE_ID/#`, por lo que no requiere cambios si conservas el identificador. Con una ACL personalizada, autoriza estos canales. MQTT conserva QoS 0; inicio y cierre tienen confirmación y reintento de aplicación. Las pérdidas de captura interrumpen la toma; no se ocultan renumerando paquetes.

Si pierde Wi-Fi, MQTT, se llena la cola o hay desbordamiento I2S, no se reanuda la misma toma automáticamente. Inicia otra sesión después de resolver la conexión. El buffer de captura conserva hasta 2 segundos; las sesiones completas se guardan en la laptop.

## 10. Alcance de la verificación

Las pruebas de software se ejecutan sin hardware y con proveedor de IA simulado. No son una validación física de tu micrófono, calidad acústica, conexión real al proveedor ni latencia de feedback. Consulta `VERIFICACION.md` para los resultados del paquete entregado.

Referencias oficiales:

- [Espressif: DevKitC-1 y pines reservados](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html).
- [Espressif: controlador I2S para ESP32-S3](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/i2s.html).
- [Espressif: opciones de Arduino IDE](https://docs.espressif.com/projects/arduino-esp32/en/latest/guides/tools_menu.html).
- [TDK: INMP441, salida de 24 bits y selección de canal](https://invensense.tdk.com/wp-content/uploads/2015/02/INMP441.pdf).

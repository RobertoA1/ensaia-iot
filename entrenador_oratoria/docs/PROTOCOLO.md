# Protocolo del capturador y del nodo

## Transporte de captura

La página móvil y la fuente futura ESP32 se conectan al servidor, no a OpenAI. Deben:

1. Crear sesión con `POST /api/sessions`, cabecera `Authorization: Bearer APP_TOKEN`, JSON `{participant, phase, feedback, demo, consent:true}`. El servidor rechaza códigos fuera de letras, números, `_` y `-`.
2. Abrir `/ws/{sid}` sobre WSS; el primer mensaje JSON debe ser `{token: APP_TOKEN}`. Esperar `{type:'ready'}`.
3. Enviar tramas binarias de PCM16 LE mono a **16000 Hz**, sin cabecera WAV. Cada trama tiene hasta **320 muestras**, nominalmente 20 ms. La frecuencia real de captura debe remuestrearse, no solo renombrarse.
4. Finalizar con `{type:'stop',frames:N}` después de la última trama. No reutilizar una sesión para otro participante o después de un reinicio del nodo.

Cabecera binaria, 16 bytes:

| Posición | Contenido |
|---|---|
| 0-7 | ID de sesión de ocho caracteres ASCII hexadecimales |
| 8-11 | Secuencia uint32 little-endian, comenzando en cero |
| 12-15 | Offset acumulado de muestras uint32 little-endian, comenzando en cero |
| 16 en adelante | Entre una y 320 muestras PCM16, longitud par |

No se admiten saltos en la secuencia de captura. La laptop conserva el original y su checksum por trama, publica a la placa y verifica el contenido que regresa. La IA recibe exclusivamente las tramas confirmadas por el relevo; las pérdidas detectadas generan incidencias.

## Topics MQTT

Prefijo por defecto: `oratoria/v1/esp8266-oratoria`. Credenciales locales generadas en `.env` y `secrets.h`.

| Topic | Productor → consumidor | QoS y retención |
|---|---|---|
| `.../down/control` | Laptop → ESP8266 | QoS 1, sin retain |
| `.../up/control` | ESP8266 → laptop | QoS 0 + confirmación de aplicación, sin retain |
| `.../down/audio` | Laptop → ESP8266 | QoS 0, binario, sin retain |
| `.../up/audio` | ESP8266 → laptop | QoS 0, binario, sin retain |
| `.../down/event` | Laptop → ESP8266 | QoS 1, JSON, sin retain |
| `.../up/event` | ESP8266 → laptop | QoS 0 + outbox/reintento de aplicación, sin retain |
| `.../up/status` | ESP8266 → laptop | Estado retenido; heartbeat de 2 segundos y Last Will offline |

PubSubClient publica a QoS 0. No se afirma que el firmware publique a QoS 1. Para texto, cada evento ya existe en el outbox SQLite antes de enviarse y se reintenta hasta recibir el mismo evento desde el ESP. El ID único impide duplicarlo en almacenamiento o visualización. Para audio no se reenvían indefinidamente paquetes antiguos: se registra la pérdida y se conserva el original de la captura.

## Eventos de conversación

Cada fragmento tiene `{id, sid, kind, at, ...}`. El texto se divide en partes de hasta 420 bytes UTF-8 sin cortar caracteres. Los eventos incluyen:

- `session.started`, `session.ended`: etapa, condición y tiempos.
- `transcript.user`: texto, inicio y fin aproximados del fragmento.
- `feedback.ai`: texto del entrenador y si era visible para esa condición.
- `speech.candidate`: tipo de candidato, token, posiciones de caracteres y validación pendiente.
- `provider.started`, `provider.closed`, `provider.error`.
- `metrics.final`: indicadores exploratorios.

El ESP retransmite el JSON exactamente y muestra consejos actuales por Serie. La aplicación comprueba la correspondencia con el evento persistido; no acepta una confirmación con texto alterado. El registro de la conversación separa las voces del estudiante y del entrenador.

## Límites y evolución

Una placa, un micrófono y una sesión activa a la vez. La fuente futura ESP32 podrá usar el mismo protocolo HTTPS/WSS con captura INMP441. No se implementa todavía un enlace UART ESP32–ESP8266; conectar audio I2S directamente a los pines serie no cumple este contrato.

Los eventos del proveedor y el audio respaldado no garantizan que la transcripción sea literal. Las anotaciones humanas se guardan separadas mediante `POST /api/sessions/{sid}/annotations` y se incluyen en la exportación.

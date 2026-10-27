# Contexto del proyecto: Entrenador IoT de exposiciones

Documento de contexto del repositorio y del estado local observado el **18 de octubre de 2026**. Sirve para retomar el desarrollo y explicar qué está implementado, qué guarda y qué limitaciones tienen las pruebas actuales. No contiene contraseñas, claves API, secretos MQTT, credenciales Wi-Fi ni transcripciones.

## Propósito

El proyecto es un entrenador de exposiciones orales. El celular captura la voz; una placa RobotDyn UNO+WiFi R3 usa el ESP8266 para retransmitir audio y eventos por MQTT; una aplicación en la laptop gestiona la sesión, conecta con GPT-Live 1, muestra transcripción y consejos, y guarda evidencias. También permite comparar exposiciones con etapas Antes y Después.

## Arquitectura implementada

```text
Micrófono del celular
  → página web local por HTTPS
  → servidor FastAPI/Uvicorn en la laptop
  → MQTT / broker EMQX
  → ESP8266 RobotDyn (retransmisión de audio y eventos)
  → servidor en la laptop
  → WebSocket TLS con GPT-Live 1
  → texto, consejos y voz opcional hacia la interfaz
  → SQLite + evidencias WAV/JSON/CSV por sesión
```

La laptop hace de servidor, broker MQTT y pasarela a OpenAI. La placa no se conecta directamente a OpenAI ni almacena la clave API. El chip ATmega328P de la placa UNO+WiFi no participa en esta fase: el sketch se carga al ESP8266.

## Tecnologías y componentes

| Área | Tecnología o componente | Uso |
|---|---|---|
| Backend web | Python 3.11/3.12, FastAPI, Starlette y Uvicorn | Página, API, WebSocket y sesiones |
| Interfaz | HTML, CSS y JavaScript; Web Audio API y AudioWorklet | Captura de micrófono, visualización y reproducción |
| Voz/IA | GPT-Live 1 por WebSocket TLS | Transcripción, consejos y voz opcional |
| Mensajería | MQTT, EMQX Enterprise 6.3.2 en Docker | Intercambio entre servidor y ESP8266 |
| Clientes MQTT | Paho MQTT 2.1.0 y AMQTT 0.11.3 | Cliente del proyecto y broker alternativo de pruebas |
| Firmware | ESP8266 Arduino Core 3.1.2, PubSubClient 2.8 y ArduinoJson 6.21.5 | Relevo MQTT de la placa |
| Persistencia | SQLite en `data/oratoria.sqlite` | Sesiones, eventos, revisiones y encuestas |
| Evidencias | WAV, JSON, JSONL y CSV bajo `data/<id>/` | Audio, eventos, métricas y exportación |
| Seguridad local | HTTPS con certificados de laboratorio, token de app y usuarios/ACL MQTT | Micrófono del navegador y acceso controlado en la red de pruebas |
| Pruebas | pytest; pruebas MQTT y WebSocket locales; Arduino CLI para compilar | Regresión y verificación del firmware |

Versiones exactas de dependencias Python: `requirements-lock.txt`. La imagen EMQX está fijada en `infra/emqx/compose.yaml`. No se implementó el micrófono futuro ESP32 + INMP441 ni un altavoz físico en la placa.

## Qué se conserva por sesión

La base SQLite vincula `sessions`, `events`, `annotations`, `evaluations` y `surveys` por ID de sesión. En `data/<id>/` se conservan, según lo que haya producido la sesión:

- `microfono_original.wav`: audio recibido desde el celular.
- `audio_via_esp8266.wav`: audio retransmitido por la placa y enviado al proveedor; puede estar incompleto y el resumen lo señala.
- `respuesta_gpt.wav`, si llegó audio de respuesta.
- `provider_events.jsonl`: eventos recibidos de GPT-Live.
- `indicadores.json` y `silencios.json`: métricas exploratorias y detección de silencios.
- Eventos/transcripción y archivos de exportación, disponibles desde la interfaz de sesiones guardadas.

La existencia de un WAV confirma que hay un archivo guardado, pero no que la grabación esté completa. El resumen de cada sesión registra tramas originales y retransmitidas, pérdidas, duplicados, cierre del proveedor, eventos pendientes y estado de la sesión.

## Inventario de datos Antes/Después

Revisión de solo lectura de `data/oratoria.sqlite` y sus carpetas, realizada el **18 de octubre de 2026**. Hay **23 sesiones reales, no demo**, con códigos seudónimos D001–D010: **12 Antes** (`pre`) y **11 Después** (`post`). También hay 10 sesiones de práctica de P001, dos de ellas demo; no se cuentan como Antes/Después.

| Código | Antes conservadas | Después conservadas | Estado técnico observado |
|---|---:|---:|---|
| D001 | 2 | 1 | Una Antes está vacía (0 tramas); la segunda Antes y Después tienen relevo y cierre completos. |
| D002 | 2 | 1 | Las tres terminaron con relevo completo; una Antes es muy breve (54 tramas), por lo que conviene elegir la exposición larga. |
| D003 | 1 | 2 | Antes completa; ambas Después tienen pérdida de tramas y envío/cierre del proveedor incompleto; una quedó interrumpida. |
| D004 | 1 | 1 | Antes y Después completas. |
| D005 | 1 | 1 | Antes completa; Después guardada, pero con relevo y audio del proveedor incompletos. |
| D006 | 1 | 1 | Antes y Después completas. |
| D007 | 1 | 1 | Antes y Después completas. |
| D008 | 1 | 1 | Antes y Después completas. |
| D009 | 1 | 1 | Antes y Después completas. |
| D010 | 1 | 1 | Antes y Después completas. |

Con un criterio técnico estricto de relevo y cierre completos, hay **8 códigos con una pareja Antes/Después utilizable como candidata**: D001, D002, D004 y D006–D010. En D001 y D002 se debe seleccionar la toma Antes completa y sustantiva, no la toma adicional vacía o muy corta. D003 y D005 tienen una Después guardada, pero incompleta; no deben tratarse como parejas completas sin revisar el audio y justificar la exclusión o repetir la toma.

La base tiene **0 evaluaciones humanas completas y 0 anotaciones de revisión** para D001–D010. Los conteos automáticos de palabras, muletillas y repeticiones están sin validar; no son resultados finales ni prueban que las muletillas hayan disminuido. Para un análisis defendible, revisar el audio original, corregir la transcripción y usar el mismo criterio en Antes y Después. Hay varias tomas para D001–D003; documentar cuál se selecciona y por qué. No borrar sesiones para hacer coincidir el inventario con una cifra previa.

En la captura del panel EMQX compartida durante una prueba se apreciaban aproximadamente **dos conexiones**, siete tópicos y siete suscripciones, con actividad cercana a mil mensajes entrantes y salientes y picos de mensajes descartados. Son contadores del broker para ese intervalo; no equivalen a participantes, palabras ni calidad de audio.

## Cómo ejecutar localmente

Desde PowerShell en la raíz del repositorio:

```powershell
.\.venv\Scripts\python.exe -m tools.preparar_emqx
docker compose -f infra/emqx/compose.yaml up -d
docker compose -f infra/emqx/compose.yaml ps
.\.venv\Scripts\python.exe run.py --env-file .env.emqx
```

Esperar que EMQX esté `healthy`. El panel está en `http://localhost:18083`; el entrenador en `https://localhost:8443` desde la laptop. En el celular, abrir `https://IP_WIFI_DE_LA_LAPTOP:8443`, con celular y laptop en la misma red y certificado de laboratorio instalado. `localhost` en el celular apunta al propio celular.

Para parar el servidor del entrenador, usar `Ctrl+C` en su terminal. Para detener EMQX conservando sus datos:

```powershell
docker compose -f infra/emqx/compose.yaml stop
```

Más instrucciones y pruebas del laboratorio: `docs/LABORATORIO_EMQX.md`. No introducir secretos en este documento ni grabarlos en evidencia pública. Están en archivos privados ignorados por Git; consultar `.env.emqx.example` para los nombres de variables.

## Límites y próximos pasos técnicos

- El modo Antes/Después y el guardado están implementados; falta completar revisión humana de las grabaciones conservadas.
- Las métricas automáticas son exploratorias. El reconocedor puede omitir disfluencias; escuchar audio y revisar transcripción es necesario.
- Las pruebas automatizadas y con nodo/proveedor simulados no sustituyen una validación física de cada sesión ni validan acceso a GPT-Live 1 para otra cuenta.
- EMQX recibe y entrega mensajes MQTT. No se configuró una integración de EMQX hacia una segunda base de datos; la aplicación ya persiste sesiones y evidencias en SQLite.
- La detección de repeticiones incluye candidatos textuales; no certifica redundancia semántica ni distingue siempre énfasis intencional.
- La conexión MQTT de laboratorio usa la configuración documentada para la red local. No exponer el broker o el panel a Internet.

## Referencias internas

- `README.md`: configuración, placa, uso, exportación y diagnóstico.
- `docs/LABORATORIO_EMQX.md`: broker, publicador/suscriptor, seguridad y comandos.
- `docs/EVALUACION.md`: revisión humana, métricas y comparación.
- `docs/PILOTO_ANTES_DESPUES.md`: protocolo sugerido del piloto.
- `docs/VIABILIDAD.md`: decisiones de arquitectura y límites.
- `evidencias/VERIFICACION.md`: pruebas y estado de validación documentado.

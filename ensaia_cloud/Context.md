# Contexto de ENSAIA Cloud

Actualizado: 26 de octubre de 2026 (America/Lima), después de la entrega del despliegue y del firmware. Este documento permite continuar el proyecto sin exponer secretos. Resume las verificaciones efectuadas durante esa entrega; no representa una monitorización permanente del servicio.

Carpeta principal: `/home/robertoa1/Datos/proyectos/iot-2/ensaia_cloud`.

## Solicitud y resultado

Se creó y desplegó una variante independiente del entrenador ENSAIA para ESP32-S3-DevKitC-1 N16R8 e INMP441. La placa propone usuario y contraseña y se autentica con un secreto individual. Desde la web se controla la captura, se visualizan transcripción y consejos y se consultan estadísticas, resumen y archivos privados.

- Producción: https://ensaia-oratoria.vercel.app
- Proyecto Vercel: `ensaia-oratoria`, equipo `roberto-pro`.
- Proyecto ID: `prj_FiGNtGydC80qufsouPVxwH1V5JeS`.
- Despliegue posterior de corrección de reconexión: `dpl_KcmAdYi3yvgqBEwrc3TiPM6oZRMe`; alias de producción asignado. Comprobación posterior: health 200, estado sin sesión 401 y secreto inválido rechazado por WSS.
- Servidor: Node 24, HTTP y WebSocket nativos de Vercel Fluid, máximo 300 s.
- Modelo: `gpt-live-1`, endpoint `wss://api.openai.com/v1/live/sessions`.
- Redis: `ensaia-data`, gratuito 30 MB, sin persistencia a disco; `redis://`. Valores sensibles cifrados en la aplicación con AES-GCM y nombres de claves mediante HMAC.
- Blob privado: `ensaia-registros`, cuentas e informes/audio duraderos.
- Dispositivo autorizado: `ensaia-s3-01`.

Se eliminó únicamente `ssoProtection` de Vercel después de recibir autorización explícita. ENSAIA conserva su propia autenticación y la verificación del secreto del dispositivo. No modificar otros proyectos ni retirar controles propios de ENSAIA.

## Diseño

No usa MQTT ni laptop como puente en esta variante. `ensaia_esp32s3` y los archivos anteriores permanecen intactos. `firmware/ENSAIA_Cloud` contiene el nuevo sketch. I2S: GPIO4 BCLK, GPIO5 WS, GPIO6 SD, L/R a GND, alimentación 3V3.

PCM16 mono 16 kHz, bloques de 320 muestras/20 ms. Cada paquete WSS tiene 664 bytes: SID hexadecimal ASCII de 16 bytes, secuencia uint32 little-endian, desplazamiento en muestras uint32 little-endian y 640 bytes PCM. Se comprueban secuencia, SID, offset, total y confirmación final. El dispositivo recibe ACK cada 20 tramas. Los errores marcan la presentación como interrumpida.

El dispositivo genera credenciales y las guarda en NVS; solo se registran tras validar el secreto. No borrar NVS tras el primer registro. El servidor conserva la asociación y no acepta un reemplazo automático de contraseña. No existe todavía recuperación desde la web.

La interfaz consulta la API autenticada y muestra estado/estadísticas cada pocos segundos. Los mensajes de IA y las transcripciones se tratan como texto sin HTML. El WAV y el JSON se descargan desde rutas que comprueban propiedad. Las recomendaciones son textuales; no se ha implementado altavoz.

## Flujo implementado

1. El ESP32 conecta a Wi-Fi de 2,4 GHz, sincroniza la hora y abre WSS con validación del certificado y del dominio.
2. Envía su identificador, secreto individual y usuario/contraseña propuestos. El servidor verifica el secreto antes de crear una cuenta y conserva el vínculo entre usuario y dispositivo.
3. Tras la autorización, el Monitor Serie muestra las credenciales de acceso a la web. La orden `credenciales` permite volver a mostrarlas localmente.
4. El usuario inicia sesión en la web, elige tema, etapa (Antes, Después o práctica), duración y si desea consejos durante la toma. Debe confirmar el consentimiento de grabación y procesamiento por IA.
5. La web solicita el inicio; el servidor prepara GPT-Live y ordena al ESP32 capturar el INMP441. El audio se transmite al servidor y de allí al proveedor de IA.
6. La web presenta transcripción, consejos y estadísticas. Al finalizar se guarda el informe, el audio WAV y el registro JSON; el historial permite abrir tomas previas y comparar dos presentaciones.

El ESP32 no se conecta directamente a OpenAI ni recibe su API key. La portada es pública, pero los registros y las operaciones de grabación requieren la sesión de ENSAIA. No se implementó reproducción hablada de las recomendaciones.

## Configuración física y carga

| INMP441 | ESP32-S3 |
|---|---|
| VDD / VCC | 3V3 |
| GND / G | GND |
| SCK / BCLK | GPIO4 |
| WS / LRCLK | GPIO5 |
| SD / DOUT | GPIO6 |
| L/R | GND, canal izquierdo |

El micrófono recibe 3,3 V. La placa se alimenta por USB. El firmware utiliza ambos slots I2S de 32 bits y convierte el canal izquierdo a PCM16 mono.

Configuración compilada: Arduino-ESP32 **3.3.5**, placa **ESP32S3 Dev Module**, flash **16 MB**, QIO a **80 MHz**, PSRAM **OPI**, partición `app3M_fat9M_16MB`, USB CDC On Boot **Disabled** usando el puerto USB-UART. Bibliotecas: **WebSockets de Markus Sattler 2.7.2** y **ArduinoJson 6.21.5**. Velocidad de carga y Monitor Serie: **115200**.

En `firmware/ENSAIA_Cloud/config.h` quedan los marcadores `TU_WIFI_2_4_GHZ` y `TU_CLAVE_WIFI`; el usuario debe reemplazarlos antes de cargar. El dominio de producción ya está configurado. `secrets.h` del paquete privado ya contiene el secreto individual reconocido por el servidor. No borrarlo ni sustituirlo por una API key.

## Verificación realizada

| Alcance | Evidencia observada |
|---|---|
| Compilación de aplicación | TypeScript y Vite correctos |
| Pruebas principales | 6/6 correctas |
| Integración | Redis y Blob reales; dispositivo y coach simulados; captura, archivo WAV, registro y control de acceso correctos |
| Dependencias | Auditoría npm: 0 vulnerabilidades detectadas en la entrega |
| Producción HTTP | Portada y health 200; estado privado sin sesión 401 |
| Producción WSS | Upgrade aceptado; secreto inválido rechazado con `auth.error` y cierre 1008 |
| OpenAI real | Sesión `gpt-live-1` iniciada y cerrada con confirmación; sin enviar discurso personal |
| Interfaz publicada | Cuenta técnica: login, panel, historial vacío y comparación visibles; inicio deshabilitado con dispositivo desconectado |
| Certificado | Cadena del dominio validada con GTS Root R1, incluida en `trust.h` |
| Firmware final | Compilación correcta: 1 098 847 bytes de programa y 45 668 bytes de variables globales |

La prueba real de OpenAI **no valida aún la transcripción ni los consejos de una exposición hablada completa**. La integración sintética tampoco demuestra funcionamiento del micrófono físico ni mejora de la oratoria. Las cuentas `qa_*` y los registros simulados son datos técnicos, no participantes del estudio. La cuenta técnica usada en el navegador se cerró al terminar la revisión.

Se corrigió un fallo de arranque ESM detectado en la primera publicación. Se consultaron los logs y se verificó la versión corregida. No se observó error de consola en el panel revisado ni se configuraron alertas continuas. El servidor local de desarrollo se detuvo; la aplicación de producción funciona independientemente.

Detalle de resultados: `VERIFICACION.md`.

## Indicadores y límites

- Registro de creación, inicio y final en UTC ISO 8601; duración calculada a partir del audio recibido.
- Palabras y palabras por minuto calculadas sobre la transcripción y la duración total, incluyendo pausas.
- Candidatos a muletillas (`eh`, `em`, `mmm`, `este`, `o sea`, `digamos`, `pues`, `bueno`) y repeticiones contiguas. Requieren revisión contextual; una coincidencia no implica un error.
- Silencio estimado por RMS normalizado inferior a 0,01 y pausas prolongadas desde 0,8 segundos. Sin calibración acústica ni clasificación lingüística del silencio.
- Sin calificación validada de oratoria ni prueba causal automática de mejora.
- API: tomas de 15 a 180 segundos; interfaz: 30, 60, 120 o 180 segundos. Una presentación activa por dispositivo y una cuenta vinculada a cada unidad.
- La conexión en reposo se renueva periódicamente. Una toma interrumpida no se reanuda como si fuera íntegra.
- Se guarda un checkpoint textual cada 8 segundos. El audio se conserva en memoria y se sube al finalizar; un cierre abrupto puede perder el audio de la toma en curso.
- Si no llega un resumen de IA utilizable, se presenta una orientación heurística identificada como tal (`summarySource: heuristic`). No atribuirla al modelo.
- Redis gratuito no ofrece persistencia a disco. Blob privado conserva cuentas y archivos finalizados; la pérdida de Redis puede exigir volver a iniciar sesión.
- Historial de hasta 30 sesiones sobre una primera página de 100 archivos. Sin paginación completa, borrado automático ni recuperación de contraseña desde la interfaz.
- La clave física del dispositivo no es resistente a extracción de flash. No se configuraron Secure Boot ni cifrado de flash.

## Archivos clave

- `api/server.ts`: rutas HTTP, cookie, control de sesión y upgrade WS.
- `lib/device.ts`: autenticación, comandos y ciclo de captura/archivo.
- `lib/live.ts`: protocolo Live de OpenAI y resumen.
- `lib/store.ts`: coordinación Redis y archivos Blob privados.
- `lib/security.ts`: scrypt, verificación constante, AES-GCM, HMAC.
- `lib/metrics.ts`: indicadores exploratorios y formato WAV.
- `src/main.ts`, `src/style.css`: interfaz en español.
- `firmware/ENSAIA_Cloud/*`: programa Arduino IDE, configuración y autoridades TLS.
- `README.md`: puesta en marcha, cableado, límites y mantenimiento.
- `VERIFICACION.md`: evidencia y alcance real de las pruebas.

Las importaciones relativas TypeScript llevan extensión `.js` para funcionar en el runtime ESM de producción. La primera versión sin esta extensión falló al arrancar; se corrigió, se volvió a desplegar y se verificó health 200 y acceso privado 401.

## Secretos

Nunca imprimir ni publicar `.env.local`, `.private/provision.json` ni `firmware/ENSAIA_Cloud/secrets.h`. La clave OpenAI fue configurada en Vercel; no está en el navegador ni en el ESP32. El usuario la pegó en el chat, por lo que debe rotarla. El ZIP privado del firmware incluye únicamente su secreto individual del dispositivo, sin claves maestras ni API key. El ZIP general de fuente excluye todos los secretos.

Variables del servidor: `OPENAI_API_KEY`, `SESSION_SECRET`, `DEVICE_SECRETS`, `REDIS_URL` y `BLOB_READ_WRITE_TOKEN`. `DEVICE_SECRETS` contiene un mapa JSON de identificador a SHA-256 hexadecimal del secreto individual. `LIVE_MODEL` es opcional; el código exige `gpt-live-1`. No cambiar `SESSION_SECRET` sin planear la invalidación del estado temporal y las sesiones cifradas.

Redis utiliza transporte sin TLS nativo. El cifrado de aplicación protege valores sensibles y autentica su contexto, pero no oculta todos los metadatos ni sustituye TLS de transporte. Las comunicaciones del navegador y del ESP32 con Vercel y de Vercel con OpenAI utilizan conexiones cifradas.

Los paquetes y el frontend se revisaron para excluir claves administrativas y secretos del dispositivo en los archivos públicos. El ZIP privado contiene deliberadamente el secreto individual del ESP32 y debe conservarse en privado.

## Entregables y continuidad

Todos los archivos se encuentran bajo `/home/robertoa1/Datos/proyectos/iot-2`:

- `output/ENSAIA_Cloud_ESP32S3_PRIVADO.zip`: sketch y cabeceras, incluido `secrets.h` individual; guía y verificación. Solo para el propietario.
- `output/ENSAIA_Cloud_codigo_fuente.zip`: fuente distribuible sin `.env.local`, `.private`, `secrets.h`, dependencias instaladas ni archivos de despliegue privados. Es la entrega de código; este contexto se actualiza por separado después de generar ese ZIP.
- `output/ENSAIA_Cloud_panel.png`: evidencia del panel publicado con cuenta técnica y sin grabaciones humanas.
- `ensaia_cloud/README.md`: instrucciones completas de instalación, operación y mantenimiento.
- `ensaia_cloud/Context.md`: documento de contexto mantenido en la carpeta principal; `output/context.md` es su copia para descargar.
- `ensaia_esp32s3/Context.md`: contexto anterior de la variante con laptop; no confundirlo con esta implementación Cloud.

Para desarrollo, Node.js 24 y `npm ci`; `npm run build`, `npm test`, `npm run test:integration` y `npm run dev`. La integración necesita las variables privadas y utiliza almacenamiento real con datos técnicos. El entorno local abre frontend en 5173 y API en 8787. El proyecto ya está vinculado a Vercel; una publicación nueva debe usar únicamente `ensaia-oratoria` del equipo `roberto-pro` y conservar las exclusiones de `.vercelignore`.

## Pendiente presencial

El usuario ya configuró Wi-Fi y cargó el firmware en la placa: se observaron `WiFi=SI` y `Web=SI`. En este equipo `/dev/ttyACM0` corresponde al USB nativo del ESP32 y `/dev/ttyACM1` al conversor USB-serie; la numeración puede cambiar al reconectar. Con USB CDC On Boot desactivado, el firmware enviaba los mensajes por `/dev/ttyACM1` a 115200 baudios. El pico del micrófono llegó con frecuencia a 32767–32768, por lo que todavía es necesario revisar ganancia o cableado si persiste en silencio.

El 26 de octubre se diagnosticaron dos intentos físicos fallidos: IA conectada y captura confirmada, pero cierre inmediato con cero tramas. La causa era usar `now` calculado antes de `cloud.loop()` para comparar con `startedAt`, que podía actualizarse dentro de ese llamado. La resta sin signo se desbordaba y superaba el tiempo límite. Se reemplazó por `millis()-startedAt`, después de procesar la conexión. La corrección está en la carpeta fuente y en el sketch extraído en `output/ENSAIA_Cloud_ESP32S3_PRIVADO/ENSAIA_Cloud/`; este último conserva la configuración Wi-Fi del usuario. Arduino IDE debe recargar el archivo actualizado y volver a subirlo. No se ha confirmado todavía una captura hablada completa con la corrección.

Más tarde, con la corrección cargada, se observaron dos tomas físicas: una terminó con `audio_queue_full` y otra transmitió 2 999 tramas completas, pero todas sus muestras eran cero (`peak=0`) y no produjo transcripción. El usuario confirmó el cableado L/R y GND a tierra, VDD a 3V3, SD a GPIO6, SCK a GPIO4 y WS a GPIO5. Los datos confirman ausencia de señal en el canal procesado, pero no permiten distinguir todavía cable defectuoso, módulo, canal o lectura I2S.

Para diagnosticar, el sketch actualizado muestra en el Monitor Serie los picos `Izq` y `Der`; sigue enviando el canal izquierdo. No interpretar automáticamente la actividad del canal no seleccionado como voz: puede contener ruido del pin flotante. Se corrigió también el valor de pico comunicado al servidor, que antes podía leerse después de reiniciarlo. El usuario debe volver a cargar el sketch y comparar los valores mientras habla y guarda silencio.

El servidor se ajustó para liberar el bloqueo del dispositivo al cerrar su WebSocket, antes de terminar el archivado, y para detener la renovación de conexiones que no envían mensajes durante 15 segundos. Mantiene el rechazo de dos conexiones simultáneas. También marca como interrumpida una toma formada íntegramente por ceros y avisa que se revise el micrófono. Las pruebas de integración usan nodos simulados y almacenamiento real; la estabilidad con el dispositivo y la transcripción real requieren prueba posterior.

Siguiente comprobación presencial: después de subir la corrección, observar `DISPOSITIVO AUTORIZADO` en el Monitor Serie, iniciar una toma breve desde la web, hablar, finalizar y contrastar transcripción, recomendaciones, resumen, duración y WAV descargado con lo realmente capturado. Si falla, solicitar el mensaje exacto del Monitor Serie sin pedir contraseñas ni secretos.

La rotación de la clave OpenAI expuesta también sigue pendiente de confirmación: reemplazarla en Vercel para Production y Development y volver a desplegar. No requiere modificar el firmware. No solicitar que la nueva clave se pegue en el chat.

En los datos anteriores del artículo, D001–D010 corresponden a David, una persona. Leyó guiones antes y después, y consultó recomendaciones IA **antes de iniciar** la lectura posterior. No inferir diez participantes ni retroactividad del feedback en vivo de esta versión.


## Actualización: dos modos y voz (26 de octubre de 2026)

Se añadió Whisper local en CPU con `faster-whisper` y ventana de cuatro segundos; el audio viaja de ESP32 a Vercel, por Redis cifrado al proceso local autenticado, y solo la transcripción se envía al modelo de texto `gpt-5.6-luna`. GPT-Live 1 sigue disponible. La web usa voz en español del navegador o, si no hay una disponible, una voz Piper local en la misma laptop; incluye botón de prueba, selector, consentimiento y avisos de señal sin calibrar. La laptop debe ejecutar `./iniciar_whisper.sh`; ver `whisper_local/README.md`. No habilitar sin consentimiento el intercambio de datos para tokens gratuitos.

La muestra pública en español de 4,3 s se transcribió localmente en 0,45 s en esta CPU; no demuestra rendimiento o precisión con el INMP441 ni a distancia. Una integración completa se probó con audio público y ESP32 simulado, Whisper real y API de texto real. La salida de voz audible en el navegador y el flujo con la placa y el micrófono físicos requieren validación del usuario. El modelo `base` procesa fragmentos; límites por cortes de frase y ruido.

## Actualización: evaluación formativa en vivo (26 de octubre de 2026)

La producción `ensaia-oratoria.vercel.app` incorpora una vista compacta durante la captura, con transcripción y consejos en paralelo, rúbrica de IA, indicadores de señal recientes y comparación de puntuaciones entre presentaciones. El público puede indicarse opcionalmente. La puntuación de 0 a 100 es el promedio de claridad, organización y desarrollo, solo cuando hay citas textuales para las tres dimensiones; es una estimación formativa no validada. En cada sesión se guardan puntos basados en la transcripción acumulada, aproximadamente cada 30 segundos y al final. La IA puede equivocarse y la detección de muletillas es exploratoria. No se miden gestos, contacto visual ni volumen en dB del aula. Los detalles y fuentes están en `RUBRICA_ORATORIA.md`.

Se mantienen los modos Whisper local y GPT-Live; la rúbrica usa además el modelo de texto configurado en ambos casos, por lo que genera llamadas adicionales potencialmente cobrables. Se probó la interfaz con datos simulados, la evaluación con el proveedor real y los flujos de ambos modos con dispositivo simulado. Falta verificar las recomendaciones y el sonido con el ESP32 e INMP441 físicos y distintas distancias. Despliegue de producción: `dpl_5qeS4b4wMJVQpwB7FS3M5RQypjAx`.

La versión posterior agrega ritmo reciente aproximado (30 s, según llegada de transcripción), frecuencia de candidatos por 100 palabras y rangos orientativos comunes para la puntuación. Descarta consejos de Whisper que llegan después de que se solicita el resumen. Los límites y detalles están en `RUBRICA_ORATORIA.md`; se verificaron diez pruebas de lógica y el flujo de Whisper simulado. El ESP32 continuaba desconectado al verificar el despliegue, por lo que sigue pendiente la comprobación con voz y micrófono reales.

La opción «Consejos mientras hablas» desactivada también oculta durante la toma las puntuaciones y estadísticas de desempeño; la evaluación se solicita después. Los avisos técnicos se muestran sin lectura automática. La transcripción y el contador de palabras siguen visibles, lo que puede influir en una línea de base: evitar que la persona vea la pantalla cuando el protocolo exija ausencia de retroalimentación. Los fallos de evaluación se informan sin interrumpir la captura, y se cancelan recomendaciones de voz pendientes al detener o iniciar otra sesión.

«Mi progreso» muestra las puntuaciones disponibles de prácticas completas en orden cronológico y sus diferencias descriptivas. La comparación selecciona las dos tomas más recientes de antigua a reciente y advierte sobre orden inverso o datos incompletos. Se omitirá una puntuación de la comparación y del historial si la última evaluación falló, para evitar mostrar una puntuación anterior como si fuese el resultado final.

El panel de posibles muletillas incluye hasta cinco fragmentos literales de la transcripción con la coincidencia resaltada. El contador y los ejemplos comparten las mismas reglas léxicas; los límites de palabra consideran letras Unicode y los fragmentos son candidatos para revisión, no errores confirmados.

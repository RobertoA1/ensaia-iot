# ENSAIA Cloud — ESP32-S3 + INMP441

Aplicación publicada: **https://ensaia-oratoria.vercel.app**

Versión preparada el 26 de octubre de 2026. El ESP32 se comunica directamente con Vercel mediante WebSocket cifrado (WSS). El servidor abre una sesión real con `gpt-live-1`. No se requiere mantener encendida una laptop, ni utilizar ESP8266 o MQTT en esta variante. El proyecto anterior de MQTT permanece separado e intacto.

## Puesta en marcha del ESP32

1. Extrae el ZIP privado y abre `ENSAIA_Cloud/ENSAIA_Cloud.ino` en Arduino IDE. Mantén juntos todos los archivos de esa carpeta.
2. En `config.h`, reemplaza únicamente `WIFI_SSID` y `WIFI_PASSWORD` por una red de **2,4 GHz con acceso a Internet**. El dominio ya está configurado.
3. El paquete privado incluye `secrets.h` con el identificador `ensaia-s3-01` y su secreto individual, ya reconocido por el servidor. **No lo publiques ni lo compartas con terceros.** La clave de OpenAI permanece exclusivamente en Vercel.
4. Instala las versiones de placa y bibliotecas indicadas abajo. Selecciona el puerto USB-UART de la placa y carga el programa.
5. Abre el Monitor Serie a **115200 baudios**. Espera `DISPOSITIVO AUTORIZADO`. Aparecerán la dirección web, el usuario y la contraseña generados por el ESP32. Escribe `credenciales` y pulsa Enter si necesitas volver a verlos.
6. Entra en la web con esas credenciales. Completa tema, etapa y duración, confirma la grabación y pulsa **Iniciar mi presentación**. Los consejos se muestran en la web y en el Monitor Serie. Pulsa **Finalizar** o espera el límite seleccionado.
7. Espera a que termine de guardar. Consulta el resumen, las estadísticas y el historial; descarga el registro JSON y el audio WAV desde tu sesión.

El usuario y la contraseña se conservan en NVS. **No borres toda la memoria flash después del primer registro**: generar una contraseña nueva no reemplaza la que ya está vinculada en el servidor. Una carga normal sin borrar NVS conserva el acceso. Si se pierde NVS, se necesita recuperar las credenciales originales o realizar una recuperación administrativa del vínculo; no hay restablecimiento automático implementado.

## Conexiones

Desconecta la alimentación antes de cablear. Usa la numeración GPIO, no la posición física del conector.

| INMP441 | ESP32-S3-DevKitC-1 N16R8 |
|---|---|
| VDD / VCC | 3V3 |
| GND / G | GND |
| SCK / BCLK | GPIO4 |
| WS / LRCLK | GPIO5 |
| SD / DOUT | GPIO6 |
| L/R | GND: selecciona el canal izquierdo |

Alimenta la placa por USB. El micrófono trabaja a **3,3 V**. `L/R` selecciona el canal del micrófono; no es otra salida de audio. No se ha implementado altavoz: la retroalimentación es textual.

## Arduino IDE

Configuración compilada y verificada:

| Opción | Valor |
|---|---|
| Paquete esp32 de Espressif | 3.3.5 |
| Placa | ESP32S3 Dev Module |
| Flash Size | 16 MB |
| Flash Mode / Frequency | QIO / 80 MHz |
| PSRAM | OPI PSRAM |
| Partition Scheme | 3 MB APP / 9 MB FATFS para flash de 16 MB (`app3M_fat9M_16MB`) |
| USB CDC On Boot | Disabled, usando el puerto USB-UART |
| Upload Speed | 115200 |
| Monitor Serie | 115200 |
| Biblioteca WebSockets, Markus Sattler | 2.7.2 |
| Biblioteca ArduinoJson, Benoit Blanchon | 6.21.5 |

Si Arduino IDE muestra nombres ligeramente distintos, conserva los valores equivalentes. La compilación utiliza aproximadamente 1,10 MB de programa y 45,7 kB de variables globales; esto no equivale al consumo máximo durante una sesión TLS.

## Qué se registra

- Tema, etapa (`pre`, `post`, `practice`), límite y estado de la sesión.
- Hora de creación, inicio y final en ISO 8601 UTC; la web presenta las fechas locales.
- Audio PCM16 mono a 16000 Hz, archivado como WAV privado.
- Transcripción y recomendaciones de IA; eventos con hora y posición aproximada en el audio.
- Duración del audio recibido, palabras, palabras por minuto, candidatos a muletillas, repeticiones contiguas y pausas estimadas.
- Resumen final y su origen: `gpt-live-1` o `heuristic` si el proveedor no entrega un resumen utilizable.
- Integridad: tramas recibidas/esperadas, cierre confirmado del proveedor y estado completo o interrumpido.

Los candidatos a muletillas requieren revisión contextual. Las pausas se estiman con energía RMS baja y un umbral de 0,8 s, sin calibración acústica ni clasificación lingüística. El ritmo usa palabras transcritas divididas por la duración total del audio, incluyendo pausas. No existe una puntuación validada de calidad de oratoria. Los errores de transcripción afectan los indicadores textuales.

El resumen y las recomendaciones pueden equivocarse. El WAV permite contrastarlos. La comparación Antes/Después es descriptiva y no demuestra por sí sola un efecto causal. Para el artículo previo, D001–D010 siguen siendo diez evaluaciones de David, **una persona**, con recomendaciones consultadas antes de la lectura posterior; esta nueva capacidad de feedback en vivo no modifica aquel procedimiento.

## Arquitectura y seguridad

`INMP441 → I2S → ESP32-S3 → WSS → servidor Vercel → GPT-Live 1`

`Navegador → HTTPS → servidor Vercel → Redis / Blob privado`

El servidor verifica el secreto del dispositivo antes de registrar el usuario propuesto. El vínculo dispositivo/usuario se conserva y rechaza credenciales diferentes en reconexiones. Las contraseñas se almacenan con scrypt y sal. La web usa una cookie HttpOnly, Secure en Vercel y SameSite Strict; los archivos se entregan únicamente al propietario autenticado. Se aplican límites a registros de conexión e intentos de inicio de sesión.

Se retiró **solo Vercel Authentication/SSO**, con autorización explícita del usuario, para admitir al ESP32. La portada es pública; el panel y los registros mantienen la autenticación de ENSAIA. El secreto incluido en el firmware identifica a esta unidad, pero no protege frente a alguien con acceso físico capaz de extraer su flash. No se ha configurado cifrado de flash ni Secure Boot.

El ESP32 verifica el certificado y el nombre del servidor, después de sincronizar la hora. `trust.h` incluye autoridades públicas; la cadena observada del dominio utiliza GTS Root R1. Si Vercel cambia de autoridad a una no incluida, se deberá actualizar el firmware. No se utiliza `setInsecure()`.

Redis mantiene comandos, presencia, bloqueo de dispositivo y estado vivo. El servicio gratuito provisionado usa `redis://`, sin TLS nativo: los valores que contienen usuarios, transcripciones o comandos se cifran con AES-256-GCM y contexto autenticado; los nombres de claves se ocultan mediante HMAC. Esto no elimina la visibilidad de metadatos ni sustituye TLS de transporte. Las cuentas, informes y audios finalizados se guardan en **Vercel Blob privado**. La pérdida de Redis requiere volver a iniciar sesión; los archivos duraderos permanecen en Blob.

## Límites de esta versión

- Una cuenta vinculada al dispositivo y una presentación activa por dispositivo; no es un sistema multiestudiante con identificación automática.
- Grabaciones de **15 a 180 segundos** por la API; la interfaz ofrece 30, 60, 120 y 180 segundos.
- La conexión en reposo se renueva periódicamente para mantenerse dentro del límite de ejecución de Vercel. Una toma interrumpida se conserva como tal y no se reanuda silenciosamente.
- El audio completo se conserva en memoria durante la toma y se archiva al finalizar. Un cierre abrupto del proceso puede perder el audio en curso; el registro textual se guarda periódicamente cada 8 segundos. No se promete recuperación íntegra de una toma fallida.
- El historial muestra hasta 30 sesiones dentro de una primera página de hasta 100 archivos. No hay paginación completa, borrado automático, cuotas individuales ni recuperación de contraseña en la interfaz.
- El plan Redis gratuito tiene 30 MB y no ofrece persistencia a disco. Los planes y cuotas de Vercel/Blob/OpenAI pueden limitar la prueba. La IA consume saldo de API; no se contrató un plan de pago nuevo.
- El micrófono físico y el Wi-Fi del usuario aún requieren la prueba presencial. No se ha cargado el programa en la placa desde este equipo.

## Mantenimiento del servidor

Carpeta local: `ensaia_cloud`. Node.js 24, TypeScript, Vite, servidor HTTP/WebSocket `ws`, Redis y Blob privado. `npm ci`, `npm run build`, `npm test`; `npm run test:integration` usa los servicios configurados y un proveedor IA simulado, con datos técnicos identificados como tales. `npm run dev` levanta el frontend en 5173 y la API en 8787.

Variables de entorno, exclusivamente del servidor:

| Variable | Función |
|---|---|
| `OPENAI_API_KEY` | Acceso real a GPT-Live 1 |
| `SESSION_SECRET` | Secreto maestro para cifrado y nombres de claves |
| `DEVICE_SECRETS` | JSON de identificador de dispositivo a SHA-256 hexadecimal de su secreto |
| `REDIS_URL` | Coordinación y estado temporal |
| `BLOB_READ_WRITE_TOKEN` | Almacenamiento privado |
| `LIVE_MODEL` | Opcional; esta implementación exige `gpt-live-1` |

No cambies `SESSION_SECRET` sin planear la invalidación de las sesiones y el estado temporal cifrado. El archivo local `.private/provision.json` y `.env.local` son respaldos administrativos privados y se excluyen de los paquetes y despliegues. El código fuente distribuible incluye una plantilla de firmware sin secreto.

**Rota la clave OpenAI que se pegó en el chat**: crea otra, reemplaza `OPENAI_API_KEY` en Vercel para Production y Development y vuelve a desplegar antes de revocar la anterior. No es necesario volver a programar el ESP32. No pegues la nueva clave en mensajes ni en `config.h`.

Documentación de referencia: [WebSockets de Vercel](https://vercel.com/docs/functions/websockets), [duración de Functions](https://vercel.com/docs/functions/configuring-functions/duration), [GPT-Live mediante WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets), [Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk).

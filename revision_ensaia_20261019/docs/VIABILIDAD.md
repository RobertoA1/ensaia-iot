# Viabilidad de la fase temprana

Fecha de revisión: 17 de octubre de 2026.

## Conclusión

Es viable construir el entrenador con celular, ESP8266, laptop y GPT-Live 1. La implementación entregada utiliza **la laptop como pasarela de OpenAI**, además de servidor de registros y broker MQTT. Esta decisión evita concentrar audio, TLS y persistencia en el ESP8266 y conserva la clave API en el servidor.

La conexión directa ESP8266 → OpenAI que se solicitó **no está implementada ni certificada como viable en esta entrega**. Tampoco se presupone que sea físicamente imposible: sería otro desarrollo con medición de memoria, buffers, certificados y estabilidad en la placa real. El núcleo ESP8266 documenta un costo apreciable de RAM y CPU para TLS, mientras que la cantidad de flash del módulo no amplía la RAM disponible. [Documentación de BearSSL del núcleo ESP8266](https://arduino-esp8266.readthedocs.io/en/latest/esp8266wifi/bearssl-client-secure-class.html).

## Decisiones concretas

| Requisito | Resultado |
|---|---|
| Celular como micrófono | Implementado mediante página HTTPS y captura PCM remuestreada |
| ESP8266 de la placa indicada | Firmware para Generic ESP8266 Module; ATmega328P independiente |
| GPT-Live-1 | Modelo oficial confirmado; adaptador específico `gpt-live-1` |
| Conexión directa ESP8266–OpenAI | Sustituida explícitamente por pasarela en laptop |
| ESP8266 recibe y envía audio | Relevo MQTT de las tramas de captura |
| ESP8266 envía todo el texto por MQTT | Reenvía eventos de texto y confirma recepción al servidor |
| Feedback en tiempo real | Flujo de texto del modelo, mostrado tras confirmación de la placa; latencia por medir |
| Voz desde el ESP8266 | No implementada; la placa no incluye un sistema de reproducción |
| Voz opcional en el celular | Salida del proveedor reproducida desde la pasarela; requiere auriculares para evitar realimentación |
| Detectar todas las muletillas | No garantizable; candidatos + audio para revisión humana |
| INMP441 futuro | Captura por ESP32 prevista mediante interfaz de audio común; firmware capturador pendiente |

## GPT-Live confirmado en la documentación oficial

GPT-Live 1 se publica como modelo de conversación de voz bidireccional. El protocolo WebSocket consultado usa `wss://api.openai.com/v1/live/sessions`, un evento inicial `session.start`, el modelo dentro de `session`, audio PCM y eventos separados para transcripción de entrada y salida. Se preservó ese modelo; no se usa como si fuera un modelo de Chat Completions o el antiguo protocolo Realtime. [Modelo](https://developers.openai.com/api/docs/models/gpt-live-1), [conexión WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets), [gestión de sesiones](https://developers.openai.com/api/docs/guides/live-conversations).

La disponibilidad para tu cuenta y el desempeño con español peruano se comprobarán al proporcionar una clave con acceso. El código espera `session.closed` y registra si el proveedor no confirmó el cierre. La prueba con proveedor simulado no confirma acceso a la API real.

La tarifa publicada de voz al revisar la documentación es **USD 0.05 por minuto**, con otros consumos de backend separados. Ochenta minutos de voz equivaldrían a USD 4, antes de otros consumos y tiempos de conexión; se debe comprobar la tarifa y el uso real antes de la jornada. [Modelo y tarifa](https://developers.openai.com/api/docs/models/gpt-live-1).

## Celular y conexión segura

La captura del navegador requiere HTTPS confiable o localhost. Localhost en el teléfono es el propio teléfono, no la laptop: abrir una IP privada por HTTP no resuelve ese requisito. Se proporcionan certificados de laboratorio y pasos de instalación manual de confianza. [MediaDevices.getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

La subida usa WebSocket del mismo origen que la página HTTPS. El servidor publica audio binario en MQTT local. Esto evita pedir a la placa que sirva la página móvil, maneje su TLS y abra al mismo tiempo la conexión con OpenAI.

## La placa de la imagen

La imagen aportada distingue dos procesadores. La flash de 8 MB corresponde al ESP8266; los conectores del formato Uno pertenecen mayoritariamente al ATmega328P. El ESP no se programa seleccionando Arduino Uno. Las posiciones DIP de carga y ejecución se contrastaron con una [guía de esta familia de placas alojada en el foro de Arduino](https://forum.arduino.cc/uploads/short-url/m8ekC3iuqR0cD2XwjJApkRwk4OJ.pdf), páginas 3 y 8. Esa guía es comunitaria y corresponde a una variante de flash distinta; la memoria real se verifica en el arranque. La página histórica del fabricante no pudo recuperarse de forma completa durante esta revisión.

No se debe copiar de esa guía firmware AT ni ejemplos antiguos de SQL: aquí se usa un sketch autónomo ESP8266 y la configuración descrita en el README. No hace falta flashear un firmware AT antes del sketch.

## Calidad del registro para el paper

Cada sesión conserva audio original, audio retransmitido y texto exacto recibido del proveedor. Los eventos de detección contienen candidatos, su origen y el estado de validación. La detección mediante texto no recupera sonidos eliminados por el reconocedor; el conteo de referencia debe verificarse escuchando el audio. La literatura distingue reconocimiento de voz y preservación/eliminación de disfluencias. [Referencia técnica](https://aclanthology.org/2020.findings-emnlp.186/).

Para comparar antes/después, la pantalla permite desactivar consejos sin dejar de registrar. Debe fijarse de antemano si la intervención será durante la exposición o entre exposiciones; no mezclar esas condiciones como si fueran iguales. El sistema ofrece almacenamiento e indicadores, no resultados humanos ya obtenidos.

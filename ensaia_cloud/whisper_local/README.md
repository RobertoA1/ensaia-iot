# ENSAIA: transcripción local y voz

## Los dos modos

- **Whisper en mi laptop + IA de texto** (predeterminado): el ESP32 envía audio PCM a ENSAIA en Vercel. La laptop recibe fragmentos cifrados y los transcribe con `faster-whisper` y el modelo abierto Whisper `base` (CPU, int8). El servidor envía texto a `gpt-5.6-luna` para consejos y resumen. La transcripción llega por bloques de aproximadamente cuatro segundos; el tiempo real también depende de red, equipo y respuesta del proveedor.
- **GPT-Live 1**: conserva el funcionamiento anterior. El servidor envía el audio a OpenAI y recibe transcripción y recomendaciones. No necesita iniciar Whisper en la laptop.

En ambos modos la página muestra la transcripción y, si están habilitados los consejos y «Leer consejos en voz alta», usa una voz en español del navegador cuando está disponible. Si no hay una, la web solicita a la laptop una reproducción local mediante Piper, sin coste de API de voz. Para esta alternativa, ejecuta `./iniciar_whisper.sh` en la misma laptop donde está abierto el navegador. Comprueba que la salida de audio no esté silenciada y usa el botón «Probar voz». La reproducción en voz puede ser captada por el micrófono; coloca el altavoz y el INMP441 de forma que se reduzca ese acoplamiento. Los navegadores pueden exigir interacción previa para reproducir audio; iniciar la presentación proporciona esa interacción.

## Cómo iniciar Whisper en esta laptop

En una terminal ejecuta:

```bash
cd /home/robertoa1/Datos/proyectos/iot-2/ensaia_cloud
./iniciar_whisper.sh
```

La primera ejecución instala paquetes en `.venv-whisper` si faltan y descarga el modelo `base` y la voz Piper en español si no están presentes. Requiere Internet para la descarga, la conexión a ENSAIA y el análisis de texto. Espera el mensaje «Whisper conectado» y deja la terminal abierta. Abre la web y selecciona «Whisper en mi laptop + IA de texto». Pulsa Ctrl+C para detener el servicio cuando acabes.

El programa usa `.private/provision.json` para autenticarse con el secreto del dispositivo; no contiene ni necesita la clave de OpenAI. No publiques ni compartas ese archivo. Whisper procesa localmente, pero **el audio pasa por Vercel y Redis antes de llegar a la laptop** y el texto se envía al proveedor de IA. Las sesiones y el WAV también se archivan en Blob privado. La configuración de privacidad y consentimiento debe reflejar todo el recorrido.

Opcionalmente, antes de arrancar puedes establecer `ENSAIA_WHISPER_MODEL=tiny` para reducir recursos o `small` para priorizar precisión; el primer uso descarga el modelo. Su rendimiento debe medirse en tu equipo y en las condiciones reales. No cambies el modelo a mitad de un estudio sin documentarlo.

## Señal a distancia

El nivel es un indicador digital sin calibrar, no un sonómetro ni una medición objetiva de proyección vocal. Si la señal es exactamente cero durante varios segundos, la web pide revisar el micrófono. Si la señal ha sido muy débil o ha habido silencio durante un periodo, sugiere condicionalmente proyectar la voz o acercarse. Estos umbrales pueden confundirse con pausas, ruido o posición del micrófono. No se diagnostica ni se afirma que el participante habla bajo con certeza.

Ajusta y prueba el INMP441 en el lugar real de la audiencia. Comprueba una grabación de muestra, la transcripción, ruido y retroalimentación del altavoz a distintas distancias. Si el montaje capta cero o satura, una IA no puede recuperar voz ausente o recortada; revisa soldaduras, cables, orientación y alimentación. El medidor de diagnóstico del firmware muestra ambos canales, pero el sistema sigue usando el izquierdo con L/R conectado a GND.

## Costos y datos compartidos

Whisper local no cobra por minuto de transcripción, pero consume recursos de la laptop y red. Las llamadas al modelo de texto, Vercel, Redis y Blob pueden tener costos o límites. Los consejos se limitan a una solicitud por cada 20 segundos como mínimo y la sesión a 180 segundos. No se ha establecido un límite de gasto automático.

Los tokens gratuitos de OpenAI dependen de la elegibilidad, del modelo y de las opciones de intercambio de datos de la organización; no debe suponerse que todas las llamadas son gratuitas. Comprueba tu cuenta y los límites antes del estudio. Se requieren permisos apropiados de los participantes si se habilita compartir datos para mejorar modelos. No activamos esa opción.

Referencia oficial: https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai

La voz alternativa usa `piper-tts` bajo GPL-3.0 y el modelo `es_MX-claude-high`, cuya ficha declara datos Apache-2.0: https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_MX/claude/high/MODEL_CARD. El servicio local se limita a 127.0.0.1:18765, acepta solicitudes solo desde el origen de ENSAIA o el entorno local de desarrollo y reproduce mediante `paplay`. Si abres la web desde un teléfono u otra computadora, usa una voz del propio navegador: 127.0.0.1 apunta a ese dispositivo, no a la laptop.

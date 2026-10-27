# Verificación del paquete — 26 de octubre de 2026

## Compilación del firmware

Compilación real del sketch entregado con el compilador y SDK oficiales de Arduino-ESP32 **3.3.5**, PubSubClient **2.8** y ArduinoJson **6.21.5**.

Destino utilizado:

```text
esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,FlashMode=qio,PartitionScheme=app3M_fat9M_16MB,CDCOnBoot=default
```

Resultado:

```text
Sketch uses 899863 bytes (28%) of program storage space. Maximum is 3145728 bytes.
Global variables use 51004 bytes (15%) of dynamic memory, leaving 276676 bytes for local variables. Maximum is 327680 bytes.
```

La RAM global indicada no incluye las reservas dinámicas al ejecutar Wi-Fi, MQTT, tareas y colas. La compilación no demuestra memoria libre ni estabilidad medidas en una placa física.

El entorno de compilación se aisló en una carpeta temporal. Para evitar descargar compiladores de otras arquitecturas se limitaron las dependencias de instalación a las necesarias para S3; se conservaron los archivos oficiales del core, SDK, compilador, bibliotecas y sus checksums. No se modificó el Arduino IDE del usuario ni se cargó un programa a su placa.

## Pruebas de software

**5 pruebas aprobadas** con datos sintéticos y proveedor de IA simulado, sin claves reales ni consumo de API:

1. Ejecución del código C++ real de conversión de I2S de 32 bits a PCM16: signos, saturación por ganancia, cabecera y orden de bytes.
2. Broker MQTT TCP y servidor ENSAIA reales, nodo S3 simulado: captura → puente → servidor → relevo MQTT → persistencia. Comparación byte por byte de ambos WAV y verificación de cierre y eventos confirmados.
3. Pérdida deliberada de una trama en la fuente: el puente detecta el salto y la sesión se registra como interrumpida.
4. Rechazo de paquetes truncados y offsets de muestras inválidos.
5. Detección de pérdida de la última trama mediante el total confirmado al detener el micrófono.

Resultado: `5 passed, 1 warning in 8.56s`. La advertencia procede de la dependencia anterior `passlib`, por la futura retirada de `crypt` en Python 3.13; el entorno de prueba usa Python 3.11.

Las pruebas utilizan la versión del servidor extraída en `revision_ensaia_20261019`. No modifican las sesiones reales de esa carpeta. Para repetirlas desde la raíz del workspace:

```bash
.venv-oratoria/bin/python -m pytest ensaia_esp32s3/tests -q
```

## Comprobaciones que debe completar el montaje físico

- Reconocimiento de los 16 MB de flash y 8 MB de PSRAM al arrancar.
- Variación del nivel del INMP441 al hablar y reproducción de la voz en el WAV.
- Estabilidad Wi-Fi/MQTT en la red del aula.
- Conexión real al proveedor y recepción de texto/consejos con la configuración de la laptop.
- Latencia, calidad de la transcripción y utilidad del feedback.

No se presentan las pruebas de software como evidencia experimental de mejora de oratoria ni como validación física del hardware.

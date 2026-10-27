# Verificación — 26 de octubre de 2026

## Resultado observado

Producción: https://ensaia-oratoria.vercel.app

Despliegue corregido: `dpl_HbTV37ggeRTJNifrZ6R47dpTrerx`, alias de producción asignado. La primera publicación arrancaba con un error ESM; se corrigieron las extensiones de importación y se publicó nuevamente.

| Comprobación | Resultado |
|---|---|
| Compilación TypeScript y frontend Vite | Correcta |
| Seis pruebas automatizadas principales | 6/6 correctas |
| Integración con Redis y Blob reales, dispositivo y coach simulados | Correcta; captura, fin, archivo, WAV, autenticación y rechazo de acceso ajeno |
| Auditoría npm tras corregir dependencia transitiva | 0 vulnerabilidades detectadas |
| Portada pública de producción | HTTP 200, sin pantalla SSO |
| API `action=health` en producción | HTTP 200, `ok: true` |
| API `action=state` sin cookie | HTTP 401 |
| Upgrade WSS de producción | Aceptado |
| WSS con secreto inválido | `auth.error`, cierre 1008 |
| Conexión real a OpenAI con la clave configurada | `session.started` y `session.closed`, cierre confirmado; sin grabación personal enviada |
| Navegador en producción, cuenta técnica | Login correcto; panel, historial vacío y dispositivo desconectado visibles; inicio deshabilitado |
| Consola del panel durante revisión | Sin errores observados |
| Certificado del dominio | Cadena validada con GTS Root R1; autoridad incluida en firmware |
| Firmware final N16R8 | Compila: 1 098 847 bytes de programa, 45 668 bytes globales |

La integración usa tramas PCM sintéticas y un proveedor IA simulado explícitamente identificado. Valida transporte, comandos, archivo y autorización; no valida la precisión de la IA ni representa participantes humanos. La comprobación real de OpenAI abrió/cerró una sesión sin discurso; no prueba aún la calidad de transcripción o recomendaciones.

Las pruebas de seguridad incluyen secreto inválido sin creación de cuenta, contraseña incorrecta, inicio sin sesión, origen ajeno, consentimiento ausente, intento de apropiación de usuario y lectura de archivos de otro propietario. También comprueban formato WAV, secuencia y duración real de audio. No constituyen una auditoría de seguridad exhaustiva.

## Observabilidad y límites

Se consultaron los registros de ejecución para identificar el fallo de arranque de la primera publicación. La versión corregida respondió correctamente a las comprobaciones HTTP y WSS. Los logs de aplicación evitan imprimir claves, contraseñas y transcripciones. Vercel conserva los logs según la retención del plan; no se instaló un servicio adicional de monitorización ni se prometen alertas continuas.

No hay evidencia de carga física en el ESP32, audio real del INMP441 ni una sesión hablada completa desde la placa en la red del usuario. Esas tres comprobaciones requieren el hardware y Wi-Fi del usuario. La captura está limitada a tres minutos; una pérdida abrupta del proceso puede perder audio en curso. Las sesiones incompletas se etiquetan como interrumpidas.

Evidencia visual: `../output/ENSAIA_Cloud_panel.png`, panel publicado con una cuenta técnica de prueba y sin datos humanos.

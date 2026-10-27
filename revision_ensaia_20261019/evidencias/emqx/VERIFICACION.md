# Verificacion de EMQX

Fecha de ejecucion: 2026-10-18 (America/Lima).

## Comprobado en este equipo

- Suite final con EMQX real habilitado: 51 pruebas correctas; una advertencia de
  deprecacion de Starlette/httpx, sin fallos ni pruebas omitidas.
- EMQX estandar 6.3.2 en Docker, nodo `emqx@broker.oratoria.local`, estado healthy.
- MQTT en 1884; Dashboard en http://localhost:18083 limitado al equipo local.
- Diez mensajes numerados recibidos sin faltantes, duplicados ni contenido alterado.
- Aislamiento de suscripcion exacta frente a otro topico.
- Rechazo explicito de contrasena incorrecta y de conexion anonima.
- Rechazo MQTT 5 de publicacion y suscripcion fuera del espacio permitido.
- Publicador y suscriptor ejecutados como procesos independientes, ambos con salida 0.
- Reinicio real del contenedor: corte observado, reconexion, resuscripcion y mensaje nuevo
  recibido sin duplicacion observada. Dos conexiones realmente perdidas (una por cliente).
- Credenciales de clientes y panel conservadas tras reiniciar el broker.
- Snapshot API con version, dos clientes de evidencia, suscripcion, estadisticas y metricas.
- Dos sesiones completas a traves de EMQX con nodo y proveedor simulados, con 100 tramas
  de PCM por sesion, WAV accesibles, cero eventos pendientes y registros separados.
- Firmware compilado con MQTT actualizado a 192.168.1.62:1884; no cargado a hardware.

Los informes JSONL y `broker_snapshot.json` se guardan localmente junto a este documento.
Los IDs identifican cada ejecucion; no se deben sumar ejecuciones distintas como una sola.
El snapshot tiene contadores globales del broker, no solo de los diez mensajes de prueba.

## Pendiente de validacion fisica

- Conectar placa: COM9 no estaba disponible durante la implementacion.
- Cargar el firmware preparado y comprobar recuperacion de Wi-Fi en la placa.
- Verificar acceso LAN y firewall. El script de regla limitada esta preparado; no se
  ha aplicado una apertura automatica ni comprobado acceso desde otro equipo.
- Sesion desde celular con microfono real, placa fisica, GPT-Live real y cierre/reproduccion.
- Video corto mostrando el resultado con conexiones y contenido recibido.

No se hicieron llamadas a OpenAI para estas pruebas. No se modificaron grabaciones,
revisiones humanas ni la base SQLite del estudio. No se afirma mejora de oratoria.

## Repetir

Ver `docs/LABORATORIO_EMQX.md` para configuracion, comandos, ubicacion de credenciales
privadas, verificador, prueba de seguridad y prueba explicita de corte del broker.

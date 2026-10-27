# Laboratorio EMQX y entrenador

Se autorizo Docker para EMQX estandar despues de identificar que el checklist inicial
sin Docker/VM no era compatible con los paquetes actuales para Windows. No se sustituyo
EMQX por MQTTX, EMQX Edge ni AMQTT. La imagen se fija en `emqx/emqx-enterprise:6.3.2`.
La denominacion Enterprise es la distribucion actual; no se presenta como Community.

## Preparar, iniciar y administrar

Desde la raiz del proyecto, en PowerShell:

```powershell
.\.venv\Scripts\python.exe -m tools.preparar_emqx
docker compose -f infra/emqx/compose.yaml up -d
docker compose -f infra/emqx/compose.yaml ps
docker compose -f infra/emqx/compose.yaml stop
docker compose -f infra/emqx/compose.yaml start
docker compose -f infra/emqx/compose.yaml restart
```

El panel esta en http://localhost:18083, usuario `admin`; la clave generada esta en
`infra/emqx/private/credentials.json`, campo `dashboard_password`. No mostrar ese archivo
en el video. Si el panel exige renovar la clave, actualizar el archivo privado para
que el recolector de evidencias pueda acceder. La cuenta del panel no es usuario MQTT.
Esperar estado `healthy` en `docker compose ... ps` antes de ejecutar los clientes.

MQTT usa 1884 y AMQTT puede conservar 1883. El panel se publica solo en localhost.
Los volumenes conservan datos al detener/reiniciar. No usar `down -v`: borraria los usuarios.
La preparacion conserva archivos ya existentes; cambiar el CSV despues del primer inicio
no actualiza usuarios. Usar la administracion de usuarios del panel para rotar claves.

Usuarios MQTT: `laboratorio` permite solo `laboratorio/oratoria/#`; el usuario del
proyecto permite solo `oratoria/v1/DEVICE_ID/#`. Ambos son no-superusuarios.
El acceso anonimo no tiene un autenticador que lo permita y las ACL terminan en deny.

## Demostracion con dos terminales

Primero, suscriptor:

```powershell
.\.venv\Scripts\python.exe -m laboratorio.suscriptor --run-id video-01 --duration 120
```

Esperar `SUSCRIPCION CONFIRMADA`. En la otra terminal:

```powershell
.\.venv\Scripts\python.exe -m laboratorio.publicador --run-id video-01
```

Usar un ID nuevo para cada demostracion. Se envian diez mensajes y se guardan JSONL
en `evidencias/emqx`. `--env-file` selecciona otro archivo; las variables MQTT del proceso
tienen prioridad en estos clientes. No imprimir variables de entorno al grabar.
Los clientes tienen IDs unicos. El suscriptor reconecta y resuscribe durante su plazo;
termina al completar diez mensajes o agotar tiempo. Con QoS 0 no hay recuperacion garantizada
de publicaciones realizadas durante un corte.

## Verificaciones y evidencia real

```powershell
.\.venv\Scripts\python.exe -m laboratorio.verificar --security
.\.venv\Scripts\python.exe -m laboratorio.seguridad
.\.venv\Scripts\python.exe -m tools.evidencia_emqx
```

Prueba de corte y recuperacion (solo sin sesiones activas; detiene y vuelve a iniciar
el contenedor EMQX de este proyecto):

```powershell
.\.venv\Scripts\python.exe -m tools.probar_recuperacion_emqx
```

El verificador usa dos clientes TCP, confirma suscripcion, separa ejecuciones, comprueba
contenido/secuencia, faltantes, duplicados y aislamiento de otro topico. Sale 0 si pasa,
1 si falla la prueba y 2 si la configuracion es invalida. No identifica el producto del
broker a partir de MQTT: el recolector consulta la API real de EMQX y registra su version.
La prueba de ACL usa MQTT 5 para exigir SUBACK/PUBACK de rechazo; un timeout no demuestra
que la contrasena o un permiso hayan sido rechazados. Los registros no incluyen claves.

En el panel, abrir Clients y Subscriptions durante la demostracion (antes de que cierre
el suscriptor). En Overview observar mensajes entrantes/salientes; el contenido se ve en
el suscriptor. El recolector conserva un snapshot de dos clientes activos, suscripcion,
estadisticas y metricas sin tokens ni credenciales.

## Entrenador con EMQX

```powershell
.\.venv\Scripts\python.exe run.py --env-file .env.emqx
```

Carga el archivo antes de importar la app. El original `.env` permanece para AMQTT.
El modo externo no levanta AMQTT y el estado de la web informa conexion, suscripciones,
desconexiones y errores. Para volver al modo habitual: cerrar el proceso y ejecutar
`python run.py` con el `.env` original. No ejecutar dos servidores contra la misma
base SQLite ni dos instancias con los mismos IDs MQTT.

### Placa fisica

Con la IPv4 Wi-Fi actual de la laptop obtenida con `ipconfig`:

```powershell
.\.venv\Scripts\python.exe -m tools.configurar_nodo_emqx --ip IP_WIFI_REAL
```

Esto actualiza host, puerto, usuario, clave e ID MQTT de `secrets.h`, preserva Wi-Fi y
respalda la version anterior en la carpeta privada. No carga el firmware. Compilar/subir
desde Arduino IDE y volver al modo de ejecucion de la placa segun README.
Si cambia la IP del acceso HTTPS, regenerar certificado conforme README y despues
repetir este ajuste MQTT: el configurador general tambien actualiza MQTT_HOST.

Permitir TCP 1884 desde la red local privada si Windows Firewall lo bloquea; no hace falta
exponer el panel a la LAN. No se cambia automaticamente el firewall ni se abre a Internet.
Para crear la regla limitada, ejecutar en PowerShell como administrador:

```powershell
.\tools\firewall_emqx.ps1
```

La trama PCM maxima es 656 bytes y PubSubClient tiene buffer de 2048 bytes (incluye cabecera
y topico MQTT); mantener estos limites y no publicar WAV completos como un mensaje.

Validacion fisica pendiente de hacer con celular y placa: inicio, audio retransmitido,
transcripcion real, consejos, cierre, reproduccion de WAV y segunda sesion independiente.
Las pruebas con nodo virtual no se presentan como validacion fisica ni resultados humanos.

## Pruebas de regresion

```powershell
.\.venv\Scripts\python.exe -m pytest -q
$env:ORATORIA_TEST_EMQX='1'
.\.venv\Scripts\python.exe -m pytest -q tests/test_emqx_live.py
Remove-Item Env:ORATORIA_TEST_EMQX
```

La suite habitual usa brokers temporales AMQTT. La suite opcional prueba EMQX real y dos
sesiones con nodo y proveedor simulados, sin gastar API ni escribir en la BD del estudio.

Fuentes oficiales:
- https://docs.emqx.com/en/emqx/latest/get-started/deploy/install.html
- https://docs.emqx.com/en/emqx/latest/get-started/deploy/install-docker.html
- https://docs.emqx.com/en/emqx/latest/guides/access-control/authn/mnesia.html
- https://docs.emqx.com/en/emqx/latest/guides/access-control/authz/file.html

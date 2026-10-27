# Avance: sensores virtuales de confort térmico bajo MQTT

Proyecto: **Sistema IoT basado en Machine Learning para predecir el confort térmico de estudiantes de posgrado y recomendar el nivel de ventilación en aulas universitarias**.

Dos procesos representan los dos ESP32 DevKit. Cada proceso genera temperatura, humedad relativa y velocidad del aire: cuatro sensores físicos representados (dos SHT31/SHT35 y dos anemómetros), seis canales de medición y dos nodos MQTT. Se virtualiza el comportamiento del nodo y su comunicación; no se emulan el circuito, el bus I2C ni el firmware del ESP32.

El colector recibe MQTT, valida el mensaje, almacena la lectura, aplica reglas de demostración y publica la recomendación para cada zona. El dashboard permite observar ambas zonas. No hay control eléctrico de un ventilador real.

## Qué incluye

- `compose.yaml`: red Docker con EMQX, MySQL, phpMyAdmin, colector y dos nodos.
- `app/`: publicadores, cliente MQTT, persistencia, broker local alternativo y dashboard.
- `sql/mysql.sql`: modelo relacional ejecutable; incluye tabla para encuestas futuras.
- `modelos/mongodb.js`: modelo documental e índices propuestos; MongoDB no se inicia.
- `verificar.py`: prueba reproducible con MQTT real por TCP, aMQTT y SQLite.
- `evidencias/`: resultados, registros originales, base SQLite e instantánea del dashboard.
- `demo_local.py`: demostración continua sin requerir Docker.

## Ruta A: entorno del laboratorio con Docker

Requisitos: Docker Engine funcionando y Docker Compose, acceso del usuario al servicio Docker, puertos locales disponibles, conexión para descargar imágenes. Linux puede ejecutarse directamente o en una máquina virtual, conforme al PDF. No hace falta instalar escritorio ni reiniciar el equipo para esta simulación.

Desde esta carpeta:

```bash
cp .env.example .env
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs -f zona1 zona2 collector
```

Si el usuario requiere permisos administrativos, puede ejecutar los comandos de Docker con `sudo` según la configuración de su equipo.

Accesos locales:

| Servicio | Dirección | Acceso |
|---|---|---|
| Dashboard del aula | http://localhost:8090 | Sin login, demostración |
| Dashboard EMQX | http://localhost:18083 | Inicialmente `admin` / `public`; cambiar al entrar |
| phpMyAdmin | http://localhost:8080 | Servidor `mysql`, usuario `confort`, clave de `.env` |
| MQTT TCP | localhost:1883 | Clientes MQTT; no es una página web |

MySQL solo se expone dentro de la red Docker. Las credenciales del ejemplo son exclusivamente locales. El stack publica los puertos en la interfaz de bucle local; para incorporar ESP32 físicos se debe configurar la IP del servidor, acceso de red, autenticación MQTT y, cuando corresponda, TLS. Esa integración no forma parte de la ejecución local.

Verificación en phpMyAdmin:

```sql
SELECT nodo_id, COUNT(*) AS lecturas FROM lecturas GROUP BY nodo_id;
SELECT l.nodo_id, l.escenario, l.temperatura_c,
       l.velocidad_aire_ms, r.confort_estimado, r.nivel_sugerido
FROM lecturas l JOIN recomendaciones r USING (mensaje_id)
ORDER BY l.instante_utc DESC LIMIT 20;
```

Para terminar conservando los datos:

```bash
docker compose down
```

El SQL de inicialización se ejecuta cuando el volumen MySQL está vacío. Modificar ese archivo después no actualiza automáticamente una base existente. No borres el volumen si necesitas conservar lecturas.

## Ruta B: demostración local verificable sin Docker

Requisitos: Python 3.11 o 3.12 y puertos locales disponibles.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-demo.txt
.venv/bin/python verificar.py
.venv/bin/python demo_local.py
```

El primer comando de ejecución comprueba el flujo completo y termina. El segundo mantiene la demostración en http://127.0.0.1:8090 hasta pulsar Ctrl+C. Usa broker aMQTT en el puerto 18883 y SQLite, sin tocar la instalación de Docker. Los datos de la demo continua quedan en `data/demo_local/`.

Para una demostración rápida, con cambios de escenario aproximadamente cada 6 segundos:

```bash
INTERVAL_SECONDS=1 PHASE_SAMPLES=6 .venv/bin/python demo_local.py
```

La prueba automatizada usa 40 muestras por nodo, diez por escenario, a intervalos de 0.05 segundos. Ese intervalo acelera la prueba; no es el intervalo de muestreo propuesto para el aula.

## Contrato MQTT

Prefijo: `unt/posgrado/aula01`. Para cada `zona1` y `zona2`:

| Sufijo | Sentido | QoS | Retenido |
|---|---|---:|---|
| `/telemetria` | Nodo → colector | 1 | No |
| `/estado` | Nodo → observadores | 1 | Sí |
| `/recomendacion` | Colector → observadores | 1 | No |

Suscripción del colector: `unt/posgrado/aula01/+/telemetria`. La recomendación no usa `retain` para evitar presentar un consejo antiguo como actual. El dashboard suspende la recomendación si la muestra supera 20 segundos de antigüedad. Cada nodo tiene un Client ID diferente y publica Last Will `offline` si se desconecta inesperadamente. El apagado normal también publica `offline`.

`mensaje_id = run_id/nodo_id/secuencia` evita duplicar una lectura si QoS 1 la reentrega. El colector valida correspondencia topic-zona-nodo, esquema, fecha con zona horaria y dominios numéricos; rechaza humedad >100%, valores no finitos y mensajes inconsistentes. Los registros de lectura y recomendación se guardan en una misma transacción relacional. El archivo JSONL es evidencia documental; no constituye por sí mismo un servidor NoSQL ni una transacción atómica con la base.

Ejemplo real de mensaje: `evidencias/telemetria.jsonl`. Campos con unidades: `temperatura_c`, `humedad_pct`, `velocidad_aire_ms`. `ocupantes_simulados` y `nivel_ventilador_simulado` son condiciones ingresadas al generador, no variables medidas por los sensores de la lista. Todos los mensajes llevan `simulado: true`.

## Escenarios y recomendaciones de demostración

| Escenario | T base zona1 (°C) | HR base (%) | Aire base (m/s) | Nivel usado | Ocupantes supuestos |
|---|---:|---:|---:|---:|---:|
| Frío | 20.5 | 55 | 0.10 | 0 | 8 |
| Confort | 24.5 | 58 | 0.25 | 1 | 16 |
| Calor | 29.5 | 74 | 0.12 | 0 | 28 |
| Ventilado | 28.0 | 68 | 0.85 | 3 | 28 |

Zona2: +0.8 °C, +2 puntos de humedad y -0.08 m/s respecto a la base, más variación pseudoaleatoria con semillas fijas. Un ciclo dura cuatro minutos con los parámetros por defecto (12 muestras por fase y 5 segundos entre muestras). La temperatura de cada escenario es un supuesto independiente: el generador no implementa un modelo físico de enfriamiento ni implica que el ventilador reduzca la temperatura del aula.

Reglas evaluadas en orden:

1. T <22 °C: etiqueta `frio`, nivel 0.
2. T ≥28 °C y aire <0.5 m/s: etiqueta `calor`, nivel 3.
3. T ≥26 °C y aire <0.35 m/s: etiqueta `calor`, nivel 2.
4. HR ≥70% y aire <0.3 m/s: etiqueta `calor`, nivel 1.
5. Caso restante: etiqueta `confort`, nivel 1.

Son umbrales arbitrarios para probar el recorrido del mensaje, no límites normativos de confort. Los niveles significan 0 apagado, 1 bajo, 2 medio y 3 alto; su relación real con m/s requiere calibración.

Hay un ventilador compartido. El avance informa recomendaciones por zona y deja la elección al operador. No combina opiniones opuestas automáticamente; una futura política deberá considerar desacuerdo entre zonas. Un ventilador recircula aire y no garantiza renovación de aire exterior; este avance no mide CO₂ ni calidad del aire.

## Componente inteligente propuesto (menos de 50 palabras)

El sistema aprenderá, mediante Machine Learning, la relación entre temperatura, humedad, velocidad del aire y encuestas de confort de estudiantes de posgrado. Estimará el confort térmico por zona y recomendará el nivel del ventilador, considerando diferencias entre zonas y evitando cambios frecuentes.

Todavía no se entrena ML: las etiquetas de los escenarios no son votos humanos. Plan: recopilar encuestas anónimas vinculadas a lecturas, estudiar un clasificador multiclase (por ejemplo, Random Forest), separar entrenamiento y evaluación por sesiones y participantes, comparar con un modelo base y medir F1 macro y matriz de confusión. Temperatura, humedad y velocidad del aire serán entradas; `escenario`, la regla sintética y `mensaje_id` no serán etiquetas ni variables explicativas para validar el modelo real. Ropa, actividad, temperatura radiante y diferencias individuales quedan como limitaciones de los sensores disponibles.

## Modelos de datos

Relacional: `aulas 1:N zonas 1:N nodos 1:N lecturas`; cada lectura tiene `0:1 recomendaciones` y `0:N encuestas`. El esquema incluye claves foráneas, índice por nodo/fecha e identidad única por ejecución, nodo y secuencia. La tabla `encuestas` está vacía en esta demostración; el voto propuesto va de -3 a +3 y deberá mapearse a clases antes del entrenamiento.

Documental propuesto: una colección `eventos` con `{topic, telemetria: {...}, recomendacion: {...}}`. Los documentos completos se conservan en JSONL y podrían importarse en MongoDB; `modelos/mongodb.js` define índices y una consulta de ejemplo. Encuestas separadas referencian `mensaje_id`; la colección no impone las claves foráneas SQL. No se afirma haber ejecutado MongoDB.

## Evidencias y límites de lo verificado

`evidencias/resultado.json` registra la prueba realizada: **80 lecturas**, **80 recomendaciones persistidas**, **81 recomendaciones observadas por MQTT** (incluye la respuesta a la reentrega), dos nodos, seis canales, un duplicado sin fila adicional, dos mensajes inválidos rechazados, estados retenidos, Last Will e integridad relacional comprobados. No se generaron encuestas humanas ni métricas ML.

El archivo Compose pasó la validación de configuración. La ejecución verificada utilizó aMQTT y SQLite. **EMQX y MySQL en Docker quedan pendientes de ejecución**: este usuario no tiene permisos sobre el servicio Docker y `sudo` requiere contraseña. No hay capturas ni resultados inventados de esos servicios. Este alcance debe conservarse en la exposición.

Para completar la evidencia del entorno del PDF: levantar la ruta A, capturar los seis servicios en ejecución, los dos clientes en EMQX, las publicaciones de ambas zonas, las filas en phpMyAdmin y el dashboard del aula.

## Referencias

- PDF facilitado: `Laboratorio_6 - 2026_II.pdf`, actividad de la página 6. El encabezado interior dice “LABORATORIO 05”. Se usan sus requisitos como referencia académica; sus comandos de instalación no se ejecutaron sobre el sistema.
- [Eclipse Paho: cliente Python y callbacks](https://eclipse.dev/paho/clients/python/docs/).
- [EMQX: imagen Docker oficial, versión 5.8.8](https://hub.docker.com/_/emqx).
- [EMQX: instalación y dashboard](https://docs.emqx.com/en/emqx/latest/get-started/getting-started.html).
- [Docker: orden de inicio y comprobaciones de salud](https://docs.docker.com/compose/how-tos/startup-order/).
- [MySQL: instalación de Connector/Python](https://dev.mysql.com/doc/connector-python/en/quick-installation-guide.html).

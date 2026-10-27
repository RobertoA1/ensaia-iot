# Evaluación del entrenador

La actualización añade tablas SQLite `evaluations` y `surveys` al iniciar el servidor. No cambia las sesiones ni los audios anteriores. No requiere nuevo firmware.

## Revisión humana

En **Sesiones guardadas → Revisar**, carga el audio original, identifica al revisor y confirma, descarta o deja dudoso cada candidato. Añade las omisiones indicando tipo, expresión y segundo del audio. Cada fila representa una ocurrencia; no repitas la misma ocurrencia con otro identificador.

Usa la transcripción automática solo como borrador. Corrígela escuchando todo el audio, conservando repeticiones y sonidos definidos en el protocolo. El texto corregido es el denominador humano de palabras. El algoritmo cuenta grupos de letras Unicode: este criterio debe mantenerse constante entre etapas.

Una revisión completa requiere todos los candidatos resueltos, sin dudas, texto corregido y declaración de escucha completa y búsqueda de omisiones. Un borrador muestra conteos parciales, nunca una comparación humana final. La validación del formulario comprueba consistencia; no puede comprobar que el revisor haya escuchado realmente el audio.

Cada código de revisor guarda una revisión independiente. Guardar sustituye solo el estado actual de ese código, sin crear duplicados. No existe adjudicación automática entre revisores. Las anotaciones antiguas se conservan y se muestran por separado; no se convierten automáticamente en conteos.

Precisión = candidatos confirmados / (confirmados + descartados). Cobertura = confirmados / (confirmados + omisiones), disponible con revisión completa. Son indicadores conjuntos de los tipos anotados; si el denominador es cero se muestran sin datos. Su validez depende de que el revisor busque también lo que la IA omitió.

## Rúbrica y encuesta

Rúbrica local exploratoria, no instrumento validado: claridad, introducción, orden, desarrollo y conclusión, puntuados de 1 a 5. El panel describe los niveles 1, 3 y 5 y admite niveles intermedios. No se calcula un puntaje global. «No evaluado» es ausencia de dato, no cero. Usar el mismo revisor y criterio en las dos etapas.

La encuesta la responde el participante: utilidad de los consejos y distracción, de 1 a 5, más comentario. Un valor alto de utilidad es favorable; uno alto de distracción es desfavorable. Se guarda una respuesta editable por sesión. No representa diagnóstico ni evaluación independiente de eficacia.

## Comparación

Seleccionar explícitamente participante, sesión Antes, sesión Después y código del revisor. El servidor exige que las etapas y el participante coincidan. No elige automáticamente el mejor intento ni agrupa intentos repetidos como participantes nuevos.

Se muestran conteos y tasas por minuto de audio capturado y por cada 100 palabras. Los candidatos automáticos y los resultados humanos aparecen separados. Cambio = Después − Antes; cambio porcentual = 100 × (Después − Antes) / Antes. Con Antes igual a cero no hay porcentaje definido. Menos palabras no implica mejor desempeño.

No se calculan cambios si la sesión está interrumpida, es simulada, no tiene audio/transcripción útil, perdió audio, no tiene envío íntegro a IA verificado, carece de cierre del proveedor o tiene eventos pendientes. No se ocultan esas sesiones: el panel explica las incidencias. Para comparación humana ambas revisiones deben estar completas. El panel avisa cuando hubo consejos en las mediciones; esto no equivale a evaluación sin ayuda. Al cambiar a Antes/Después, los consejos quedan desactivados por defecto, sin alterar grabaciones anteriores.

Las cuatro o pocas parejas actuales permiten un análisis descriptivo, no atribuir causalidad ni retención a largo plazo. La tasa principal y el protocolo se fijan antes de una nueva recogida.

## Calidad técnica

El contador de repeticiones incluye palabras consecutivas y secuencias textuales exactas de 2 a 40 palabras, con una ventana de búsqueda de 120 palabras previas. Espera a que termine la coincidencia para no contar prefijos de una misma frase como varios eventos. Las coincidencias son candidatos: un énfasis intencional también puede repetir texto. No identifica por reglas todas las paráfrasis o redundancias semánticas.

GPT-Live recibe instrucciones de valorar frases, oraciones, reformulaciones y énfasis en contexto. Con consejos activos, se envía contexto silencioso como máximo cada cinco segundos y solicitudes de consejo separadas, también limitadas, cuando hay nuevos candidatos o suficiente texto. `session.instructions.append` solicita el consejo; `session.thinking.append` solo aporta contexto. No se promete una respuesta instantánea ni una clasificación estructurada de todas las repeticiones. El juicio del modelo se expresa en los consejos; el conteo continúa siendo exploratorio y revisable.

La voz del proveedor siempre se conserva si llega, pero solo se retransmite al navegador si se activó «Escuchar a GPT-Live» al iniciar. El indicador de cola de envío a IA estima audio recibido del relevo que todavía no se envió al socket del proveedor; no mide inferencia, recepción por el modelo o presentación del consejo. Las sesiones anteriores no se recalculan automáticamente.

El panel muestra pérdida de tramas, integridad de envío, eventos pendientes, descartes MQTT y mediana/p95 de latencia desde creación de evento en laptop hasta el eco del ESP, con reintentos. No es latencia acústica, tiempo de inferencia ni tiempo hasta presentación en pantalla. La sincronización usa tiempos de la laptop.

Las nuevas grabaciones conservan mínimo observado de RAM, RSSI si el firmware lo publica, desconexiones observadas y diferencias del contador de escrituras TCP incompletas. La ausencia de telemetría no se transforma en cero; los datos anteriores no se inventan. Las desconexiones observadas no incluyen necesariamente toda interrupción de red.

## Exportación y pruebas

El ZIP conserva sus archivos originales y añade `evaluaciones.json`, `encuesta.json` y `evaluacion_indicadores.json`. La comparación seleccionada se descarga como JSON. Los campos numéricos sin denominador válido son `null`.

Ejecutar ` .\.venv\Scripts\python.exe -m pytest -q` desde la raíz. Las pruebas usan bases y audios temporales, proveedor simulado y MQTT local; no modifican grabaciones reales ni llaman a OpenAI.

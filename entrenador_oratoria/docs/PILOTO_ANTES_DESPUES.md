# Piloto de exposiciones en una jornada

Este protocolo es una propuesta para recoger datos humanos. La demostración de software no aporta resultados sobre aprendizaje ni se incluye como participante.

## Población accesible y pregunta

Estudiantes mayores de edad de una asignatura o cohorte a la que el equipo tenga acceso, con participación voluntaria y autorización que corresponda a su institución. No se usa para decidir notas. La población de inferencia se limita a esa cohorte y a las condiciones del piloto.

Pregunta: ¿una práctica breve con feedback del entrenador reduce la frecuencia de muletillas observadas en una segunda exposición, frente a practicar durante el mismo tiempo sin ese feedback?

## Procedimiento propuesto

1. Preparar dos temas de dificultad comparable y un criterio escrito para distinguir muletillas de palabras con función normal. Probar el audio, la estabilidad de la placa y el acceso real a GPT-Live antes de convocar participantes.
2. Asignar códigos P001, P002, etc. Conservar la lista que relacione códigos y personas por separado, si es necesaria. Explicar la grabación, el envío a OpenAI y la finalidad del estudio antes de aceptar.
3. Grabar una exposición inicial de dos minutos: etapa **Antes**, recomendaciones desactivadas. Mantener distancia al micrófono, ambiente y tiempo equivalentes.
4. Asignar al azar a entrenamiento con feedback o práctica sin feedback, ambos de igual duración. Registrar la condición en una anotación de sesión. La casilla de consejos controla su presentación; la API de voz puede seguir generando respuesta aunque esté oculta.
5. Realizar una práctica de dos minutos: etapa **Práctica**, consejos activados solo para el grupo de intervención. Usar texto o auriculares y la misma modalidad para todo ese grupo.
6. Grabar otra exposición de dos minutos: etapa **Después**, recomendaciones desactivadas para todos. Alternar entre participantes el orden de los dos temas para reducir la influencia de su dificultad.
7. Exportar las tres sesiones. Anotar incidencias, sesiones simuladas, pérdidas de audio y cierres de proveedor no confirmados. No ocultar exclusiones ni reemplazarlas por datos de demostración.
8. Dos revisores, sin conocer el grupo ni la etapa cuando sea posible, escuchan los audios originales. Validan muletillas y repeticiones, incluyendo omisiones del reconocedor. Resolver discrepancias con un criterio común y conservar el registro.

Con un solo equipo y aproximadamente diez minutos por participante, **20 personas requieren alrededor de 3 h 20 min**, más preparación y descansos. Es una estimación operativa, no un cálculo de tamaño de muestra. Una muestra adecuada para contrastar hipótesis depende del efecto y variabilidad esperados; un piloto pequeño puede usarse para estimarlos.

## Medidas y análisis

Medida principal propuesta: **muletillas confirmadas por cada 100 palabras de la transcripción humana corregida**. Fijar el criterio antes de revisar resultados. Si se prefiere una tasa por minuto, fijarla de antemano y usar duración del audio, no tiempo de conexión de la sesión.

Medidas secundarias: repeticiones confirmadas, ritmo de habla, claridad con una rúbrica común y percepción de utilidad. Los candidatos automáticos y el RMS son exploratorios; no son etiquetas humanas ni diagnósticos de ansiedad.

La unidad de análisis es **el participante**. Calcular su cambio Después − Antes; una reducción de la tasa produce un cambio negativo. Comparar los cambios de los grupos y presentar tamaños de efecto, incertidumbre y datos individuales. La elección de la prueba requiere revisar los datos y el plan estadístico. Miles de tramas, palabras o mensajes MQTT no equivalen a miles de participantes independientes.

Si únicamente se puede estudiar un grupo antes/después, presentarlo como piloto exploratorio: la repetición de la tarea, el tema o la familiaridad también pueden explicar cambios. Una sola jornada permite observar desempeño inmediato; no permite afirmar retención duradera ni garantizar que el sistema produzca una mejora.

## Costos y criterios de preparación

En esta fase se reutilizan placa, celular, laptop y Wi-Fi. No hacen falta micrófono I2S, ESP32 ni altavoz para comenzar. El gasto adicional es principalmente la API, y debe separarse del presupuesto de hardware de S/ 300.

Veinte participantes con tres sesiones de dos minutos suman **120 minutos de captura**, además de conexión y cierre. A la tarifa de voz consultada de USD 0.05/min, 120 minutos representan USD 6 de voz, **más backend y tiempo adicional**. Confirmar precio, tipo de cambio y consumo de una sesión real antes de fijar el presupuesto; el límite de duración de la aplicación no equivale a un límite monetario de la cuenta. Véase [la fuente y los límites de viabilidad](VIABILIDAD.md).

No iniciar la recogida para el paper hasta verificar con la placa real: audio sin pérdidas relevantes, texto y consejos recibidos por MQTT, estabilidad de una sesión completa, acceso al modelo, cierre confirmado y funcionamiento del micrófono en el teléfono concreto.

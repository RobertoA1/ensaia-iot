import json
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Flowable, Image, Preformatted, KeepTogether
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4


from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
for name, file in [('LibSans','LiberationSans-Regular.ttf'),('LibSans-Bold','LiberationSans-Bold.ttf'),('LibSans-Oblique','LiberationSans-Italic.ttf'),('LibSans-BoldOblique','LiberationSans-BoldItalic.ttf'),('LibMono','LiberationMono-Regular.ttf')]:
    pdfmetrics.registerFont(TTFont(name, '/usr/share/fonts/liberation/'+file))
pdfmetrics.registerFontFamily('LibSans',normal='LibSans',bold='LibSans-Bold',italic='LibSans-Oblique',boldItalic='LibSans-BoldOblique')

ROOT=Path('/home/robertoa1/Datos/proyectos/iot-2')
BASE=ROOT/'simulacion_mqtt'
records=[json.loads(x) for x in (BASE/'evidencias/telemetria.jsonl').read_text().splitlines()]
result=json.loads((BASE/'evidencias/resultado.json').read_text())
NAVY=colors.HexColor('#183747'); TEAL=colors.HexColor('#008579'); LIGHT=colors.HexColor('#eaf4f3'); GRAY=colors.HexColor('#526777')
styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='TitleX', fontName='LibSans-Bold',fontSize=24,leading=29,textColor=NAVY,spaceAfter=14))
styles.add(ParagraphStyle(name='H1X', fontName='LibSans-Bold',fontSize=18,leading=22,textColor=NAVY,spaceAfter=13))
styles.add(ParagraphStyle(name='H2X',fontName='LibSans-Bold',fontSize=11,leading=15,textColor=TEAL,spaceBefore=12,spaceAfter=6))
styles.add(ParagraphStyle(name='BodyX',fontName='LibSans',fontSize=10,leading=14.5,textColor=NAVY,spaceAfter=8))
styles.add(ParagraphStyle(name='SmallX',fontName='LibSans',fontSize=8.2,leading=11.5,textColor=GRAY,spaceAfter=6))
styles.add(ParagraphStyle(name='CellX',fontName='LibSans',fontSize=8.5,leading=11,textColor=NAVY))
styles.add(ParagraphStyle(name='CodeX',fontName='LibMono',fontSize=7.6,leading=10,textColor=NAVY,spaceAfter=8))
story=[]
def p(text, kind='BodyX'):
    story.append(Paragraph(text,styles[kind]))
def h(text): p(text,'H2X')
def title(n,text):
    p(f'{n:02d} / AVANCE DE SIMULACIÓN','SmallX');p(text,'H1X')
def page(): story.append(PageBreak())
def table(rows,widths,pad=7):
    data=[[Paragraph(escape(str(v)).replace('\n','<br/>'),styles['CellX']) for v in row] for row in rows]
    t=Table(data,colWidths=widths,hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),LIGHT),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),pad),('BOTTOMPADDING',(0,0),(-1,-1),pad),('LINEBELOW',(0,0),(-1,0),1,TEAL),('LINEBELOW',(0,1),(-1,-1),.4,colors.HexColor('#d6e1e5'))]))
    story.append(t);story.append(Spacer(1,8))
def code(text):story.append(Preformatted(text,styles['CodeX']))
def box(text):
    t=Table([[Paragraph(text,styles['BodyX'])]],colWidths=[511])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),LIGHT),('BOX',(0,0),(-1,-1),.5,TEAL),('LEFTPADDING',(0,0),(-1,-1),12),('RIGHTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
    story.append(t);story.append(Spacer(1,10))

class Topology(Flowable):
    def __init__(self):Flowable.__init__(self);self.width=511;self.height=188
    def draw(self):
        c=self.canv
        def node(x,y,w,h,lines):
            c.setFillColor(LIGHT);c.setStrokeColor(TEAL);c.roundRect(x,y,w,h,6,fill=1,stroke=1)
            c.setFillColor(NAVY)
            for i,line in enumerate(lines):
                c.setFont('LibSans-Bold' if i==0 else 'LibSans',9 if i==0 else 8)
                c.drawCentredString(x+w/2,y+h-16-i*13,line)
        def arrow(x1,y1,x2,y2):
            c.setStrokeColor(GRAY);c.setLineWidth(1);c.line(x1,y1,x2,y2)
            c.line(x2,y2,x2-5,y2+3);c.line(x2,y2,x2-5,y2-3)
        node(0,105,145,60,['ESP32 virtual zona 1','SHT31/SHT35 + anemómetro','T, HR y velocidad del aire'])
        node(0,15,145,60,['ESP32 virtual zona 2','SHT31/SHT35 + anemómetro','T, HR y velocidad del aire'])
        node(187,67,116,60,['Broker MQTT','EMQX en Docker','aMQTT en prueba local'])
        node(354,67,157,60,['Colector y recomendaciones','Validación + reglas demo','Dashboard del aula'])
        c.setStrokeColor(GRAY);c.line(145,135,165,135);c.line(165,45,165,135);c.line(145,45,165,45)
        arrow(165,97,187,97);arrow(303,97,354,97)
        c.setFont('LibSans',8);c.setFillColor(GRAY);c.drawString(172,150,'MQTT / TCP / QoS 1')
        node(354,0,157,43,['Persistencia','MySQL / SQLite + JSONL'])
        c.line(432,67,432,43)
        c.setFont('LibSans',7.6);c.drawString(0,0,'Dos nodos independientes. Red bridge Docker o bucle local TCP.')

class Chart(Flowable):
    def __init__(self):Flowable.__init__(self);self.width=511;self.height=170
    def draw(self):
        c=self.canv
        for x0,key,low,high,label in [(36,'temperatura_c',19,32,'Temperatura (°C)'),(291,'velocidad_aire_ms',0,1,'Velocidad del aire (m/s)')]:
            y0,w,hh=34,202,100
            c.setFont('LibSans-Bold',9);c.setFillColor(NAVY);c.drawString(x0,150,label)
            for i in range(5):
                yy=y0+i*hh/4;val=low+(high-low)*i/4
                c.setStrokeColor(colors.HexColor('#e0e8ea'));c.line(x0,yy,x0+w,yy)
                c.setFont('LibSans',7);c.setFillColor(GRAY);c.drawRightString(x0-5,yy-2,f'{val:.1f}')
            for boundary in [10,20,30]:
                xx=x0+w*boundary/39;c.setDash(2,2);c.line(xx,y0,xx,y0+hh);c.setDash()
            for zone,color in [('zona1',TEAL),('zona2',colors.HexColor('#c96b28'))]:
                rows=sorted([r['telemetria'] for r in records if r['telemetria']['zona_id']==zone],key=lambda r:r['secuencia'])
                path=c.beginPath()
                for i,r in enumerate(rows):
                    x=x0+w*r['secuencia']/39;y=y0+hh*(r[key]-low)/(high-low)
                    if i==0:path.moveTo(x,y)
                    else:path.lineTo(x,y)
                c.setStrokeColor(color);c.setLineWidth(1.6);c.drawPath(path)
            c.setFont('LibSans',7);c.setFillColor(GRAY)
            for i,name in enumerate(['Frío','Confort','Calor','Ventilado']):c.drawCentredString(x0+(i+.5)*w/4,20,name)
        c.setFillColor(TEAL);c.rect(170,0,12,3,fill=1,stroke=0);c.setFillColor(GRAY);c.drawString(187,-1,'Zona 1')
        c.setFillColor(colors.HexColor('#c96b28'));c.rect(265,0,12,3,fill=1,stroke=0);c.setFillColor(GRAY);c.drawString(282,-1,'Zona 2')

# 1
p('UNIVERSIDAD NACIONAL DE TRUJILLO · POSGRADO','SmallX')
p('Avance de simulación\nvirtual de sensores MQTT'.replace('\n','<br/>'),'TitleX')
p('<b>Proyecto:</b> Sistema IoT basado en Machine Learning para predecir el confort térmico de estudiantes de posgrado y recomendar el nivel de ventilación en aulas universitarias.')
p('Fecha del avance: 8 de octubre de 2026 · Entorno local de demostración','SmallX')
box('<b>Pregunta de investigación</b><br/>¿Es posible predecir el nivel de confort térmico de los estudiantes a partir de las condiciones ambientales del aula y recomendar una configuración adecuada de ventilación?')
h('Problema que se aborda')
p('El ventilador se ajusta según la percepción de quienes ocupan el aula. Las opiniones pueden diferir entre estudiantes y la configuración suele mantenerse aunque cambien las condiciones ambientales. Se propone observar dos zonas para registrar esas diferencias y apoyar una recomendación de velocidad.')
h('Objetivo del avance')
p('Demostrar el recorrido de datos desde dos nodos virtuales hasta un broker MQTT, su almacenamiento y visualización, y la publicación de recomendaciones iniciales. Este avance verifica la infraestructura necesaria para recolectar después datos de entrenamiento.')
table([['Material previsto','Representación en la simulación'],['2 ESP32 DevKit','Dos procesos con identificadores MQTT distintos'],['2 SHT31 o SHT35','Temperatura y humedad por cada zona'],['2 anemómetros','Velocidad del aire por cada zona'],['Laptop/PC y router Wi-Fi','Servidor, red virtual y comunicación TCP'],['1 ventilador con niveles','Condición simulada 0-3 y recomendación por zona']], [170,341])
p('Protoboards, cables, fuentes, cajas y soportes corresponden al montaje físico posterior. La simulación representa cuatro sensores y seis canales de medición. No emula conexiones electrónicas ni firmware.','SmallX')
h('Relación con el laboratorio')
p('Se cubren las tres actividades del PDF: implementar MQTT en el proyecto, describir el componente inteligente en menos de 50 palabras y presentar modelos relacional y no relacional. Se entrega además una configuración Docker con EMQX, MySQL y phpMyAdmin, conforme a su entorno propuesto.')
#2
page();title(2,'Arquitectura de red y flujo MQTT')
story.append(Topology());story.append(Spacer(1,12))
p('En la ruta Docker, cada zona es un contenedor de Python que representa un ESP32. Los servicios comparten la red <b>aula</b>, con controlador bridge. El broker desacopla los publicadores de sensores del colector y de otros observadores.')
h('Secuencia de operación')
p('1. Cada nodo genera sus tres variables y un identificador de mensaje.<br/>2. Publica telemetría JSON al broker, con confirmación QoS 1.<br/>3. El colector verifica formato, dominio de variables y correspondencia de zona.<br/>4. Guarda lectura y recomendación en una transacción relacional.<br/>5. Publica la recomendación y actualiza el dashboard; conserva un documento JSONL.')
h('Topics por zona')
p('Prefijo común: <b>unt/posgrado/aula01</b>. Sustituir {zona} por zona1 o zona2.','SmallX')
table([['Topic','Productor → consumidor','Retain'],['{prefijo}/{zona}/telemetria','Nodo → colector','No'],['{prefijo}/{zona}/estado','Nodo → observadores','Sí'],['{prefijo}/{zona}/recomendacion','Colector → observadores','No']], [244,210,57])
p('El colector se suscribe a <b>unt/posgrado/aula01/+/telemetria</b>. Todos los topics usan QoS 1. Este nivel admite reentregas; la clave mensaje_id evita crear filas repetidas.')
h('Disponibilidad y actualidad')
p('Los nodos publican online al conectarse y offline al apagarse. El Last Will informa offline ante una interrupción inesperada. Solo el estado se retiene. La recomendación no se retiene y el dashboard la suspende cuando la muestra tiene más de 20 segundos de antigüedad.')
box('<b>Alcance de la recomendación:</b> el avance informa un nivel para cada zona. La selección del único ventilador sigue a cargo del operador; no se envían comandos a un actuador físico.')
#3
page();title(3,'Generación de datos y escenarios')
p('El intervalo propuesto de demostración es de 5 segundos. Cada escenario dura 12 muestras por nodo, aproximadamente un minuto. Cuatro escenarios forman un ciclo. La prueba automatizada acelera el intervalo a 0.05 segundos.')
table([['Escenario','T base °C','HR %','Aire m/s','Nivel usado','Ocupantes'],['Frío','20.5','55','0.10','0','8'],['Confort','24.5','58','0.25','1','16'],['Calor','29.5','74','0.12','0','28'],['Ventilado','28.0','68','0.85','3','28']], [112,80,65,81,89,84])
p('La zona 2 añade 0.8 °C y 2 puntos de humedad, y resta 0.08 m/s. Se añade variación pseudoaleatoria: ±0.25 °C, ±1 punto de humedad y ±0.02 m/s; la velocidad se limita a valores no negativos. Se usan semillas fijas distintas por zona.')
h('Mensaje real de la prueba')
example=records[0]['telemetria']
text=json.dumps(example,ensure_ascii=False,indent=2)
# La linea del ID se divide por sangria conservando JSON valido.
text=text.replace('  "mensaje_id": "','  "mensaje_id":\n    "')
code(text)
p('Las unidades están en los nombres de los campos. instante_utc usa fecha y hora con zona horaria. run_id y secuencia distinguen ejecuciones y reentregas. Todos los datos están marcados como sintéticos mediante simulado: true.','SmallX')
h('Supuestos explícitos')
p('La ocupación y el nivel aplicado son entradas del generador, no mediciones de los sensores propuestos. La temperatura del escenario ventilado se fija de forma independiente: no se simula la física del enfriamiento del aula. Los rangos sirven para probar el flujo informático, sin atribuirles validez clínica ni normativa.')
#4
page();title(4,'Modelos relacional y documental')
h('Modelo relacional implementado')
box('<b>aulas 1:N zonas 1:N nodos 1:N lecturas</b><br/><b>lecturas 1:0..1 recomendaciones</b><br/><b>lecturas 1:0..N encuestas</b>')
table([['Tabla','Claves y atributos principales'],['aulas','PK aula_id; nombre'],['zonas','PK zona_id; FK aula_id; descripción'],['nodos','PK nodo_id; FK zona_id; dispositivo'],['lecturas','PK mensaje_id; FK nodo_id; run_id, secuencia, instante UTC, T, HR, aire, escenario, nivel y ocupantes simulados'],['recomendaciones','PK/FK mensaje_id; confort_estimado, nivel_sugerido, origen, motivo'],['encuestas','PK encuesta_id; FK mensaje_id; participante anónimo, voto térmico (-3 a +3), preferencia de aire']], [130,381])
p('La identidad única (nodo_id, run_id, secuencia) y la clave mensaje_id evitan duplicados. Un índice por nodo y fecha facilita consultas temporales. La tabla de encuestas está preparada para datos humanos posteriores y permanece vacía en la prueba.')
p('El SQL se entrega en <b>sql/mysql.sql</b>. Se verificó el esquema equivalente en SQLite, incluyendo claves foráneas. La ejecución de MySQL está pendiente por falta de acceso al servicio Docker.','SmallX')
h('Modelo no relacional propuesto: MongoDB')
p('Colección <b>eventos</b>: un documento por mensaje con la lectura completa y su recomendación anidada. Colección <b>encuestas</b>: votos humanos separados, asociados mediante mensaje_id. El archivo modelos/mongodb.js incluye índices y una consulta de ejemplo.')
code('''{
  "topic": "unt/posgrado/aula01/zona1/telemetria",
  "telemetria": {
    "mensaje_id": "identificador-unico",
    "zona_id": "zona1", "simulado": true,
    "temperatura_c": 20.31, "humedad_pct": 55.01,
    "velocidad_aire_ms": 0.100
  },
  "recomendacion": {
    "confort_estimado": "frio", "nivel_sugerido": 0,
    "origen": "reglas_demo_v1"
  }
}''')
p('Ejemplo abreviado de estructura documental. Los documentos completos reales están en evidencias/telemetria.jsonl. JSONL preserva documentos para importar; no equivale a un servidor MongoDB ejecutado ni comparte una transacción atómica con la base SQL.','SmallX')
#5
page();title(5,'Componente inteligente y límites')
intelligent='El sistema aprenderá, mediante Machine Learning, la relación entre temperatura, humedad, velocidad del aire y encuestas de confort de estudiantes de posgrado. Estimará el confort térmico por zona y recomendará el nivel del ventilador, considerando diferencias entre zonas y evitando cambios frecuentes.'
assert len(intelligent.split())<50
h(f'Descripción de la propuesta ({len(intelligent.split())} palabras)')
box(intelligent)
h('Reglas implementadas para demostrar el recorrido')
table([['Prioridad','Condición','Etiqueta','Nivel'],['1','T < 22 °C','Frío','0'],['2','T ≥ 28 °C y aire < 0.50 m/s','Calor','3'],['3','T ≥ 26 °C y aire < 0.35 m/s','Calor','2'],['4','HR ≥ 70% y aire < 0.30 m/s','Calor','1'],['5','Caso restante','Confort','1']], [58,292,95,66])
p('Se evalúan en orden. Son umbrales arbitrarios de demostración, identificados como reglas_demo_v1. Las clases asignadas por estas reglas no son mediciones de confort real ni resultados de un modelo entrenado.')
h('Plan para entrenar y evaluar Machine Learning')
p('Recolectar temperatura, humedad y velocidad del aire junto con encuestas anónimas de estudiantes, vinculadas por lectura o ventana temporal. Definir las clases a partir de los votos humanos; estudiar un clasificador multiclase, por ejemplo Random Forest. Evaluar por sesiones y participantes separados, comparar con una clase mayoritaria y reportar F1 macro y matriz de confusión.')
p('No usar escenario, mensaje_id ni etiquetas generadas por reglas como validación del modelo real. La recomendación futura traducirá la estimación en niveles de velocidad e incorporará desacuerdos entre zonas e histéresis para evitar cambios frecuentes.')
h('Limitaciones que afectan la pregunta de investigación')
p('Con los sensores previstos se puede estudiar una estimación empírica del confort de esa población. Ropa, actividad, temperatura radiante y diferencias individuales no se observan con este montaje. Por eso la simulación demuestra factibilidad técnica de adquisición y comunicación, pero todavía no responde si la predicción será precisa.')
p('Un ventilador con niveles genera movimiento de aire y no garantiza ventilación con aire exterior. No hay medición de CO₂ ni evaluación de renovación de aire. Tampoco se ha calibrado la equivalencia entre un nivel de velocidad y el aire recibido por cada zona.')
#6
page();title(6,'Resultados de la prueba ejecutada')
box('<b>APROBADO: 80 lecturas, 2 nodos y 6 canales virtuales.</b><br/>MQTT 3.1.1 real por TCP; broker aMQTT 0.11.3 y almacenamiento SQLite. Las pruebas corresponden a datos sintéticos.')
table([['Comprobación','Resultado observado'],['Publicación y recepción','40 lecturas por nodo, diez por escenario'],['Recomendaciones','80 filas; 81 mensajes MQTT, incluida una reentrega'],['QoS 1 y deduplicación','Un mensaje repetido no crea una fila adicional'],['Validación','Dos rechazos: humedad >100% y topic/zona inconsistente'],['Estado retenido / Last Will','Dos estados offline para un suscriptor tardío; Last Will probado'],['Integridad relacional','Sin violaciones de claves foráneas; cero encuestas fabricadas']], [190,321],pad=4)
h('Promedios de las lecturas recibidas')
rows=[['Nodo','Escenario','n','T °C','HR %','Aire m/s']]
order={'frio':0,'confort':1,'calor':2,'ventilado':3}
for node,scenario,n,t,hr,air in sorted(result['resumen_por_nodo_escenario'],key=lambda r:(r[0],order[r[1]])):
    rows.append([node,scenario,n,f'{t:.2f}',f'{hr:.2f}',f'{air:.3f}'])
table(rows,[100,99,38,85,85,104],pad=4)
story.append(Chart());story.append(Spacer(1,8))
p('Gráfico de 40 muestras por zona. El eje horizontal muestra el orden de las fases aceleradas; las curvas son lecturas sintéticas recibidas y almacenadas, no observaciones de estudiantes.','SmallX')
#7
page();title(7,'Evidencia visual y archivos entregados')
p('Dashboard revisado en el navegador con los dos nodos transmitiendo por MQTT. La captura corresponde a una demostración continua independiente de la prueba de 80 lecturas; por eso su contador muestra 82 registros.')
shot=BASE/'evidencias/dashboard_verificado.jpg'
if shot.exists():
    from PIL import Image as PILImage
    with PILImage.open(shot) as im:iw,ih=im.size
    height=390;width=height*iw/ih
    story.append(Image(str(shot),width=width,height=height,hAlign='CENTER'))
p('En el escenario de calor, ambas zonas reciben nivel sugerido 3. La captura conserva la indicación visible de datos sintéticos y reglas de demostración.','SmallX')
h('Evidencias reproducibles')
p('<b>resultado.json:</b> resumen de comprobaciones.<br/><b>telemetria.jsonl / mensajes_mqtt.json:</b> lecturas y mensajes observados en red.<br/><b>confort.sqlite:</b> lecturas y recomendaciones relacionales.<br/><b>zona1.log / zona2.log / colector.log:</b> registros de ejecución.<br/><b>dashboard.html:</b> instantánea que puede abrirse sin levantar servicios.')
box('<b>Pendiente de validación:</b> el Compose pasó la comprobación de configuración, pero EMQX y MySQL no se ejecutaron en este equipo. El usuario no dispone de acceso al servicio Docker y sudo requiere contraseña. MongoDB se presenta como modelo, sin ejecución.')
#8
page();title(8,'Reproducción y siguiente avance')
h('Ruta del laboratorio: EMQX + MySQL + Docker')
p('Desde la carpeta simulacion_mqtt, con Docker Engine accesible y puertos disponibles:')
code('''cp .env.example .env
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs -f zona1 zona2 collector''')
table([['Interfaz','Dirección y acceso'],['Dashboard del aula','http://localhost:8090'],['EMQX Dashboard','http://localhost:18083; inicialmente admin / public'],['phpMyAdmin','http://localhost:8080; confort / contraseña de .env'],['MQTT TCP','localhost:1883; requiere un cliente MQTT']], [150,361])
p('El puerto 1883 corresponde al protocolo MQTT y no abre una página web. Los servicios se enlazan a la interfaz local. Para finalizar conservando datos, ejecutar docker compose down. Si Docker requiere permisos, usar la vía administrativa autorizada en el equipo.','SmallX')
h('Ruta verificada sin Docker')
code('''python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-demo.txt
.venv/bin/python verificar.py
.venv/bin/python demo_local.py''')
p('La prueba termina tras generar evidencias; la demo continua abre el dashboard en 127.0.0.1:8090 y se detiene con Ctrl+C. Usa aMQTT en 18883 y SQLite. El README incluye parámetros para acelerar los escenarios.')
h('Pasos para la siguiente entrega')
p('1. Ejecutar la ruta Docker y capturar clientes EMQX y filas de MySQL.<br/>2. Sustituir los generadores por ESP32 físicos con el mismo contrato MQTT.<br/>3. Calibrar sensores y registrar ubicación y nivel del ventilador.<br/>4. Recopilar encuestas reales y definir la política para desacuerdos entre zonas.<br/>5. Entrenar y evaluar el modelo, dejando separados datos sintéticos y humanos.')
h('Fuentes y trazabilidad')
p('PDF proporcionado: <i>Laboratorio_6 - 2026_II.pdf</i>, actividad de la página 6. El encabezado interior identifica LABORATORIO 05. Lista de materiales: imagen proporcionada por el usuario. Ambos se utilizan como referencias académicas para este avance.','SmallX')
for label,url in [('Eclipse Paho: cliente Python','https://eclipse.dev/paho/clients/python/docs/'),('EMQX: imagen oficial 5.8.8','https://hub.docker.com/_/emqx'),('EMQX: dashboard y puertos','https://docs.emqx.com/en/emqx/latest/get-started/getting-started.html'),('Docker: orden de inicio y comprobaciones de salud','https://docs.docker.com/compose/how-tos/startup-order/'),('MySQL: Connector/Python','https://dev.mysql.com/doc/connector-python/en/quick-installation-guide.html')]:
    p(f'<link href="{url}" color="#008579">{label}</link>','SmallX')

def decorate(c,doc):
    c.setTitle('Avance de simulación MQTT - Confort térmico en aulas de posgrado')
    c.setAuthor('Proyecto de confort térmico - Avance de simulación')
    c.setStrokeColor(TEAL);c.setLineWidth(2);c.line(42,809,553,809)
    c.setFont('LibSans',8);c.setFillColor(GRAY);c.drawString(42,820,'CONFORT TÉRMICO · IOT · MQTT')
    c.setStrokeColor(colors.HexColor('#d6e1e5'));c.setLineWidth(.5);c.line(42,35,553,35)
    c.setFont('LibSans',7.5);c.drawString(42,23,'Avance académico | Datos sintéticos | 8 de octubre de 2026')
    c.drawRightString(553,23,str(doc.page))

out=ROOT/'output/pdf/Avance_simulacion_MQTT_confort_termico.pdf'
doc=SimpleDocTemplate(str(out),pagesize=A4,rightMargin=42,leftMargin=42,topMargin=48,bottomMargin=46)
doc.build(story,onFirstPage=decorate,onLaterPages=decorate)
print(out)

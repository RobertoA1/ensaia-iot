// Modelo documental propuesto. MongoDB no es un servicio requerido del stack del laboratorio.
// Importacion opcional: mongoimport --db confort --collection eventos --file data/telemetria.jsonl
// Cada linea JSON es un documento independiente con telemetria y recomendacion anidadas.
db.eventos.createIndex({"telemetria.mensaje_id": 1}, {unique: true});
db.eventos.createIndex({"telemetria.zona_id": 1, "telemetria.instante_utc": -1});
// Las encuestas humanas se mantienen en una coleccion separada.
db.encuestas.createIndex({mensaje_id: 1});
// Ejemplo de consulta: lecturas sinteticas de zona2 durante calor.
db.eventos.find({"telemetria.zona_id": "zona2", "telemetria.escenario": "calor"});

CREATE TABLE aulas (
  aula_id VARCHAR(32) PRIMARY KEY, nombre VARCHAR(100) NOT NULL
);
CREATE TABLE zonas (
  zona_id VARCHAR(32) PRIMARY KEY, aula_id VARCHAR(32) NOT NULL,
  descripcion VARCHAR(100) NOT NULL,
  FOREIGN KEY (aula_id) REFERENCES aulas(aula_id)
);
CREATE TABLE nodos (
  nodo_id VARCHAR(32) PRIMARY KEY, zona_id VARCHAR(32) NOT NULL,
  dispositivo VARCHAR(32) NOT NULL,
  FOREIGN KEY (zona_id) REFERENCES zonas(zona_id)
);
CREATE TABLE lecturas (
  mensaje_id VARCHAR(128) PRIMARY KEY, nodo_id VARCHAR(32) NOT NULL,
  run_id VARCHAR(36) NOT NULL, secuencia INT NOT NULL,
  instante_utc VARCHAR(40) NOT NULL,
  temperatura_c DOUBLE NOT NULL, humedad_pct DOUBLE NOT NULL,
  velocidad_aire_ms DOUBLE NOT NULL, escenario VARCHAR(32) NOT NULL,
  nivel_ventilador_simulado INT NOT NULL, ocupantes_simulados INT NOT NULL,
  simulado BOOLEAN NOT NULL,
  FOREIGN KEY (nodo_id) REFERENCES nodos(nodo_id),
  UNIQUE (nodo_id, run_id, secuencia)
);
CREATE INDEX idx_lectura_nodo_fecha ON lecturas(nodo_id, instante_utc);
CREATE TABLE recomendaciones (
  mensaje_id VARCHAR(128) PRIMARY KEY, confort_estimado VARCHAR(32) NOT NULL,
  nivel_sugerido INT NOT NULL, origen VARCHAR(50) NOT NULL, motivo TEXT NOT NULL,
  FOREIGN KEY (mensaje_id) REFERENCES lecturas(mensaje_id)
);
-- Tabla preparada para las etiquetas humanas futuras; no se generan encuestas falsas.
CREATE TABLE encuestas (
  encuesta_id VARCHAR(36) PRIMARY KEY, mensaje_id VARCHAR(128) NOT NULL,
  participante_anonimo VARCHAR(64) NOT NULL, voto_termico INT NOT NULL,
  preferencia_aire VARCHAR(32) NOT NULL,
  CHECK (voto_termico BETWEEN -3 AND 3),
  FOREIGN KEY (mensaje_id) REFERENCES lecturas(mensaje_id)
);
INSERT INTO aulas VALUES ('aula-posgrado-01', 'Aula de posgrado 01');
INSERT INTO zonas VALUES
 ('zona1', 'aula-posgrado-01', 'Zona cercana al ventilador'),
 ('zona2', 'aula-posgrado-01', 'Zona alejada del ventilador');
INSERT INTO nodos VALUES
 ('esp32-z1', 'zona1', 'ESP32 virtual'),
 ('esp32-z2', 'zona2', 'ESP32 virtual');

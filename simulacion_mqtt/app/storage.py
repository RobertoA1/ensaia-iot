import os
import sqlite3
from pathlib import Path

FIELDS = ['mensaje_id', 'nodo_id', 'run_id', 'secuencia', 'instante_utc',
          'temperatura_c', 'humedad_pct', 'velocidad_aire_ms', 'escenario',
          'nivel_ventilador_simulado', 'ocupantes_simulados', 'simulado']

class Storage:
    def __init__(self, directory):
        self.mysql = os.getenv('DB_BACKEND', 'sqlite') == 'mysql'
        if self.mysql:
            import mysql.connector
            self.db = mysql.connector.connect(host=os.getenv('MYSQL_HOST', 'mysql'),
                user=os.getenv('MYSQL_USER', 'confort'), password=os.environ['MYSQL_PASSWORD'],
                database=os.getenv('MYSQL_DATABASE', 'confort_db'))
        else:
            self.db = sqlite3.connect(directory / 'confort.sqlite')
            self.db.execute('PRAGMA foreign_keys = ON')
            found = self.db.execute("SELECT name FROM sqlite_master WHERE name='lecturas'").fetchone()
            if not found:
                sql = (Path(__file__).resolve().parents[1] / 'sql/mysql.sql').read_text()
                self.db.executescript(sql)
            self.db.commit()

    def save(self, p, r):
        cur = self.db.cursor()
        placeholder = '%s' if self.mysql else '?'
        cur.execute(f'SELECT mensaje_id FROM lecturas WHERE mensaje_id={placeholder}',
                    (p['mensaje_id'],))
        if cur.fetchone():
            cur.close()
            return False
        try:
            slots = ','.join([placeholder] * len(FIELDS))
            cur.execute(f"INSERT INTO lecturas ({','.join(FIELDS)}) VALUES ({slots})",
                        tuple(p[k] for k in FIELDS))
            slots = ','.join([placeholder] * 5)
            cur.execute(f'INSERT INTO recomendaciones VALUES ({slots})',
                        tuple(r[k] for k in ['mensaje_id', 'confort_estimado', 'nivel_sugerido', 'origen', 'motivo']))
            self.db.commit()
            return True
        except Exception:
            self.db.rollback()
            raise
        finally:
            cur.close()

    def close(self):
        self.db.close()

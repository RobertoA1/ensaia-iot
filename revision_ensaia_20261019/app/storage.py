import json
from pathlib import Path
import sqlite3
from .protocol import utcnow

class Store:
    def __init__(self, directory: Path):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(directory/'oratoria.sqlite', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, participant TEXT NOT NULL, phase TEXT NOT NULL,
            feedback_enabled INTEGER NOT NULL, demo INTEGER NOT NULL,
            started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER,
            status TEXT NOT NULL, summary_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY, sid TEXT NOT NULL REFERENCES sessions(id),
            kind TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL,
            device_confirmed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS event_session ON events(sid,created_at);
        CREATE TABLE IF NOT EXISTS annotations (
            id INTEGER PRIMARY KEY, sid TEXT NOT NULL REFERENCES sessions(id),
            event_id TEXT REFERENCES events(id), reviewer TEXT NOT NULL,
            label TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS evaluations (
            sid TEXT NOT NULL REFERENCES sessions(id), reviewer TEXT NOT NULL,
            payload_json TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY(sid,reviewer)
        );
        CREATE TABLE IF NOT EXISTS surveys (
            sid TEXT PRIMARY KEY REFERENCES sessions(id), payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        ''')
        # No presentar como terminadas las sesiones que quedaron abiertas por una caida.
        self.db.execute("UPDATE sessions SET status='interrupted', ended_at=? WHERE status IN ('starting','recording','closing')", (utcnow(),))
        self.db.commit()

    def create(self, sid, participant, phase, enabled, demo):
        self.db.execute('INSERT INTO sessions(id,participant,phase,feedback_enabled,demo,started_at,status) VALUES (?,?,?,?,?,?,?)',
                        (sid,participant,phase,enabled,demo,utcnow(),'starting'))
        self.db.commit()
        (self.directory/sid).mkdir(exist_ok=True)

    def update(self, sid, **values):
        assert set(values) <= {'status','ended_at','duration_ms','summary_json'}
        self.db.execute('UPDATE sessions SET '+','.join(k+'=?' for k in values)+' WHERE id=?', (*values.values(),sid))
        self.db.commit()

    def event(self, event):
        self.db.execute('INSERT OR IGNORE INTO events(id,sid,kind,created_at,payload_json) VALUES (?,?,?,?,?)',
                        (event['id'],event['sid'],event['kind'],event['at'],json.dumps(event,ensure_ascii=False)))
        self.db.commit()

    def confirm(self, event):
        row = self.db.execute('SELECT payload_json,device_confirmed_at FROM events WHERE id=?', (event.get('id'),)).fetchone()
        if row is None or json.loads(row['payload_json']) != event:
            return False
        self.db.execute('UPDATE events SET device_confirmed_at=COALESCE(device_confirmed_at,?) WHERE id=?', (utcnow(),event['id']))
        self.db.commit()
        return row['device_confirmed_at'] is None

    def pending(self, sid=None):
        query='SELECT payload_json FROM events WHERE device_confirmed_at IS NULL'
        args=()
        if sid:
            query+=' AND sid=?'
            args=(sid,)
        return [json.loads(r[0]) for r in self.db.execute(query+' ORDER BY rowid LIMIT 12',args)]

    def events(self, sid):
        return [dict(r) for r in self.db.execute('SELECT * FROM events WHERE sid=? ORDER BY rowid',(sid,))]

    def pending_count(self, sid):
        return self.db.execute('SELECT COUNT(*) FROM events WHERE sid=? AND device_confirmed_at IS NULL',(sid,)).fetchone()[0]

    def session(self, sid):
        row=self.db.execute('SELECT * FROM sessions WHERE id=?',(sid,)).fetchone()
        return dict(row) if row else None

    def sessions(self):
        return [dict(r) for r in self.db.execute('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 200')]

    def close(self):
        self.db.close()

    def evaluation(self,sid,reviewer):
        row=self.db.execute('SELECT payload_json FROM evaluations WHERE sid=? AND reviewer=?',(sid,reviewer)).fetchone()
        return json.loads(row[0]) if row else None

    def save_evaluation(self,sid,payload):
        self.db.execute('INSERT INTO evaluations VALUES (?,?,?,?) ON CONFLICT(sid,reviewer) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at',
            (sid,payload['reviewer'],json.dumps(payload,ensure_ascii=False),utcnow()))
        self.db.commit()

    def survey(self,sid):
        row=self.db.execute('SELECT payload_json FROM surveys WHERE sid=?',(sid,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_survey(self,sid,payload):
        self.db.execute('INSERT INTO surveys VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at',
            (sid,json.dumps(payload,ensure_ascii=False),utcnow()))
        self.db.commit()

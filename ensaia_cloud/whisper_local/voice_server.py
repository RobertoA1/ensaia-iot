"""Fallback de voz local: solo acepta la web ENSAIA o su desarrollo local."""
import json, os, subprocess, tempfile, threading, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from piper import PiperVoice

PORT=18765
ORIGINS={'https://ensaia-oratoria.vercel.app','http://localhost:5173','http://127.0.0.1:5173'}
VOICE=Path(__file__).resolve().parent/'voices/es_MX-claude-high.onnx'

def start_voice_server():
    voice=PiperVoice.load(str(VOICE));lock=threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def respond(self,status,data):
            body=json.dumps(data).encode();self.send_response(status)
            origin=self.headers.get('Origin','')
            if origin in ORIGINS:self.send_header('Access-Control-Allow-Origin',origin)
            self.send_header('Vary','Origin');self.send_header('Access-Control-Allow-Methods','POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers','Content-Type');self.send_header('Access-Control-Allow-Private-Network','true')
            self.send_header('Cache-Control','no-store');self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)))
            self.end_headers();self.wfile.write(body)
        def do_OPTIONS(self):
            if self.headers.get('Origin') not in ORIGINS:return self.respond(403,{'error':'Origen no autorizado'})
            self.respond(200,{'ok':True})
        def do_POST(self):
            if self.path!='/speak' or self.headers.get('Origin') not in ORIGINS:return self.respond(403,{'error':'Origen no autorizado'})
            try:
                n=int(self.headers.get('Content-Length','0'))
                if n<1 or n>4096: return self.respond(400,{'error':'Solicitud inválida'})
                text=json.loads(self.rfile.read(n)).get('text','')
                if not isinstance(text,str) or not text.strip() or len(text)>700:return self.respond(400,{'error':'Texto inválido'})
                with lock:
                    fd,path=tempfile.mkstemp(prefix='ensaia-voz-',suffix='.wav');os.close(fd)
                    try:
                        with wave.open(path,'wb') as wav:voice.synthesize_wav(text,wav)
                        result=subprocess.run(['paplay',path],timeout=45,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                        if result.returncode:raise RuntimeError('Salida de audio no disponible')
                    finally:os.unlink(path)
                self.respond(200,{'ok':True})
            except Exception:self.respond(503,{'error':'No se pudo reproducir la voz en la laptop'})
    server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    return server

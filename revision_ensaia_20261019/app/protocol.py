import re
import struct
import uuid
from datetime import datetime, timezone

RATE = 16000
SAMPLES_PER_FRAME = 320
HEADER = struct.Struct('<8sII')
MAX_PACKET = HEADER.size + SAMPLES_PER_FRAME * 2
SID = re.compile(r'^[a-f0-9]{8}$')

def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')

def new_id():
    return uuid.uuid4().hex

def unpack_audio(packet: bytes):
    if len(packet) <= HEADER.size or len(packet) > MAX_PACKET or (len(packet)-HEADER.size) % 2:
        raise ValueError('Trama PCM invalida: cabecera de 16 bytes y hasta 640 bytes PCM16')
    sid, seq, offset = HEADER.unpack_from(packet)
    sid = sid.decode('ascii')
    if not SID.fullmatch(sid):
        raise ValueError('ID de sesion invalido')
    return sid, seq, offset, packet[HEADER.size:]

def pack_audio(sid, seq, offset, pcm):
    packet = HEADER.pack(sid.encode('ascii'), seq, offset) + pcm
    unpack_audio(packet)
    return packet

def text_parts(text, max_bytes=420):
    """Divide UTF-8 sin partir caracteres y conserva exactamente los espacios."""
    part = ''
    for char in text:
        if len((part + char).encode()) > max_bytes:
            yield part
            part = ''
        part += char
    if part:
        yield part

"""Pruebas locales: sin hardware, sin claves reales y sin consumo de API."""
import asyncio
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import wave

import pytest
import uvicorn

BASE = Path(__file__).resolve().parents[1]
PROJECT = BASE.parent / 'revision_ensaia_20261019'
os.environ['ORATORIA_ENV_LOADED'] = '1'
sys.path.insert(0, str(PROJECT))
from app.config import Settings
from app.main import create_app
from app.mqtt import MQTTLink
from app.protocol import pack_audio

spec = importlib.util.spec_from_file_location('puente_esp32', BASE / 'puente_esp32.py')
bridge_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_module)


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def test_real_cpp_conversion_and_binary_header(tmp_path):
    source = tmp_path / 'audio_test.cpp'
    source.write_text('''
#include "audio_format.h"
#include <assert.h>
#include <limits.h>
int main() {
  assert(ensaia::pcm16(0, 1) == 0);
  assert(ensaia::pcm16(INT32_MAX, 1) == 32767);
  assert(ensaia::pcm16(INT32_MIN, 1) == -32768);
  assert(ensaia::pcm16(0x12345600, 1) == 0x1234);
  assert(ensaia::pcm16(0x70000000, 4) == 32767);
  assert(ensaia::pcm16(-0x70000000, 4) == -32768);
  unsigned char p[656] = {};
  ensaia::header(p, "0123abcd", 258);
  assert(p[8] == 2 && p[9] == 1 && p[10] == 0 && p[11] == 0);
  assert(p[12] == 0x80 && p[13] == 0x42 && p[14] == 1 && p[15] == 0);
  ensaia::sample(p + 16, -2);
  assert(p[16] == 0xfe && p[17] == 0xff);
}
''')
    binary = tmp_path / 'audio_test'
    subprocess.run(['g++', '-std=c++11', '-Wall', '-Werror', '-I',
                    str(BASE / 'firmware/ENSAIA_ESP32S3'), str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)


class FakeS3:
    def __init__(self, settings, drop=None):
        self.settings = settings
        self.sid = ''
        self.frames = 0
        self.stop = False
        self.drop = drop
        self.producer = None
        self.link = MQTTLink(settings, 'fake-s3', [
            (settings.root + '/down/audio', 0), (settings.root + '/down/control', 0),
            (settings.root + '/down/event', 0), (settings.root + '/down/mic_control', 0),
        ], self.receive)

    async def receive(self, topic, data):
        root = self.settings.root
        if topic.endswith('/mic_control'):
            request = json.loads(data)
            if request['op'] == 'mic_start':
                self.stop = False
                self.frames = 0
                self.producer = asyncio.create_task(self.produce())
            else:
                self.stop = True
                if self.producer:
                    await self.producer
            self.link.publish(root + '/up/mic_control', dict(request, ok=True, frames=self.frames), qos=0)
        elif topic.endswith('/control'):
            request = json.loads(data)
            self.sid = request['sid'] if request['op'] == 'start' else ''
            self.link.publish(root + '/up/control', request, qos=0)
        elif topic.endswith('/audio'):
            self.link.publish(root + '/up/audio', data, qos=0)
        elif topic.endswith('/event'):
            self.link.publish(root + '/up/event', data, qos=0)

    async def produce(self):
        while not self.stop:
            seq = self.frames
            if seq != self.drop:
                self.link.publish(self.settings.root + '/up/mic_audio',
                    pack_audio(self.sid, seq, seq * 320, struct.pack('<h', seq + 1) * 320), qos=0)
            self.frames += 1
            await asyncio.sleep(.02)

    async def heartbeat(self):
        while True:
            self.link.publish(self.settings.root + '/up/status', {
                'online': True, 'simulated': True, 'sid': self.sid, 'firmware': 'ensaia-s3-i2s-v1',
            }, retain=True)
            await asyncio.sleep(.25)


async def scenario(tmp_path, drop=None):
    settings = Settings(app_token='fake-local-token-with-no-real-credentials', api_key='',
        mqtt_password='fake-mqtt-password-1234567890', mqtt_host='127.0.0.1', mqtt_bind='127.0.0.1',
        mqtt_port=port(), simulate_device=False, builtin_broker=True, data_dir=tmp_path)
    webport = port()
    app = create_app(settings)
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=webport, log_level='error'))
    server_task = asyncio.create_task(server.serve())
    node = None
    bridge = None
    heartbeat = None
    try:
        for _ in range(200):
            if server.started:
                break
            if server_task.done():
                await server_task
            await asyncio.sleep(.025)
        assert server.started
        node = FakeS3(settings, drop)
        await node.link.start()
        heartbeat = asyncio.create_task(node.heartbeat())
        bridge = bridge_module.MicrophoneBridge(settings, MQTTLink)
        await bridge.link.start()
        await asyncio.sleep(.35)
        request = {'participant': 'TESTS3', 'phase': 'practice', 'feedback': True,
                   'demo': True, 'consent': True, 'play_audio': False}
        if drop is None:
            sid, summary = await bridge_module.record(bridge, f'http://127.0.0.1:{webport}',
                                                      settings.app_token, request, 1.2)
            assert summary['original_frames'] == summary['relay_frames'] == node.frames > 30
            assert bridge.forwarded == bridge.received == bridge.expected_frames == node.frames
            assert summary['audio_relay_complete'] and summary['provider_audio_complete']
            assert summary['pending_device_events'] == 0
            assert summary['demo'] and summary['device_simulated']
            with wave.open(str(tmp_path / sid / 'microfono_original.wav')) as original:
                pcm = original.readframes(original.getnframes())
                assert original.getframerate() == 16000
            with wave.open(str(tmp_path / sid / 'audio_via_esp8266.wav')) as relay:
                assert relay.readframes(relay.getnframes()) == pcm
            assert pcm == b''.join(struct.pack('<h', i + 1) * 320 for i in range(node.frames))
        else:
            with pytest.raises(RuntimeError, match='Perdida o duplicacion'):
                await bridge_module.record(bridge, f'http://127.0.0.1:{webport}',
                                          settings.app_token, request, 1.2)
            assert bridge.failure.is_set()
            assert bridge.forwarded <= drop
            for _ in range(100):
                row = app.state.engine.store.session(bridge.sid)
                if row['status'] in ('ended', 'interrupted'):
                    break
                await asyncio.sleep(.05)
            assert row['status'] == 'interrupted'
    finally:
        if node:
            node.stop = True
            if node.producer:
                await node.producer
        if heartbeat:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
        if bridge:
            await bridge.link.close()
        if node:
            await node.link.close()
        server.should_exit = True
        await asyncio.wait_for(server_task, 20)


def test_mqtt_capture_bridge_server_relay_storage(tmp_path):
    asyncio.run(scenario(tmp_path))


def test_missing_source_packet_interrupts_instead_of_hiding_loss(tmp_path):
    asyncio.run(scenario(tmp_path, drop=5))


def test_truncated_source_packet_is_rejected():
    with pytest.raises(ValueError):
        bridge_module.inspect_packet(b'0' * 655)
    packet = pack_audio('abcdef12', 1, 0, b'\0' * 640)
    with pytest.raises(ValueError):
        bridge_module.inspect_packet(packet)


def test_lost_final_packet_is_detected_from_stop_ack():
    async def exercise():
        bridge = bridge_module.MicrophoneBridge(
            type('Settings', (), {'device_id': 's3'})(),
            lambda *args: object())
        bridge.received = bridge.forwarded = 9
        with pytest.raises(RuntimeError, match='Audio incompleto'):
            await bridge.drain(expected=10, timeout=.01)
    asyncio.run(exercise())

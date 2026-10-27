import json
from pathlib import Path
import struct
import subprocess
import sys
import wave
import pytest
from app.analysis import SpeechAnalysis
from app.config import Settings
from app.main import csv_cell
from app.protocol import pack_audio,unpack_audio,text_parts
from app.storage import Store

def test_pcm_roundtrip_and_validation():
    pcm=struct.pack('<320h',*range(320))
    packet=pack_audio('abcdef12',4,1280,pcm)
    assert unpack_audio(packet)==('abcdef12',4,1280,pcm)
    for bad in [b'',packet[:-1],b'x'*700,pack_audio('abcdef12',0,0,b'\0\0').replace(b'abcdef12',b'BAD SID!')]:
        with pytest.raises((ValueError,UnicodeDecodeError)):
            unpack_audio(bad)

def test_utf8_fragmentation_preserves_every_character():
    text=('¡Eh! Presentación, ingeniería, niño. '*100)
    chunks=list(text_parts(text))
    assert ''.join(chunks)==text
    assert all(len(x.encode())<=420 for x in chunks)

def test_fragmented_words_are_not_counted_twice():
    a=SpeechAnalysis()
    a.append_text('Buenos días, e',0,100)
    assert not a.events
    a.append_text('h, este proyecto pro',100,600)
    a.append_text('yecto es útil. ',600,1000)
    assert sum(x['kind']=='filled_pause_candidate' for x in a.events)==1
    assert sum(x['kind']=='contextual_filler_candidate' for x in a.events)==1
    assert sum(x['kind']=='repetition_candidate' for x in a.events)==1
    a.finish()
    assert a.text=='Buenos días, eh, este proyecto proyecto es útil. '
    assert all(x['validation']=='pending_human' for x in a.events)

def test_terminal_word_is_finalized():
    a=SpeechAnalysis()
    a.append_text('eh')
    assert not a.events
    a.finish()
    assert len(a.events)==1

def test_contextual_words_are_not_human_truth():
    a=SpeechAnalysis()
    a.append_text('Este es el resultado. Bueno, continuamos. ',0,1000)
    assert all(x['kind']=='contextual_filler_candidate' for x in a.events)
    assert a.metrics()['measurement_status']=='exploratory_not_human_validated'

def test_silence_clipping_and_audio_duration():
    a=SpeechAnalysis()
    for _ in range(50):
        a.audio(b'\0'*640)
    a.audio(struct.pack('<320h',*([32767]*320)))
    a.finish()
    assert a.metrics()['captured_audio_seconds']==1.02
    assert len(a.silences)==1
    assert a.silences[0]['end_ms']==1000
    assert a.metrics()['clipped_sample_ratio']>0

def test_storage_confirmation_is_idempotent_and_checks_payload(tmp_path):
    s=Store(tmp_path)
    s.create('abcdef12','P01','pre',False,True)
    e={'id':'test','sid':'abcdef12','kind':'transcript.user','at':'2026-10-17T10:00:00+00:00','text':'texto original'}
    s.event(e)
    assert not s.confirm(dict(e,text='texto alterado'))
    assert s.confirm(e)
    assert not s.confirm(e)
    assert not s.pending('abcdef12')
    s.close()

def test_interrupted_session_is_recovered(tmp_path):
    s=Store(tmp_path)
    s.create('abcdef12','P01','pre',False,True)
    s.close()
    s=Store(tmp_path)
    assert s.session('abcdef12')['status']=='interrupted'
    s.close()

def test_pending_count_includes_more_than_one_retry_batch(tmp_path):
    s=Store(tmp_path)
    s.create('abcdef12','P01','pre',False,True)
    for i in range(30):
        s.event({'id':str(i),'sid':'abcdef12','kind':'test','at':'2026-10-17T10:00:00+00:00'})
    assert len(s.pending('abcdef12'))==12
    assert s.pending_count('abcdef12')==30
    s.close()

def test_csv_injection_guard():
    assert csv_cell('=HYPERLINK("x")').startswith("'")
    assert csv_cell('hola')=='hola'

def test_model_is_preserved():
    s=Settings(app_token='a'*25,mqtt_password='b'*20,live_model='gpt-realtime')
    with pytest.raises(ValueError,match='GPT-Live'):
        s.validate()

def test_javascript_resampling():
    script=Path(__file__).with_name('test_worklet.cjs')
    result=subprocess.run(['node',str(script)],capture_output=True,text=True,check=True)
    assert '48000' in result.stdout and '44100' in result.stdout

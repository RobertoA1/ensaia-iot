import asyncio
import base64
import json
from types import SimpleNamespace
import pytest
from app.analysis import SpeechAnalysis
from app.config import Settings
from app.engine import Recording
from app.live import LiveConnection
from app.storage import Store


def phrase_events(analysis):
    return [e for e in analysis.events if e.get('origin')=='exact_text_sequence']


def test_repeated_sentence_detected_across_deltas_once():
    a=SpeechAnalysis();new=[]
    for text in ['Debemos organizar el tiempo. Debemos org','anizar el ', 'tiempo. ']:
        new.extend(a.append_text(text))
    a.finish()
    phrases=phrase_events(a)
    assert len(phrases)==1
    assert phrases[0]['token']=='Debemos organizar el tiempo'
    assert phrases[0]['word_count']==4
    assert phrases[0]['validation']=='pending_human'
    assert sum(e.get('origin')=='exact_text_sequence' for e in new)==1


def test_prefix_is_not_counted_again_when_phrase_finishes():
    a=SpeechAnalysis()
    a.append_text('vamos a mejorar vamos a ')
    assert not phrase_events(a)
    a.append_text('mejorar. ')
    assert [e['token'] for e in phrase_events(a)]==['vamos a mejorar']
    for text in ['Otra idea diferente. ','Cuidar nuestra salud. ','Escuchar con atencion. ']: a.append_text(text)
    assert len(phrase_events(a))==1


def test_nonconsecutive_phrase_is_candidate_not_confirmed_error():
    a=SpeechAnalysis()
    a.append_text('La educación importa. Primero explicaré por qué. La educación importa. ')
    assert len(phrase_events(a))==1
    assert phrase_events(a)[0]['validation']=='pending_human'
    assert a.metrics()['repetition_candidate']==1


def test_word_repetitions_do_not_turn_into_duplicate_phrase_counts():
    a=SpeechAnalysis();a.append_text('muy muy muy muy. ')
    assert a.metrics()['repetition_candidate']==3
    assert not phrase_events(a)


def test_final_phrase_without_punctuation_and_distinct_sentences():
    a=SpeechAnalysis();a.append_text('Mejora tu tiempo mejora tu tiempo')
    a.finish()
    assert len(phrase_events(a))==1
    b=SpeechAnalysis();b.append_text('La educación transforma vidas. El trabajo requiere paciencia. ')
    assert not phrase_events(b)


def test_coach_uses_instruction_event_not_silent_context():
    async def exercise():
        messages=[]
        class Socket:
            async def send(self,data):messages.append(json.loads(data))
        live=LiveConnection(Settings(),None);live.ws=Socket()
        await live.context('Hechos observados')
        await live.coach('Una frase repetida')
        await live.coach('Otra frase repetida')
        assert messages[0]['type']=='session.thinking.append'
        assert messages[1]['type']=='session.instructions.append'
        assert messages[1]['delegation_id'] is None
        assert 'Una frase repetida' in messages[1]['content']
        assert len({m['event_id'] for m in messages})==3
    asyncio.run(exercise())


def test_live_feedback_cues_are_bounded_and_audio_playback_is_opt_in(tmp_path):
    async def exercise():
        store=Store(tmp_path);store.create('aaaaaaaa','P01','practice',True,True)
        delivered=[]
        engine=SimpleNamespace(store=store,link=SimpleNamespace(dropped=0),device={},settings=Settings(),
            root='test',send_event=lambda event:None)
        r=Recording(engine,'aaaaaaaa',True,True)
        async def broadcast(payload):delivered.append(payload)
        r.broadcast=broadcast
        try:
            await r.provider_event({'type':'session.input_transcript.delta',
                'delta':'Organizar nuestro tiempo permite estudiar mejor y también descansar. Organizar nuestro tiempo permite estudiar mejor y también descansar. '})
            queued=list(r.provider_queue._queue)
            assert sum(kind=='coach' for kind,_ in queued)==1
            await r.provider_event({'type':'session.input_transcript.delta','delta':'eh eh eh. '})
            assert sum(kind=='coach' for kind,_ in r.provider_queue._queue)==1
            await r.provider_event({'type':'session.output_audio.delta','delta':base64.b64encode(b'\0\0').decode()})
            assert not delivered
            r.play_audio=True
            await r.provider_event({'type':'session.output_audio.delta','delta':base64.b64encode(b'\0\0').decode()})
            assert delivered[0]['type']=='assistant_audio'
            r.closing=True
            before=r.provider_queue.qsize()
            await r.provider_event({'type':'session.input_transcript.delta','delta':'otra otra idea. '})
            assert r.provider_queue.qsize()==before
        finally:
            for f in [r.original,r.relay,r.audio_out,r.raw_log]:
                if f:f.close()
            store.close()
    asyncio.run(exercise())

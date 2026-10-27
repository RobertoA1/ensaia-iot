"""Indicadores exploratorios. Los candidatos textuales NO son etiquetas humanas."""
from array import array
import math
import re
import sys

WORDS = re.compile(r'\b[^\W\d_]+\b', re.UNICODE)
SOUNDS = {'eh', 'em', 'mmm', 'mm', 'uh', 'eeh', 'ehh'}
CONTEXTUAL = {'este', 'pues', 'bueno', 'digamos', 'básicamente', 'literalmente'}

class SpeechAnalysis:
    def __init__(self):
        self.text = ''
        self.spans = []
        self.events = []
        self.samples = 0
        self.clipped = 0
        self.silent_start = None
        self.silences = []
        self.square_sum = 0
        self.phrase_token_count = 0

    def append_text(self, text, start_ms=None, end_ms=None, final=False):
        previous = len(self.text)
        self.text += text
        self.spans.append((previous, len(self.text), start_ms, end_ms))
        tokens = list(WORDS.finditer(self.text))
        # El ultimo token puede continuar en el siguiente delta: no cerrarlo prematuramente.
        if tokens and not final and tokens[-1].end() == len(self.text):
            tokens = tokens[:-1]
        found = []
        for i, match in enumerate(tokens):
            word = match.group().lower()
            kind = 'filled_pause_candidate' if word in SOUNDS else 'contextual_filler_candidate' if word in CONTEXTUAL else None
            if word == 'sea' and i and tokens[i-1].group().lower() == 'o':
                kind = 'contextual_filler_candidate'
            if kind:
                found.append(self._event(kind, match, word))
            if i and word == tokens[i-1].group().lower():
                found.append(self._event('repetition_candidate', match, word))
        # Buscar secuencias completas, tambien separadas por palabras intermedias.
        # No emitir un prefijo mientras el siguiente delta pueda ampliar la frase.
        words=[m.group().casefold() for m in tokens]
        committed=[e for e in self.events if e.get('origin')=='exact_text_sequence']
        found.extend(committed)
        i=max(0,self.phrase_token_count-40)
        while i<len(tokens):
            if any(e['char_start']<=tokens[i].start()<e['char_end'] for e in committed):
                i+=1
                continue
            best=0; previous_index=0
            for j in range(max(0,i-120),i):
                size=0
                while size<min(40,i-j,len(tokens)-i) and words[j+size]==words[i+size]:
                    size+=1
                if size>best and size>=2 and len(set(words[i:i+size]))>1:
                    best=size;previous_index=j
            if best>=2:
                end=i+best
                suffix=self.text[tokens[end-1].end():]
                stable=end<len(tokens) or final or bool(re.match(r'\s*[.!?,;:\n]',suffix))
                if stable:
                    match=tokens[i]
                    event=self._event('repetition_candidate',match,self.text[match.start():tokens[end-1].end()][:120])
                    event.update(char_end=tokens[end-1].end(),repeated_from=tokens[previous_index].start(),
                        repetition_scope='phrase',origin='exact_text_sequence',word_count=best)
                    found.append(event)
                    committed.append(event)
                    i=end
                    continue
            i+=1
        self.phrase_token_count=len(tokens)
        old = {(e['kind'], e['char_start']) for e in self.events}
        self.events = found
        return [e for e in found if (e['kind'], e['char_start']) not in old]

    def _event(self, kind, match, word):
        for first, last, start, end in reversed(self.spans):
            if first <= match.start() < last:
                break
        return {'kind': kind, 'token': word, 'char_start': match.start(),
                'char_end': match.end(), 'start_ms': start, 'end_ms': end,
                'timing_precision': 'transcript_fragment', 'validation': 'pending_human'}

    def audio(self, pcm, rate=16000):
        values = array('h')
        values.frombytes(pcm)
        if sys.byteorder != 'little':
            values.byteswap()
        if not values:
            return
        square = sum(x*x for x in values)
        rms = math.sqrt(square/len(values))/32768
        begin = self.samples/rate*1000
        self.samples += len(values)
        self.square_sum += square
        self.clipped += sum(abs(x) >= 32760 for x in values)
        if rms < 0.01:
            if self.silent_start is None:
                self.silent_start = begin
        elif self.silent_start is not None:
            self._close_silence(begin)

    def _close_silence(self, end):
        if self.silent_start is not None and end-self.silent_start >= 800:
            self.silences.append({'start_ms': round(self.silent_start), 'end_ms': round(end),
                                 'origin': 'rms_threshold_heuristic'})
        self.silent_start = None

    def finish(self):
        self._close_silence(self.samples/16)
        return self.append_text('', final=True)

    def metrics(self):
        seconds = self.samples/16000
        counts = {kind: sum(e['kind'] == kind for e in self.events) for kind in
                  ['filled_pause_candidate', 'contextual_filler_candidate', 'repetition_candidate']}
        words = len(WORDS.findall(self.text))
        return dict(counts, words=words, captured_audio_seconds=round(seconds, 3),
                    words_per_minute=round(words*60/seconds, 2) if seconds else None,
                    candidate_fillers_per_minute=round((counts['filled_pause_candidate']+counts['contextual_filler_candidate'])*60/seconds,2) if seconds else None,
                    silences_over_800ms=len(self.silences),
                    clipped_sample_ratio=round(self.clipped/self.samples,6) if self.samples else 0,
                    measurement_status='exploratory_not_human_validated')

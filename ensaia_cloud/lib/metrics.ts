import type { Metrics } from './types.js';
import {fillerCounts} from './fillers.js';
export class SpeechMeter {
  samples = 0; frames = 0; missingFrames = 0; clipped = 0; peak = 0;
  silenceSamples = 0; silenceRun = 0; longPauses = 0;
  recent: {squares:number; count:number; peak:number; clipped:number}[] = [];
  audio(pcm: Buffer) {
    let squares = 0, framePeak=0, frameClipped=0;
    for (let i = 0; i < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i); squares += v * v;
      this.peak = Math.max(this.peak, Math.abs(v)); framePeak=Math.max(framePeak,Math.abs(v));
      if (v === 32767 || v === -32768) {this.clipped++; frameClipped++;}
    }
    const count = pcm.length / 2;
    this.recent.push({squares,count,peak:framePeak,clipped:frameClipped});
    if(this.recent.length>250)this.recent.shift();
    const quiet = Math.sqrt(squares / count) / 32768 < .01;
    if (quiet) {
      this.silenceSamples += count;
      const old = this.silenceRun; this.silenceRun += count;
      if (old < 12800 && this.silenceRun >= 12800) this.longPauses++;
    } else this.silenceRun = 0;
    this.samples += count; this.frames++;
  }
  metrics(text: string): Metrics {
    const words = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
    const seconds = this.samples / 16000;
    const recentCount=this.recent.reduce((n,x)=>n+x.count,0);
    const recentRms=recentCount?Math.sqrt(this.recent.reduce((n,x)=>n+x.squares,0)/recentCount)/32768:0;
    const fillers = fillerCounts(text);
    let repetitions = 0;
    for (let i = 1; i < words.length; i++) if (words[i].toLocaleLowerCase('es') === words[i-1].toLocaleLowerCase('es')) repetitions++;
    return {seconds: +seconds.toFixed(2), words: words.length,
      wordsPerMinute: seconds ? Math.round(words.length * 60 / seconds) : 0,
      fillerCandidates: fillers.reduce((n,x) => n+x.count,0), fillers, repetitions,
      silenceSeconds: +(this.silenceSamples/16000).toFixed(2),
      silencePercent: this.samples ? Math.round(this.silenceSamples*100/this.samples) : 0,
      longPauses: this.longPauses, peak: this.peak, clippedSamples: this.clipped,
      recentRms:+recentRms.toFixed(5), recentPeak:Math.max(0,...this.recent.map(x=>x.peak)), recentClipped:this.recent.reduce((n,x)=>n+x.clipped,0),
      frames: this.frames, missingFrames: this.missingFrames};
  }
}
export function parseAudio(data: Buffer, sid: string, expected: number) {
  if (data.length !== 664 || data.subarray(0,16).toString('ascii') !== sid) throw new Error('Paquete de audio inválido');
  const seq = data.readUInt32LE(16), offset = data.readUInt32LE(20);
  if (seq !== expected || offset !== seq * 320) throw new Error(`Se perdió audio: se esperaba la trama ${expected}, llegó ${seq}`);
  return data.subarray(24);
}
export function wav(pcm: Buffer) {
  const h=Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(pcm.length+36,4); h.write('WAVEfmt ',8);
  h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(1,22);
  h.writeUInt32LE(16000,24); h.writeUInt32LE(32000,28); h.writeUInt16LE(2,32); h.writeUInt16LE(16,34);
  h.write('data',36); h.writeUInt32LE(pcm.length,40); return Buffer.concat([h,pcm]);
}
export function fallbackSummary(m: Metrics, transcript: string) {
  if (!transcript.trim()) return 'No se recibió suficiente transcripción para evaluar esta presentación. Revisa la captura de audio y vuelve a intentarlo.';
  const tips=[];
  if(m.fillerCandidates) tips.push('Revisa los candidatos a muletillas en su contexto; practica sustituir los innecesarios por pausas breves.');
  if(m.repetitions) tips.push('Escucha las repeticiones detectadas y comprueba cuáles aportan énfasis y cuáles puedes evitar.');
  if(m.wordsPerMinute>180) tips.push('Prueba un ritmo más pausado y separa las ideas principales.');
  if(m.wordsPerMinute<90) tips.push('Revisa el ritmo y las pausas largas; procura conectar las ideas con fluidez.');
  if(m.clippedSamples) tips.push('Aleja un poco el micrófono o reduce la ganancia para evitar saturación.');
  tips.push('Ensaya una introducción con propósito, dos o tres ideas centrales y una conclusión concreta.');
  return 'Orientaciones calculadas a partir de los indicadores disponibles; no son un resumen generado por IA.\n\n'+tips.map((x,i)=>`${i+1}. ${x}`).join('\n');
}

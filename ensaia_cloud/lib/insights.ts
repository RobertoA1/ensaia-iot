import type {SpeechEvent} from './types.js';

/** Las marcas son de llegada de transcripción, no alineación palabra por palabra. */
export function recentTranscriptionRate(events:SpeechEvent[], seconds:number):number|null {
  if(seconds<30)return null;
  const start=(seconds-30)*1000, end=seconds*1000;
  const text=events.filter(e=>e.kind==='transcript'&&typeof e.audioMs==='number'&&e.audioMs>=start&&e.audioMs<=end).map(e=>e.text).join(' ');
  const words=text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)?.length??0;
  return words>=20?Math.round(words*2):null;
}
export function candidateRate(candidates:number,words:number):number|null {
  return words>=30?Math.round(candidates*1000/words)/10:null;
}

export interface TrendEntry {id?:string; title?:string; createdAt?:string; status?:string; sourceComplete?:boolean; score?:number|null}
/** Las sesiones incompletas y sin evaluación se omiten del gráfico. */
export function historyTrend<T extends TrendEntry>(entries:T[]):T[] {
  return entries.filter(x=>x.status==='completed'&&x.sourceComplete===true&&typeof x.score==='number'&&Number.isFinite(x.score)&&x.score>=0&&x.score<=100&&Boolean(x.id)&&Boolean(x.createdAt)&&Number.isFinite(Date.parse(x.createdAt!)))
    .sort((a,b)=>Date.parse(a.createdAt!)-Date.parse(b.createdAt!));
}

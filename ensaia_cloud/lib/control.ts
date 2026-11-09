/** Palabra de cierre, duración sin límite y tiempos de interrupción. */
export const UNLIMITED_CAP_SECONDS=14400;
export const DEFAULT_END_WORD='ensaia finalizar';
/** Segundos que la plataforma mantiene abierta una conexión (Vercel: 300). 0 = sin tope de plataforma. */
export function platformLimitSeconds(){
  const n=Number(process.env.CONNECTION_MAX_SECONDS);
  return Number.isFinite(n)&&n>=120?Math.floor(n):process.env.VERCEL?300:0;
}
/** Margen para cerrar la IA, evaluar y archivar antes de que la plataforma corte la conexión. */
export const FINALIZE_RESERVE_SECONDS=60;
/** Tope de una toma que se reparte entre varias conexiones: el audio se reúne en memoria al final. */
export const HANDOVER_CAP_SECONDS=7200;
/** Duración máxima real de una toma «sin límite». `handover`: el dispositivo sabe continuar la toma al renovar la conexión. */
export function sessionCapSeconds(handover=false){
  const limit=platformLimitSeconds();
  if(!limit)return UNLIMITED_CAP_SECONDS;
  return handover?HANDOVER_CAP_SECONDS:limit-FINALIZE_RESERVE_SECONDS;
}
const tokens=(text:string)=>Array.from(text.matchAll(/[\p{L}\p{N}]+/gu),m=>({word:norm(m[0]),index:m.index}));
/** Minúsculas y sin tildes; los transcriptores suelen escribir «ensaya» por «ensaia». */
export function norm(word:string){const w=word.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('es');return w==='ensaya'?'ensaia':w;}
export function validEndWord(value:unknown):value is string{
  if(typeof value!=='string'||value.length>40)return false;
  const t=tokens(value);return t.length>=1&&t.length<=3&&t.every(x=>x.word.length>=3)&&value.replace(/[\p{L}\p{N}\s]/gu,'')==='';
}
/** Índice del inicio de la palabra de cierre en el texto, o -1. Busca la última coincidencia. */
export function findEndWord(text:string,endWord:string){
  const target=tokens(endWord).map(x=>x.word),words=tokens(text);if(!target.length)return -1;
  for(let i=words.length-target.length;i>=0;i--)if(target.every((w,k)=>words[i+k].word===w))return words[i].index;
  return -1;
}
/** Tiempo estimado de lectura en voz alta más margen de latencia y para que el usuario retome. */
export function holdFor(text:string){
  const words=text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(25000,1500+words*430)+3000;
}

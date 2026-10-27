/** Candidatos léxicos: por sí solos no determinan si una palabra fue muletilla. */
const patterns = [
  ['eh', /(?<![\p{L}\p{N}_])eh+(?![\p{L}\p{N}_])/giu],
  ['em', /(?<![\p{L}\p{N}_])em+(?![\p{L}\p{N}_])/giu],
  ['mmm', /(?<![\p{L}\p{N}_])m{2,}(?![\p{L}\p{N}_])/giu],
  ['este', /(?<![\p{L}\p{N}_])este(?![\p{L}\p{N}_])/giu],
  ['o sea', /(?<![\p{L}\p{N}_])o\s+sea(?![\p{L}\p{N}_])/giu],
  ['digamos', /(?<![\p{L}\p{N}_])digamos(?![\p{L}\p{N}_])/giu],
  ['pues', /(?<![\p{L}\p{N}_])pues(?![\p{L}\p{N}_])/giu],
  ['bueno', /(?<![\p{L}\p{N}_])bueno(?![\p{L}\p{N}_])/giu],
] as const;
export interface FillerOccurrence {token:string; start:number; end:number}
export function fillerOccurrences(text:string):FillerOccurrence[] {
  const matches:FillerOccurrence[]=[];
  for(const [token,pattern] of patterns){
    for(const m of text.matchAll(pattern))matches.push({token,start:m.index,end:m.index+m[0].length});
  }
  return matches.sort((a,b)=>a.start-b.start);
}
export function fillerCounts(text:string):{token:string;count:number}[] {
  const occurrences=fillerOccurrences(text);
  return patterns.map(([token])=>({token,count:occurrences.filter(x=>x.token===token).length})).filter(x=>x.count>0);
}
/** Fragmentos textuales sin interpretar; offsets se refieren a la transcripción. */
export function fillerContexts(text:string, limit=5, radius=55){
  if(limit<=0)return [];
  return fillerOccurrences(text).slice(-limit).map(m=>({
    token:m.token,before:text.slice(Math.max(0,m.start-radius),m.start),
    match:text.slice(m.start,m.end),after:text.slice(m.end,Math.min(text.length,m.end+radius)),
    leading:m.start>radius,trailing:m.end+radius<text.length,
  }));
}

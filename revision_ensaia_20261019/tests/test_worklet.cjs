const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../web/pcm-worklet.js'),'utf8');
for(const rate of [16000,44100,48000]){
 let Klass,frames=[];class Processor{constructor(){this.port={postMessage:p=>{if(p.pcm)frames.push(p.pcm);}};}}
 const sandbox={sampleRate:rate,AudioWorkletProcessor:Processor,registerProcessor:(name,C)=>{Klass=C;},ArrayBuffer,DataView,Math};
 vm.runInNewContext(code,sandbox);const processor=new Klass();
 for(let pos=0;pos<rate;pos+=128){let n=Math.min(128,rate-pos),input=new Float32Array(n).fill(.5);processor.process([[input]]);}
 processor.port.onmessage({data:'flush'});
 const samples=frames.reduce((sum,x)=>sum+x.byteLength/2,0);assert.equal(samples,16000);
 assert(frames.every(x=>x.byteLength<=640&&x.byteLength%2===0));
 assert.equal(new DataView(frames[0]).getInt16(0,true),16384);
 console.log(`Resampler ${rate} -> 16000: ${samples} samples OK`);
}

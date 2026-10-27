/* Remuestreo continuo por integración de área. Sin depender de que el navegador acepte 16 kHz. */
class PCM16000 extends AudioWorkletProcessor {
  constructor(){super();this.ratio=sampleRate/16000;this.remaining=this.ratio;this.sum=0;this.frame=[];
    this.port.onmessage=e=>{if(e.data==='flush'){this.emit();this.port.postMessage({flushed:true});}};}
  emit(){if(!this.frame.length)return;let buffer=new ArrayBuffer(this.frame.length*2),view=new DataView(buffer);
    this.frame.forEach((x,i)=>view.setInt16(i*2,Math.round(Math.max(-1,Math.min(1,x))*(x<0?32768:32767)),true));
    this.port.postMessage({pcm:buffer},[buffer]);this.frame=[];}
  process(inputs){let input=inputs[0]?.[0];if(!input)return true;
    for(let x of input){let left=1;while(left>1e-9){let step=Math.min(left,this.remaining);this.sum+=x*step;left-=step;this.remaining-=step;
      if(this.remaining<1e-9){this.frame.push(this.sum/this.ratio);this.sum=0;this.remaining=this.ratio;if(this.frame.length===320)this.emit();}}}
    return true;}
}
registerProcessor('pcm16000',PCM16000);

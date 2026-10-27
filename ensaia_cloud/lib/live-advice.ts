/** Agrupa fragmentos contiguos sin añadir espacios. GPT-Live no marca el final del turno. */
export class LiveAdviceBuffer {
 private text='';private timer?:ReturnType<typeof setTimeout>;
 constructor(private deliver:(text:string)=>void,private delay=3500){}
 push(fragment:string){
  if(!fragment)return;this.text+=fragment;
  if(this.timer)clearTimeout(this.timer);
  this.timer=setTimeout(()=>this.flush(),this.delay);this.timer.unref?.();
 }
 flush(){
  if(this.timer)clearTimeout(this.timer);this.timer=undefined;
  const text=this.text.trim();this.text='';
  if(!text||/^(?:m+[- ]?h+m*|ajá|aja|claro|sí|si|ok|okay|vale|bien|gracias|chatgpt|live)[.!?,\s]*$/iu.test(text))return;
  this.deliver(text);
 }
 discard(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.text='';}
}

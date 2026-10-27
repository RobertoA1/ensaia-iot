import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {validDeviceId,verifyDevice,seal,unseal} from './security.js';
import * as store from './store.js';

export class WhisperWorker {
  private id='';private lease=randomUUID();private sub?:Awaited<ReturnType<typeof store.subscriber>>;private timer?:ReturnType<typeof setInterval>;private closed=false;private last=Date.now();private born=Date.now();
  constructor(private socket:WebSocket){
    const deadline=setTimeout(()=>{if(!this.id)socket.close(1008,'Autenticación requerida');},8000);
    socket.on('message',raw=>void this.message(raw.toString()).catch(()=>socket.close(1011)));
    socket.on('close',()=>{clearTimeout(deadline);void this.cleanup();});
    socket.on('error',()=>void this.cleanup());
  }
  private async message(raw:string){
    if(raw.length>4096)return this.socket.close(1009);
    const msg=JSON.parse(raw);this.last=Date.now();
    if(!this.id){
      if(msg.type!=='worker.auth'||!validDeviceId(msg.deviceId)||typeof msg.secret!=='string'||!verifyDevice(msg.deviceId,msg.secret))return this.socket.close(1008);
      if(!await store.claimDevice('worker:'+msg.deviceId,this.lease))return this.socket.close(1008,'Trabajador ya conectado');
      this.id=msg.deviceId;this.sub=await store.subscriber();
      await this.sub.subscribe(store.key('whisper:audio:'+this.id),payload=>{
        if(this.socket.readyState!==WebSocket.OPEN)return;
        if(this.socket.bufferedAmount>2_000_000){this.socket.terminate();return;}
        this.socket.send(unseal(payload,'whisper:audio:'+this.id));
      });
      await this.presence();this.socket.send(JSON.stringify({type:'worker.ready'}));
      this.timer=setInterval(()=>void this.tick(),4000);return;
    }
    if(msg.type==='worker.ping')return;
    if(!['transcript','ended','error'].includes(msg.type)||typeof msg.sid!=='string'||!/^[a-f0-9]{16}$/.test(msg.sid))return;
    if(await store.activeSid(this.id)!==msg.sid)return;
    const data={type:msg.type,sid:msg.sid,text:typeof msg.text==='string'?msg.text.slice(0,2000):''};
    const r=await store.db();await r.publish(store.key('whisper:result:'+this.id),seal(JSON.stringify(data),'whisper:result:'+this.id));
  }
  private async presence(){const r=await store.db();await r.set(store.key('worker:presence:'+this.id),'1',{EX:16});}
  private async tick(){if(this.closed)return;try{if(Date.now()-this.last>15000||!await store.renewDevice('worker:'+this.id,this.lease)){this.socket.terminate();return;}await this.presence();if(Date.now()-this.born>55000&&!await store.activeSid(this.id))this.socket.close(1000,'Renovar conexión');}catch{this.socket.terminate();}}
  private async cleanup(){if(this.closed)return;this.closed=true;if(this.timer)clearInterval(this.timer);try{if(this.id&&await store.releaseDevice('worker:'+this.id,this.lease)){const r=await store.db();await r.del(store.key('worker:presence:'+this.id));}if(this.sub?.isOpen)await this.sub.close();}catch{console.error('worker_cleanup_failed');}}
}
export async function workerOnline(id:string){const r=await store.db();return Boolean(await r.get(store.key('worker:presence:'+id)));}

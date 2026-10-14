import {TOKEN_PROGRAM} from './config.mjs';
import {PublicKey} from '@solana/web3.js';
import {day,cleanError} from './util.mjs';

// Standard subscriptions are wake hints, never trading signals. Only filtered
// successful parsed history, signer ownership and trade guards may cause a fill.
export class WalletStream {
  constructor(c,leader,onActivity,onHealth=()=>{},WebSocketClass=globalThis.WebSocket){
    Object.assign(this,{c,leader:new PublicKey(leader).toBase58(),onActivity,onHealth,WebSocketClass});
    this.socket=null;this.stopped=true;this.ids=new Map();this.subscriptions=new Map();this.nextId=0;this.retries=0;
    this.usage={day:day(),bytes:0,connections:0};this.health={connected:false,ready:false,lastMessage:null,error:null};
    this.lastAmounts=new Map();this.retryTimer=null;this.heartbeatTimer=null;
  }
  credits(){return this.usage.connections+2*Math.ceil(this.usage.bytes/100000);}
  publish(extra={}){this.health={...this.health,...extra,bytes:this.usage.bytes,estimatedCredits:this.credits()};this.onHealth({...this.health});}
  start(){if(!this.stopped)return;this.stopped=false;this.connect();}
  stop(){this.stopped=true;clearTimeout(this.retryTimer);clearInterval(this.heartbeatTimer);const ws=this.socket;this.socket=null;this.health.ready=false;this.health.connected=false;if(ws)try{ws.close();}catch{};}
  send(method,params,kind){if(!this.socket||this.stopped)return;const id=++this.nextId;this.ids.set(id,kind);this.socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));}
  connect(){
    if(this.stopped)return;
    if(this.usage.day!==day()){this.usage={day:day(),bytes:0,connections:0};this.lastAmounts.clear();}
    if(!this.c.wsUrl||!this.WebSocketClass){this.publish({error:'A WSS RPC endpoint and supported Node WebSocket are required'});return;}
    if(this.credits()+1>this.c.streamCreditBudget||this.usage.bytes>=this.c.streamMaxBytes){this.publish({error:'Stream daily usage budget reached'});return;}
    this.ids.clear();this.subscriptions.clear();this.usage.connections++;this.publish({connected:false,ready:false,error:null});
    try{
      const ws=new this.WebSocketClass(this.c.wsUrl);this.socket=ws;
      ws.addEventListener('open',()=>{
        if(this.socket!==ws)return;this.retries=0;this.lastReceived=Date.now();this.publish({connected:true});
        this.send('accountSubscribe',[this.leader,{commitment:'processed',encoding:'base64'}],'native');
        this.send('programSubscribe',[TOKEN_PROGRAM,{commitment:'processed',encoding:'base64',filters:[{dataSize:165},{memcmp:{offset:32,bytes:this.leader}}]}],'tokens');
        this.send('slotSubscribe',[],'heartbeat');
        this.heartbeatTimer=setInterval(()=>{if(Date.now()-this.lastReceived>30000){this.publish({error:'Stream heartbeat timed out'});try{ws.close();}catch{}}},5000);
      });
      ws.addEventListener('message',event=>{if(this.socket===ws)this.receive(event.data);});
      ws.addEventListener('error',()=>{if(this.socket===ws)this.publish({error:'WebSocket connection error'});});
      ws.addEventListener('close',()=>{
        if(this.socket!==ws)return;this.socket=null;clearInterval(this.heartbeatTimer);this.publish({connected:false,ready:false});
        if(!this.stopped)this.retryTimer=setTimeout(()=>this.connect(),Math.min(30000,250*2**Math.min(this.retries++,7)));
      });
    }catch(error){this.publish({error:cleanError(error,this.c)});if(!this.stopped)this.retryTimer=setTimeout(()=>this.connect(),1000);}
  }
  receive(data){
    if(this.usage.day!==day())this.usage={day:day(),bytes:0,connections:0};
    if(typeof data!=='string'||Buffer.byteLength(data)>262144){this.publish({error:'Oversized or unsupported stream frame'});try{this.socket?.close();}catch{};return;}
    this.lastReceived=Date.now();this.usage.bytes+=Buffer.byteLength(data);
    if(this.credits()>this.c.streamCreditBudget||this.usage.bytes>this.c.streamMaxBytes){this.publish({ready:false,error:'Stream daily usage budget reached'});this.stop();return;}
    let msg;try{msg=JSON.parse(data);}catch{this.publish({error:'Malformed WebSocket JSON'});return;}
    if(msg.id!==undefined){
      const kind=this.ids.get(msg.id);if(!kind)return;this.ids.delete(msg.id);
      if(msg.error||!Number.isSafeInteger(msg.result)){this.publish({ready:false,error:'RPC rejected a standard WebSocket subscription'});try{this.socket?.close();}catch{};return;}
      this.subscriptions.set(msg.result,kind);
      this.publish({ready:[...this.subscriptions.values()].includes('native')&&[...this.subscriptions.values()].includes('tokens')});return;
    }
    const kind=this.subscriptions.get(msg.params?.subscription);if(!kind)return;
    this.publish({lastMessage:new Date().toISOString()});
    if(kind==='heartbeat'){
      const slot=msg.params?.result?.slot;
      if(Number.isSafeInteger(slot)&&slot>=0)this.publish({lastSlot:slot,lastSlotAt:Date.now()});
      return;
    }
    const result=msg.params?.result,slot=result?.context?.slot;
    if(!Number.isSafeInteger(slot)||slot<0)return;
    let key,value;
    if(kind==='native'){
      if(!Number.isSafeInteger(result.value?.lamports))return;key='native';value=String(result.value.lamports);
    }else{
      const account=result.value?.account,encoded=account?.data;
      if(account?.owner!==TOKEN_PROGRAM||!Array.isArray(encoded)||encoded[1]!=='base64')return;
      const bytes=Buffer.from(encoded[0],'base64');if(bytes.length!==165||new PublicKey(bytes.subarray(32,64)).toBase58()!==this.leader)return;
      key=result.value.pubkey;value=String(bytes.readBigUInt64LE(64));if(typeof key!=='string')return;
    }
    if(this.lastAmounts.get(key)===value)return;this.lastAmounts.set(key,value);
    if(this.lastAmounts.size>2000){this.publish({ready:false,error:'Too many changing leader token accounts'});this.stop();return;}
    this.onActivity({slot,kind,detectedAt:Date.now()});
  }
  static async probe(c,leader,timeoutMs=10000,WebSocketClass=globalThis.WebSocket){
    let stream;return new Promise(resolve=>{
      const finish=result=>{clearTimeout(timer);stream?.stop();resolve(result);};
      const timer=setTimeout(()=>finish({ready:false,error:'WebSocket subscription check timed out'}),timeoutMs);
      stream=new WalletStream(c,leader,()=>{},health=>{if(health.ready)finish(health);else if(health.error)finish(health);},WebSocketClass);stream.start();
    });
  }
}

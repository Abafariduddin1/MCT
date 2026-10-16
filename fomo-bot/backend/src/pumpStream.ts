import {EventEmitter} from 'node:events';
import path from 'node:path';
import WebSocket from 'ws';
import {QuotaTracker} from './quota.js';
import {finite,label,mintAddress,object,safeError} from './util.js';
import type {BackendConfig} from './config.js';
import type {PumpEvent} from './types.js';
export interface SocketPort {
  readyState:number;on(event:string,callback:(...args:unknown[])=>void):unknown;
  send(data:string):void;close():void;terminate():void;ping():void;
}
export interface PumpHealth {connected:boolean;running:boolean;lastMessage:number|null;error:string|null;meteredEvents:number;watchedTokens:number}
let activeStream:PumpStream|null=null;
export function parsePumpEvent(value:unknown,at=Date.now()):PumpEvent|null{
  const row=object(value),type=row.txType;
  const kind=type==='create'?'create':['migration','migrate'].includes(String(type))?'migration':['buy','sell'].includes(String(type))?'trade':null;
  if(!kind)return null;
  const mint=mintAddress(row.mint),cap=finite(row.marketCapSol),reported=finite(row.bondingCurveProgress??row.bondingPct);
  return{kind,mint,signature:typeof row.signature==='string'?row.signature.slice(0,120):null,
    name:typeof row.name==='string'?label(row.name,'?',40):null,symbol:typeof row.symbol==='string'?label(row.symbol,'?',16):null,
    marketCapSol:cap!==null&&cap>0?cap:null,bondingPct:kind==='migration'?100:reported!==null&&reported>=0&&reported<=100?reported:null,receivedAt:at};
}
export class PumpStream extends EventEmitter {
  readonly quota:QuotaTracker;private socket:SocketPort|null=null;private stopped=true;private retries=0;
  private retryTimer:ReturnType<typeof setTimeout>|null=null;private heartbeat:ReturnType<typeof setInterval>|null=null;
  private lastPong=0;private watched=new Set<string>();private signatures=new Set<string>();
  readonly health:PumpHealth={connected:false,running:false,lastMessage:null,error:null,meteredEvents:0,watchedTokens:0};
  constructor(private c:BackendConfig,private factory:(url:string)=>SocketPort=url=>new WebSocket(url,{maxPayload:65536,handshakeTimeout:10000}) as unknown as SocketPort){
    super();this.quota=new QuotaTracker(path.join(c.stateDir,'pump-metered-quota.json'),c.pumpEventsPerDay);
  }
  start():void{
    if(!this.stopped)return;if(!this.c.pumpEnabled)return;
    if(this.c.allowMeteredPump&&this.watched.size&&this.quota.snapshot().remaining<=0)throw Error('Daily request budget reached');
    if(activeStream&&activeStream!==this)throw Error('Use one PumpPortal stream per backend process');
    activeStream=this;this.stopped=false;this.health.running=true;this.connect();
  }
  stop():void{
    this.stopped=true;this.health.running=false;this.health.connected=false;
    if(this.retryTimer)clearTimeout(this.retryTimer);if(this.heartbeat)clearInterval(this.heartbeat);
    const socket=this.socket;this.socket=null;socket?.terminate();if(activeStream===this)activeStream=null;this.publish();
  }
  watchTokenTrades(mints:string[]):void{
    if(!this.c.allowMeteredPump)throw Error('Metered PumpPortal trade data is disabled');
    if(!this.c.pumpApiKey)throw Error('Metered trade data requires a PumpPortal API key');
    if(this.quota.snapshot().remaining<=0)throw Error('Daily request budget reached');
    const next=new Set(mints.map(mintAddress));if(next.size>this.c.pumpMaxWatched)throw Error('Pump trade watchlist exceeds its limit');
    const remove=[...this.watched].filter(mint=>!next.has(mint)),add=[...next].filter(mint=>!this.watched.has(mint));this.watched=next;
    if(this.health.connected){if(remove.length)this.send('unsubscribeTokenTrade',remove);if(add.length)this.send('subscribeTokenTrade',add);}
    this.health.watchedTokens=next.size;this.publish();
  }
  private send(method:string,keys?:string[]):void{if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(keys?{method,keys}:{method}));}
  private publish():void{this.health.meteredEvents=this.quota.snapshot().spent;this.emit('health',{...this.health});}
  private connect():void{
    if(this.stopped)return;
    const endpoint=new URL('wss://pumpportal.fun/api/data');if(this.c.pumpApiKey)endpoint.searchParams.set('api-key',this.c.pumpApiKey);
    try{
      const socket=this.factory(endpoint.href);this.socket=socket;
      socket.on('open',()=>{
        if(this.socket!==socket||this.stopped)return;this.health.connected=true;this.health.error=null;this.retries=0;this.lastPong=Date.now();
        this.send('subscribeNewToken');this.send('subscribeMigration');
        if(this.c.allowMeteredPump&&this.watched.size)this.send('subscribeTokenTrade',[...this.watched]);
        this.heartbeat=setInterval(()=>{if(Date.now()-this.lastPong>45000)socket.terminate();else socket.ping();},15000);this.publish();
      });
      socket.on('pong',()=>{if(this.socket===socket)this.lastPong=Date.now();});
      socket.on('message',(...args)=>{if(this.socket===socket)this.receive(args[0]);});
      socket.on('error',()=>{if(this.socket===socket){this.health.error='PumpPortal connection error';this.publish();}});
      socket.on('close',()=>{
        if(this.socket!==socket)return;this.socket=null;this.health.connected=false;if(this.heartbeat)clearInterval(this.heartbeat);this.publish();
        if(!this.stopped)this.retryTimer=setTimeout(()=>this.connect(),Math.min(30000,500*2**Math.min(this.retries++,6)));
      });
    }catch(error){this.health.error=safeError(error,[this.c.pumpApiKey]);this.publish();if(!this.stopped)this.retryTimer=setTimeout(()=>this.connect(),2000);}
  }
  private receive(raw:unknown):void{
    let paid=false;
    try{
      const data=typeof raw==='string'?Buffer.from(raw):Buffer.isBuffer(raw)?raw:null;
      if(!data||data.length>65536)throw Error('Unsupported or oversized PumpPortal message');
      const parsed=object(JSON.parse(data.toString('utf8')));this.health.lastMessage=Date.now();
      if(parsed.error||parsed.errors){this.health.error='PumpPortal rejected a subscription';this.stop();return;}
      paid=parsed.txType==='buy'||parsed.txType==='sell';
      if(paid){
        if(!this.c.allowMeteredPump){this.health.error='Unexpected metered data; stream stopped';this.stop();return;}
        this.quota.consume(1); // Count before validation/deduplication: duplicates can still be billed.
      }
      const event=parsePumpEvent(parsed);if(!event)return;
      if(event.kind==='trade'&&!this.watched.has(event.mint))return;
      const identity=event.signature?event.kind+':'+event.signature+':'+event.mint:null;
      if(identity&&this.signatures.has(identity))return;
      if(identity){this.signatures.add(identity);if(this.signatures.size>5000)this.signatures.delete(this.signatures.values().next().value!);}
      this.emit('token',event);this.publish();
    }catch(error){this.health.error=safeError(error,[this.c.pumpApiKey]);if(this.health.error==='Daily request budget reached')this.stop();else this.publish();}
    finally{if(paid&&this.c.allowMeteredPump&&this.quota.snapshot().remaining===0&&!this.stopped){this.health.error='Daily request budget reached';this.stop();}}
  }
}

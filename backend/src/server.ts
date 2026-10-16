import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {createHash,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {WebSocket,WebSocketServer} from 'ws';
import {object,mintAddress} from './util.js';
import type {BotEngine} from './botEngine.js';
import type {BackendConfig} from './config.js';
import type {FeedToken} from './types.js';
import {strategyPerformance} from './performance.js';

export interface ServerOptions {tlsCert?:string;tlsKey?:string;allowedOrigins?:string[]}
export function validateServerSettings(c:BackendConfig,options:ServerOptions={}):void {
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(c.appAccessToken)||new Set(c.appAccessToken).size<16)throw Error('APP_ACCESS_TOKEN must be a generated random token (run npm.cmd run token:create)');
  const local=['127.0.0.1','::1','localhost'].includes(c.host);
  if(!local&&(!options.tlsCert||!options.tlsKey))throw Error('A non-loopback controller binding requires TLS certificate and key files');
  if(Boolean(options.tlsCert)!==Boolean(options.tlsKey))throw Error('Both TLS certificate and key are required');
}
export class ControllerServer {
  readonly server:http.Server|https.Server;private ws:WebSocketServer;
  private heartbeat:ReturnType<typeof setInterval>|null=null;private broadcastTimer:ReturnType<typeof setTimeout>|null=null;private dirty=false;
  private stopped=false;private sequence=0;private alive=new WeakMap<WebSocket,boolean>();
  private lastEventSeq=0;
  private rates=new Map<string,{at:number;count:number}>();
  constructor(private c:BackendConfig,private engine:BotEngine,private feed:()=>FeedToken[]=()=>[],private options:ServerOptions={}){
    validateServerSettings(c,options);
    this.lastEventSeq=this.engine.ledger.read().seq;
    const handler=(req:IncomingMessage,res:ServerResponse)=>{void this.request(req,res).catch(()=>{if(!res.headersSent)this.json(res,500,{error:'Request failed'});else res.destroy();});};
    this.server=options.tlsCert?https.createServer({cert:fs.readFileSync(options.tlsCert),key:fs.readFileSync(options.tlsKey!),minVersion:'TLSv1.2',maxHeaderSize:8192},handler):http.createServer({maxHeaderSize:8192},handler);
    this.server.requestTimeout=10000;this.server.headersTimeout=5000;this.server.keepAliveTimeout=5000;this.server.maxHeadersCount=32;this.server.maxConnections=48;
    this.ws=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});
    this.server.on('upgrade',(req,socket,head)=>{
      if(req.url!=='/stream'||!this.authorized(req)||!this.rate(req)||this.ws.clients.size>=16){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
      this.ws.handleUpgrade(req,socket,head,client=>this.connection(client));
    });
    this.engine.on('state',this.markDirty);this.engine.on('health',this.markDirty);
  }
  private markDirty=()=>{this.dirty=true;if(this.broadcastTimer||this.stopped)return;this.broadcastTimer=setTimeout(()=>{this.broadcastTimer=null;if(this.dirty){this.dirty=false;this.broadcast();}},1000);};
  feedChanged():void{this.markDirty();}
  private authorized(req:IncomingMessage):boolean {
    if(this.stopped)return false;
    const origin=req.headers.origin;if(origin&&!(this.options.allowedOrigins??[]).includes(origin))return false;
    const host=req.headers.host??'';
    if(!/^[a-zA-Z0-9.:[\]-]+$/.test(host))return false;
    if(!this.options.tlsCert&&!['127.0.0.1','localhost','[::1]'].some(h=>host===h||host.startsWith(h+':')))return false;
    const header=req.headers.authorization;if(typeof header!=='string'||!header.startsWith('Bearer ')||header.length>140)return false;
    const digest=(s:string)=>createHash('sha256').update(s).digest();return timingSafeEqual(digest(header.slice(7)),digest(this.c.appAccessToken));
  }
  private rate(req:IncomingMessage):boolean {
    const key=req.socket.remoteAddress??'unknown',now=Date.now();
    for(const [k,r]of this.rates)if(now-r.at>60000)this.rates.delete(k);
    const current=this.rates.get(key)??{at:now,count:0};current.count++;this.rates.set(key,current);
    return this.rates.size<=200&&current.count<=120;
  }
  private json(res:ServerResponse,status:number,data:unknown):void {
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));
  }
  private async request(req:IncomingMessage,res:ServerResponse):Promise<void>{
    if(!this.authorized(req)){this.json(res,401,{error:'Authentication required'});return;}
    if(!this.rate(req)){this.json(res,429,{error:'Request rate exceeded'});return;}
    const url=new URL(req.url??'/','http://controller.invalid');
    if(url.search){this.json(res,400,{error:'Query strings are not accepted'});return;}
    if(req.method==='GET'&&url.pathname==='/v1/state'){this.json(res,200,this.envelope('PORTFOLIO_UPDATE',this.engine.snapshot()));return;}
    if(req.method==='GET'&&url.pathname==='/v1/feed'){this.json(res,200,this.envelope('FEED_UPDATE',{tokens:this.feedRows()}));return;}
    if(req.method==='GET'&&url.pathname==='/v1/performance'){this.json(res,200,this.envelope('STRATEGY_REPORT',strategyPerformance(this.engine.ledger.read())));return;}
    if(req.method==='GET'&&/^\/v1\/commands\/[A-Za-z0-9_-]{16,80}$/.test(url.pathname)){
      const command=this.engine.ledger.read().commands.find(c=>c.id===url.pathname.split('/').at(-1));this.json(res,command?200:404,command?this.envelope('COMMAND_ACK',command):{error:'Command not found'});return;
    }
    if(req.method==='POST'&&url.pathname==='/v1/command'){
      if(!req.headers['content-type']?.toLowerCase().startsWith('application/json')){this.json(res,415,{error:'Expected application/json'});return;}
      if(Number(req.headers['content-length'])>16384){this.json(res,413,{error:'Command too large'});return;}
      const parts:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>16384){this.json(res,413,{error:'Command too large'});req.destroy();return;}parts.push(Buffer.from(chunk));}
      try{const result=this.engine.submitCommand(JSON.parse(Buffer.concat(parts).toString('utf8')));this.json(res,202,this.envelope('COMMAND_ACK',result));}
      catch(error){this.json(res,400,{error:error instanceof Error?error.message:'Invalid command'});}return;
    }
    this.json(res,404,{error:'Unknown endpoint'});
  }
  private envelope(type:string,data:unknown):Record<string,unknown>{return {v:1,type,seq:++this.sequence,at:Date.now(),ledgerSeq:this.engine.ledger.read().seq,data};}
  private feedRows():unknown[]{return this.feed().slice(0,this.c.maxFeedTokens).map(({points:_,safety:__,...row})=>({...row,sparkline:row.sparkline.slice(-30)}));}
  private send(client:WebSocket,type:string,data:unknown):void{
    if(client.readyState!==WebSocket.OPEN)return;
    if(client.bufferedAmount>512000){client.close(1013,'Client is too slow');return;}
    const frame=JSON.stringify(this.envelope(type,data));if(Buffer.byteLength(frame)>1000000){client.close(1011,'Snapshot exceeds limit');return;}client.send(frame);
  }
  private connection(client:WebSocket):void{
    this.alive.set(client,true);let count=0,window=Date.now();
    client.on('pong',()=>this.alive.set(client,true));client.on('error',()=>client.terminate());
    client.on('message',(data,binary)=>{
      if(Date.now()-window>60000){window=Date.now();count=0;}
      if(binary||++count>60){client.close(1008,'Frame type or rate exceeded');return;}
      try{
        const row=object(JSON.parse(data.toString()));
        if(row.v===1&&row.type==='GET_SNAPSHOT'&&Object.keys(row).length===2){this.send(client,'PORTFOLIO_UPDATE',this.engine.snapshot());this.send(client,'FEED_UPDATE',{tokens:this.feedRows()});return;}
        if(row.v===1&&row.type==='GET_PERFORMANCE'&&Object.keys(row).length===2){this.send(client,'STRATEGY_REPORT',strategyPerformance(this.engine.ledger.read()));return;}
        if(row.v===1&&row.type==='GET_CHART'&&Object.keys(row).length===3){const mint=mintAddress(row.mint),token=this.feed().find(t=>t.mint===mint);this.send(client,'CHART_HISTORY',{mint,points:token?.points.slice(-512)??[],safety:token?.safety??null});return;}
        this.send(client,'COMMAND_ACK',this.engine.submitCommand(row));
      }catch(error){this.send(client,'COMMAND_ERROR',{error:error instanceof Error?error.message:'Invalid command'});}
    });
    this.send(client,'PORTFOLIO_UPDATE',this.engine.snapshot());this.send(client,'FEED_UPDATE',{tokens:this.feedRows()});
  }
  private broadcast():void{
    const snapshot=this.engine.snapshot(),feed={tokens:this.feedRows()};
    for(const client of this.ws.clients){this.send(client,'PORTFOLIO_UPDATE',snapshot);this.send(client,'FEED_UPDATE',feed);}
    const state=this.engine.ledger.read();
    for(const row of state.events.filter(e=>e.seq>this.lastEventSeq&&['TRADE_FILLED','TRADE_FAILED','TRADE_SUBMITTED'].includes(e.type)))for(const client of this.ws.clients)this.send(client,'TRADE_ALERT',{...row,mode:state.mode});
    this.lastEventSeq=state.seq;
  }
  async listen():Promise<number>{
    await new Promise<void>((resolve,reject)=>{const fail=(error:Error)=>reject(error);this.server.once('error',fail);this.server.listen(this.c.port,this.c.host,()=>{this.server.off('error',fail);resolve();});});
    this.heartbeat=setInterval(()=>{for(const client of this.ws.clients){if(!this.alive.get(client)){client.terminate();continue;}this.alive.set(client,false);client.ping();}},30000);
    const address=this.server.address();if(!address||typeof address==='string')throw Error('Controller has no listening address');return address.port;
  }
  async close():Promise<void>{
    this.stopped=true;this.engine.off('state',this.markDirty);this.engine.off('health',this.markDirty);
    if(this.heartbeat)clearInterval(this.heartbeat);if(this.broadcastTimer)clearTimeout(this.broadcastTimer);
    for(const client of this.ws.clients)client.terminate();
    await new Promise<void>(resolve=>this.ws.close(()=>resolve()));
    if(this.server.listening)await new Promise<void>(resolve=>{this.server.close(()=>resolve());this.server.closeAllConnections();});
  }
}

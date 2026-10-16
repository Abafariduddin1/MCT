import {EventEmitter} from 'node:events';
import {DexScreener} from './dexScreener.js';
import {PumpStream} from './pumpStream.js';
import {safeError} from './util.js';
import type {BackendConfig} from './config.js';
import type {FeedToken,MarketToken,PumpEvent} from './types.js';
import type {SafetyAggregator} from './rugcheck.js';
export class FeedService extends EventEmitter {
  private rows=new Map<string,FeedToken>();private pinned=new Set<string>();private cursor=0;
  private timer:ReturnType<typeof setTimeout>|null=null;private abort:AbortController|null=null;private stopping=true;private nextTrending=0;
  private safetyQueue=new Map<string,MarketToken>();private safetyWork:Promise<void>|null=null;
  constructor(private c:BackendConfig,readonly pump:PumpStream,private dex:DexScreener,private safety:SafetyAggregator,private solUsd:()=>number|null){
    super();pump.on('token',(event:PumpEvent)=>this.ingest(event));pump.on('health',health=>this.emit('health',{pump:health}));
  }
  pin(mints:string[]):void{this.pinned=new Set(mints);}
  snapshot():FeedToken[]{
    return[...this.rows.values()].map(row=>{
      const expired=Boolean(row.safety&&Date.now()>=row.safety.expiresAt),stale=Date.now()-row.observedAt>=15000||row.metadataAt===null||Date.now()-row.metadataAt>=15000;
      const ageFailed=row.createdAt!==null&&Date.now()-row.createdAt<this.c.core.ageHours*3600000;
      const liquidityFailed=row.liquidityUsd!==null&&row.liquidityUsd<this.c.core.liquidity;
      const marketPassed=!ageFailed&&!liquidityFailed&&row.createdAt!==null&&row.liquidityUsd!==null;
      return{...row,isSafe:Boolean(row.safety?.isSafe&&!expired&&!stale&&marketPassed),
        riskStatus:stale||expired?'unknown':ageFailed||liquidityFailed?'risky':row.riskStatus,
        riskReason:stale?'Market audit data is stale or missing':expired?'Safety checks expired':ageFailed?'Pool is younger than the trading policy':liquidityFailed?'Liquidity below the minimum':row.riskReason};
    });
  }
  start():void{if(!this.stopping)return;this.stopping=false;this.pump.start();this.schedule(0);}
  async stop():Promise<void>{this.stopping=true;if(this.timer)clearTimeout(this.timer);this.pump.stop();this.abort?.abort();this.safetyQueue.clear();while(this.abort)await new Promise(resolve=>setTimeout(resolve,5));await this.safetyWork;}
  private blank(mint:string):FeedToken{return{mint,name:mint.slice(0,6),symbol:'?',imageUri:null,mcapUsd:null,fdvUsd:null,change5mPct:null,liquidityUsd:null,volume5mUsd:null,
    createdAt:null,observedAt:Date.now(),source:'pumpportal',estimated:true,bondingPct:null,migrated:false,isSafe:false,riskStatus:'unknown',riskReason:'Not evaluated',sparkline:[],points:[],safety:null,metadataAt:null};}
  private trim():void{
    if(this.rows.size<=this.c.maxFeedTokens)return;
    for(const [mint]of this.rows){if(!this.pinned.has(mint))this.rows.delete(mint);if(this.rows.size<=this.c.maxFeedTokens)break;}
  }
  ingest(event:PumpEvent):void{
    const row=this.rows.get(event.mint)??this.blank(event.mint),price=this.solUsd();
    if(event.name)row.name=event.name;if(event.symbol)row.symbol=event.symbol;
    if(event.kind==='create'&&!row.createdAt)row.createdAt=event.receivedAt;
    if(event.kind==='migration'){row.migrated=true;row.bondingPct=100;}
    else if(event.bondingPct!==null)row.bondingPct=event.bondingPct;
    if(event.marketCapSol!==null&&price!==null&&price>0){row.mcapUsd=event.marketCapSol*price;row.estimated=true;row.source='pumpportal';row.observedAt=event.receivedAt;this.point(row,event.receivedAt);}
    this.rows.set(event.mint,row);this.trim();this.emit('update',this.snapshot());
  }
  private point(row:FeedToken,at=Date.now()):void{
    if(row.mcapUsd===null)return;const last=row.points.at(-1);
    if(!last||at-last.at>=10000)row.points.push({at,mcapUsd:row.mcapUsd});
    row.points=row.points.slice(-512);row.sparkline=row.points.slice(-30).map(point=>point.mcapUsd);
  }
  private schedule(ms:number):void{if(!this.stopping)this.timer=setTimeout(()=>{void this.refresh();},ms);}
  private async refresh():Promise<void>{
    if(this.stopping||this.abort)return;this.abort=new AbortController();
    try{
      if(Date.now()>=this.nextTrending){
        this.nextTrending=Date.now()+60000;
        for(const mint of await this.dex.trending(this.abort.signal))if(!this.rows.has(mint))this.rows.set(mint,this.blank(mint));this.trim();
      }
      const mints=[...this.rows.keys()],rotating=mints.slice(this.cursor,this.cursor+30);this.cursor=this.cursor+30>=mints.length?0:this.cursor+30;
      const selected=[...new Set([...this.pinned,...rotating])].slice(0,60);
      const markets=await this.dex.tokens(selected,this.abort.signal);
      for(const market of markets){
        if(this.stopping)break;const row=this.rows.get(market.mint)??this.blank(market.mint);
        Object.assign(row,market);row.metadataAt=market.observedAt;this.point(row,market.observedAt);this.rows.set(row.mint,row);
        this.safetyQueue.set(row.mint,market);this.launchSafety();
      }
      this.trim();this.emit('update',this.snapshot());
    }catch(error){if(!this.stopping)this.emit('health',{error:safeError(error,[this.c.core.rpc,this.c.core.apiKey,this.c.pumpApiKey])});}
    finally{this.abort=null;this.schedule(this.c.dexRefreshMs);}
  }
  private launchSafety():void{
    if(this.safetyWork||this.stopping)return;
    this.safetyWork=this.checkQueuedSafety().finally(()=>{this.safetyWork=null;});
  }
  private async checkQueuedSafety():Promise<void>{
    while(!this.stopping&&this.safetyQueue.size){
      const mint=[...this.pinned].find(key=>this.safetyQueue.has(key))??this.safetyQueue.keys().next().value!;
      const market=this.safetyQueue.get(mint)!;this.safetyQueue.delete(mint);
      try{
        const report=await this.safety.inspect(mint,market),row=this.rows.get(mint);
        if(!this.stopping&&row){row.safety=report;row.riskStatus=report.status;row.riskReason=report.riskReason;this.emit('update',this.snapshot());}
      }catch(error){if(!this.stopping)this.emit('health',{error:safeError(error,[this.c.core.rpc,this.c.core.apiKey,this.c.pumpApiKey])});}
    }
  }
}

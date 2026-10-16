import {BotEngine,limit} from './botEngine.js';
import {safeError,day} from './util.js';
import {USDC,SOL} from './constants.js';
import {amount,unresolved} from './ledger.js';
import type {BackendConfig} from './config.js';
import type {HistoryPort,HistoryTransaction,StreamPort,StreamHealth} from './controllerCore.js';
import type {CopyEvent,RuntimePort} from './controllerTypes.js';

/** Reuses the retained finalized history contract and verified swap decoder.
 * Source claims and queued leader sales are committed atomically. */
export class CopyController {
  private stopped=true;private timer:ReturnType<typeof setTimeout>|null=null;private work:Promise<void>|null=null;
  private next=0;private hintAt=0;private retryUntil=0;private stream:StreamPort|null=null;private lastHealthWrite=0;
  constructor(private c:BackendConfig,private engine:BotEngine,private history:HistoryPort,private decode:(tx:HistoryTransaction,leader:string)=>CopyEvent|null,private port:Pick<RuntimePort,'reference'>){}
  attachStream(stream:StreamPort):void{this.stream=stream;const usage=this.engine.ledger.read().copy.streamUsage;if(usage.day===day())stream.usage={...usage};}
  activity(hint:{slot:number;detectedAt:number}):void{this.hintAt=hint.detectedAt;this.next=Math.min(this.next,Date.now()+limit(this.c,'copyFetchCooldownMs'));this.retryUntil=Date.now()+limit(this.c,'copyMaxAgeMs');}
  health(health:StreamHealth):void {
    const old=this.engine.ledger.read().copy;
    if(Date.now()-this.lastHealthWrite<5000&&old.streamReady===health.ready)return;this.lastHealthWrite=Date.now();
    this.engine.ledger.transact(s=>{
      s.copy.streamReady=health.ready;s.copy.streamGapAt=health.ready?null:s.copy.streamGapAt??Date.now();
      if(this.stream)s.copy.streamUsage={...this.stream.usage};
    });
    if(!health.ready&&old.streamGapAt&&Date.now()-old.streamGapAt>5000)this.block('Copy stream unavailable; reconciling leader history');
  }
  start():void{if(!this.stopped)return;this.stopped=false;this.stream?.start();this.schedule();}
  private schedule():void{if(this.stopped)return;this.timer=setTimeout(()=>{void this.tick().finally(()=>this.schedule());},500);}
  async stop():Promise<void>{this.stopped=true;if(this.timer)clearTimeout(this.timer);this.stream?.stop();await this.work;}
  private block(reason:string):void {
    this.engine.ledger.transact(s=>{s.copy.blocked=reason;for(const p of s.positions.filter(p=>p.bucket==='copy'))p.exitReason??='Copy tracking unavailable';});
  }
  async tick():Promise<void>{
    if(this.work||Date.now()<this.next)return;
    const s=this.engine.ledger.read();if(!s.copy.leader)return;
    if(!s.settings.copyEnabled&&!s.positions.some(p=>p.bucket==='copy')&&!s.orders.some(o=>unresolved(o)&&o.bucket==='copy'))return;
    if(this.c.core.wsEnabled===true&&s.copy.streamGapAt&&Date.now()-s.copy.streamGapAt>5000)this.block('Copy stream unavailable; entries blocked');
    this.next=Date.now()+(Date.now()<this.retryUntil?limit(this.c,'copyIndexWaitMs'):limit(this.c,'copyPollMs'));
    this.work=this.poll().catch(error=>this.block(safeError(error,[this.c.core.rpc,this.c.core.apiKey]))).finally(()=>{this.work=null;});await this.work;
  }
  async poll():Promise<void>{
    let s=this.engine.ledger.read(),leader=s.copy.leader;if(!leader)return;
    if(s.copy.baselineSlot===null){
      const slot=await this.history.slot();if(!Number.isSafeInteger(slot)||slot<0)throw Error('Invalid copy baseline');
      this.engine.ledger.transact(next=>{next.copy.baselineSlot=slot+1;next.copy.nextSlot=slot+1;next.copy.lastPollAt=Date.now();});return;
    }
    if(!s.copy.scan){
      const to=await this.history.slot(),from=Math.max(s.copy.baselineSlot,s.copy.nextSlot!-limit(this.c,'copyOverlap'));
      if(!Number.isSafeInteger(to)||to<0)throw Error('Invalid finalized history slot');
      if(to<from){this.engine.ledger.transact(next=>{next.copy.lastPollAt=Date.now();});return;}
      this.engine.ledger.transact(next=>{next.copy.scan={fromSlot:from,toSlot:to,token:null,at:Date.now()};});
    }
    const buys:Array<{event:CopyEvent;signature:string}>=[],sales=new Map<string,number>();
    for(let page=0;page<limit(this.c,'copyPages');page++){
      s=this.engine.ledger.read();const scan=s.copy.scan;if(!scan)break;
      this.engine.ledger.transact(next=>{if(next.copy.creditDay!==day()){next.copy.creditDay=day();next.copy.credits=0;}
        if(next.copy.credits+10>limit(this.c,'copyCreditBudget'))throw Error('Copy history daily budget exhausted');next.copy.credits+=10;});
      const response=await this.history.page(leader,scan.fromSlot,scan.toSlot,scan.token);
      if(!Array.isArray(response.data)||response.data.length>limit(this.c,'copyPage')||response.data.some(tx=>!Number.isSafeInteger(tx.slot)||tx.slot<scan.fromSlot||tx.slot>scan.toSlot))throw Error('Invalid history coverage');
      for(const tx of [...response.data].sort((a,b)=>a.slot-b.slot||(a.transactionIndex??0)-(b.transactionIndex??0))){
        const signature=tx.transaction?.signatures?.[0];if(typeof signature!=='string')throw Error('History signature missing');
        const eventData=this.decode(tx,leader);if(!this.engine.claimCopy(eventData,signature,tx.slot))continue;
        if(eventData?.side==='sell')sales.set(eventData.mint,eventData.at);
        if(eventData?.side==='buy'&&buys.length<limit(this.c,'copyBatch'))buys.push({event:eventData,signature});
      }
      const token=response.paginationToken??null;
      if(token!==null&&(typeof token!=='string'||token===scan.token||token.length>2048))throw Error('History pagination did not advance');
      this.engine.ledger.transact(next=>{
        if(token)next.copy.scan!.token=token;
        else{next.copy.nextSlot=scan.toSlot+1;next.copy.scan=null;
          const earliest=Math.max(next.copy.baselineSlot!,next.copy.nextSlot-limit(this.c,'copyOverlap'))-4;
          // Keep signatures backing an unresolved order, even outside overlap.
          const keep=new Set(next.orders.filter(unresolved).flatMap(o=>o.signal?.sourceSignature?[o.signal.sourceSignature]:[]));
          for(const [sig,slot]of Object.entries(next.copy.claims))if(slot<earliest&&!keep.has(sig))delete next.copy.claims[sig];
        }
        next.copy.lastPollAt=Date.now();
      });
      if(!token)break;
    }
    s=this.engine.ledger.read();
    if(s.copy.scan){if(Date.now()-s.copy.scan.at>limit(this.c,'copyMaxAgeMs'))this.block('Leader history backlog is incomplete');this.next=Date.now()+limit(this.c,'copyIndexWaitMs');return;}
    if(this.c.core.wsEnabled===true&&!s.copy.streamReady)return;
    this.engine.ledger.transact(next=>{next.copy.blocked=null;});
    // A sale already observed in this scan supersedes its older buy signal.
    for(const {event:ev,signature}of buys){
      if((sales.get(ev.mint)??0)>=ev.at||Date.now()>ev.at+limit(this.c,'copyMaxAgeMs')||ev.at>Date.now()+10000)continue;
      if(ev.baseMint!==SOL&&ev.baseMint!==USDC)continue;
      const ref=await this.port.reference(),base=Number(amount(ev.baseAmount))/(ev.baseMint===USDC?1e6:1e9)*(ev.baseMint===USDC?1:ref.solUsdc),units=Number(amount(ev.tokenAmount))/10**ev.decimals;
      const ceiling=base/units*(1+limit(this.c,'copyWorse')/100);if(!Number.isFinite(ceiling)||ceiling<=0)continue;
      // Engine serializes finances; do not hold up polling later leader sales.
      void this.engine.autoBuy(ev.mint,{bucket:'copy',strategy:'copy',at:this.hintAt||Date.now(),expiresAt:ev.at+limit(this.c,'copyMaxAgeMs'),maxUnitUsdc:ceiling,sourceSignature:signature}).catch(()=>{});
    }
  }
}

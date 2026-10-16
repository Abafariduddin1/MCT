import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Ledger,amount,signed,equity,event,reportingDay,unresolved,applySettlement} from './ledger.js';
import {commandHash,parseCommand} from './protocol.js';
import {rawAmount,safeError,solToLamports} from './util.js';
import {solCostMicroUsdc} from './priceReference.js';
import {SOL,USDC} from './constants.js';
import type {BackendConfig} from './config.js';
import type {PortfolioGate,SwapIntent,ValidatedSwap} from './types.js';
import type {SolReference} from './priceReference.js';
import type {RuntimePort,LedgerState,Command,CommandRecord,Order,Signal,CandidateEvidence,Quote,Protection,Preset,CopyEvent,Bucket} from './controllerTypes.js';

export function limit(c:BackendConfig,name:string):number {const value=c.core[name];if(typeof value!=='number'||!Number.isFinite(value))throw Error('Missing numeric controller setting: '+name);return value;}
const max=(a:bigint,b:bigint)=>a>b?a:b;
const min=(...a:bigint[])=>a.reduce((x,y)=>x<y?x:y);
function haircut(raw:string,bps:number):bigint{return amount(raw)*BigInt(10000-bps)/10000n;}
function fresh(at:number,maxAge=15000):boolean{return Number.isFinite(at)&&at<=Date.now()+1000&&Date.now()-at<=maxAge;}
export function protection(c:BackendConfig,preset:Preset,bucket:Bucket):Protection {
  return {stop:limit(c,'stop'),take:limit(c,'take'),trailStart:limit(c,'trailStart'),trail:limit(c,'trail'),holdMs:limit(c,bucket==='copy'?'copyHoldMs':'holdMs'),partialBps:preset==='Safe'?10000:preset==='Fast'?5000:7500};
}
interface Authorization {orderId:string; intent:SwapIntent; evidence:CandidateEvidence|null; reverse:Quote|null; reference:SolReference; signal:Signal|null}

export class BotEngine extends EventEmitter implements PortfolioGate {
  private port:RuntimePort|null=null;private screen:((e:CandidateEvidence)=>string|null)|null=null;
  private authorization:Authorization|null=null;private prepared:ValidatedSwap|null=null;
  private financial:Promise<void>|null=null;private monitorWork:Promise<void>|null=null;private timer:ReturnType<typeof setTimeout>|null=null;
  private markWork:Promise<void>|null=null;
  private stopping=true;private markCursor=0;private nextMark=0;private nextReconcile=0;private retries=new Map<string,number>();
  private pendingBuy:{mint:string;bucket:Bucket}|null=null;
  readonly health:{lastTick:number|null;lastError:string|null;lastObservation:number|null;monitorMs:number}={lastTick:null,lastError:null,lastObservation:null,monitorMs:500};
  constructor(readonly c:BackendConfig,readonly ledger:Ledger){super();
    if(c.liveBase!=='SOL'||c.core.paperBase!=='SOL')throw Error('The Step 2 controller uses SOL accounting; retain the standalone bot for USDC');
  }
  attach(port:RuntimePort,screen:(e:CandidateEvidence)=>string|null):void{if(this.port)throw Error('Controller port already attached');this.port=port;this.screen=screen;}
  private runtime():RuntimePort{if(!this.port)throw Error('Controller services are not attached');return this.port;}
  private report(error:unknown):void{this.health.lastError=safeError(error,[this.c.core.rpc,this.c.core.apiKey,this.c.walletEncryptionKey,this.c.appAccessToken]);this.emit('health',this.health);}
  private changed():void{this.emit('state');}
  recover():void {
    this.ledger.transact(s=>{
      for(const o of s.orders.filter(unresolved)){
        if(!o.signature){o.stage='rejected';o.reason='Interrupted before a signed intent was saved';}
        else if(!o.applied){o.stage='unknown';o.reason='Restart: reconcile the saved signature; never resend';}
        if(o.commandId){const cmd=s.commands.find(c=>c.id===o.commandId)!;cmd.stage=o.stage;cmd.reason=o.reason;}
      }
      for(const cmd of s.commands)if(cmd.stage==='received'&&!cmd.orderId){cmd.stage='rejected';cmd.reason='Interrupted before preparation; no transaction was submitted';}
      s.copy.streamReady=false;s.copy.streamGapAt=Date.now();
      // No saved momentum signal is treated as fresh after a restart.
      event(s,'RECOVERED',{pending:s.orders.filter(unresolved).map(o=>o.id)});
    });
  }
  start():void {if(!this.stopping)return;this.stopping=false;this.schedule();}
  private schedule():void{if(this.stopping)return;this.timer=setTimeout(()=>{void this.tick().catch(e=>this.report(e)).finally(()=>this.schedule());},500);}
  async stop():Promise<void>{this.stopping=true;if(this.timer)clearTimeout(this.timer);await Promise.allSettled([this.monitorWork,this.financial,this.markWork].filter(Boolean) as Promise<void>[]);}
  async idle():Promise<void>{await this.financial;}
  private reserve(c:BackendConfig=this.c):bigint{return BigInt(Math.ceil(c.core.reserveSol*1e9));}
  private overhead(mint:string):bigint {
    const s=this.ledger.read();return s.mode==='paper'?BigInt(limit(this.c,'paperNetwork')+(s.paperTokenAccounts.includes(mint)?0:limit(this.c,'paperRent'))):BigInt(this.c.core.networkCap+this.c.core.rentCap);
  }
  private updateRisk(s:LedgerState,ref:SolReference):void {
    const today=reportingDay(Date.now(),s.timezone),changed=s.day!==today;
    // Unknown/stale marks block entry, but are not fabricated zero-value losses.
    if(s.positions.some(p=>p.markLamports===null||p.markAt===null||!fresh(p.markAt,30000)))return;
    for(const key of ['global','normal','copy','reserve'] as const){
      const r=key==='global'?s.risk:s.buckets[key],value=equity(s,key==='global'?undefined:key);
      if(changed){r.dayStartLamports=value.toString();r.entries=0;}
      r.highWaterLamports=max(amount(r.highWaterLamports),value).toString();
      if(key==='reserve')continue;
      const active=s.buckets.normal.pct+s.buckets.copy.pct,fraction=key==='global'?1:(active?s.buckets[key].pct/active:0);
      if(fraction===0)continue;
      const draw=max(0n,amount(r.highWaterLamports)-value),daily=max(0n,amount(r.dayStartLamports)-value);
      if(solCostMicroUsdc(draw,ref)>=BigInt(Math.floor(limit(this.c,'totalLoss')*fraction*1e6)))r.halt??='Total drawdown limit reached';
      if(solCostMicroUsdc(daily,ref)>=BigInt(Math.floor(limit(this.c,'dailyLoss')*fraction*1e6)))r.halt??='Daily loss limit reached';
    }
    s.day=today;
  }
  private entryBlock(s:LedgerState,bucket:Bucket,mint:string,ownId?:string):string|null {
    if(s.settings.panic||s.settings.paused||s.risk.halt||s.buckets[bucket].halt)return s.risk.halt||s.buckets[bucket].halt||'New entries are paused';
    if(s.orders.some(o=>unresolved(o)&&o.id!==ownId))return 'An existing transaction must be reconciled first';
    if(s.positions.some(p=>p.mint===mint))return 'Already holding this token';
    if((s.cooldowns[mint]??0)>Date.now())return 'Token cooldown';
    if(s.positions.length>=limit(this.c,'maxOpen')||s.positions.filter(p=>p.bucket===bucket).length>=limit(this.c,'maxOpenPerBucket'))return 'Open-position limit';
    if(s.risk.entries>=limit(this.c,'maxEntries'))return 'Daily entry limit';
    if(s.positions.some(p=>p.markAt===null||!fresh(p.markAt,30000)||p.markLamports===null))return 'An owned position has no recent exit valuation';
    if(bucket==='copy'&&(s.copy.blocked||!s.copy.lastPollAt||!fresh(s.copy.lastPollAt,Math.max(limit(this.c,'copyPollMs')*2,15000))))return s.copy.blocked||'Copy history is not current';
    if(bucket==='copy'&&this.c.core.wsEnabled===true&&!s.copy.streamReady)return 'Copy stream is unavailable';
    return null;
  }
  private allowedSize(s:LedgerState,bucket:Bucket,ref:SolReference,mint:string):bigint {
    const overhead=this.overhead(mint),micro=(n:number)=>BigInt(Math.max(0,Math.floor(n*1e6)));
    // Integer conversion rounds the spend down; exposure conversions round up.
    const native=(value:bigint)=>value*1000000000000n/BigInt(Math.ceil(ref.solUsdc*1e9));
    const exposure=s.positions.reduce((sum,p)=>sum+solCostMicroUsdc(amount(p.costLamports),ref),0n);
    const b=s.buckets[bucket],active=s.buckets.normal.pct+s.buckets.copy.pct,fraction=active?b.pct/active:0;
    // Leave each sleeve enough cash to pay for one exit per owned position,
    // including the candidate. The idle allocation is not borrowed for gas.
    const exitFee=BigInt(s.mode==='paper'?limit(this.c,'paperNetwork'):this.c.core.networkCap);
    const bucketExitReserve=exitFee*BigInt(s.positions.filter(p=>p.bucket===bucket).length+1);
    const globalExitReserve=exitFee*BigInt(s.positions.length+1);
    let lossMicro=micro(limit(this.c,'risk'));
    for(const [r,value,part]of [[s.risk,equity(s),1],[b,equity(s,bucket),fraction]] as const){
      const daily=micro(limit(this.c,'dailyLoss')*part)-solCostMicroUsdc(max(0n,amount(r.dayStartLamports)-value),ref);
      const total=micro(limit(this.c,'totalLoss')*part)-solCostMicroUsdc(max(0n,amount(r.highWaterLamports)-value),ref);
      lossMicro=min(lossMicro,max(0n,daily),max(0n,total));
    }
    const riskSize=lossMicro*10000n/BigInt(Math.ceil((limit(this.c,'stop')+limit(this.c,'roundTrip'))*100));
    const cap=min(native(micro(this.c.core.maxPosition)),native(max(0n,micro(this.c.core.maxExposure)-exposure)),native(riskSize),max(0n,amount(b.cashLamports)-bucketExitReserve),max(0n,amount(s.cashLamports)-this.reserve()-globalExitReserve));
    return min(this.c.maxBuyLamports,max(0n,cap-overhead));
  }
  async assertAllowed(intent:SwapIntent):Promise<void> {
    this.ledger.assertOwner();const auth=this.authorization,s=this.ledger.read();
    if(!auth||intent!==auth.intent||auth.intent.quote!==intent.quote)throw Error('No active controller policy authorization');
    const o=s.orders.find(row=>row.id===auth.orderId);if(!o||o.applied||o.mint!==intent.mint||o.amountRaw!==intent.amountRaw||o.side!==intent.side||s.mode!==this.c.core.mode)throw Error('Intent does not match the controller ledger');
    if(intent.expiresAt!==null&&Date.now()>intent.expiresAt)throw Error('Authorized intent expired');
    if(s.orders.some(row=>unresolved(row)&&row.id!==o.id))throw Error('Conflicting financial intent');
    if(intent.side==='sell'){
      const p=s.positions.find(p=>p.mint===intent.mint&&p.bucket===o.bucket);
      if(!p||amount(intent.amountRaw)<=0n||amount(intent.amountRaw)>amount(p.quantityRaw)||p.decimals!==intent.decimals)throw Error('Sale exceeds the actual managed holding');
      const exitFee=BigInt(s.mode==='paper'?limit(this.c,'paperNetwork'):this.c.core.networkCap);
      if(amount(s.buckets[o.bucket].cashLamports)<exitFee||amount(s.cashLamports)<this.reserve()+exitFee)throw Error('Insufficient allocated SOL for exit fees and reserve');
      const remaining=amount(intent.amountRaw)<amount(p.quantityRaw)?1:0;
      const minimum=amount((intent.quote as Quote).otherAmountThreshold);
      const localRemaining=s.positions.filter(row=>row.bucket===o.bucket).length-1+remaining;
      if(amount(s.buckets[o.bucket].cashLamports)+minimum-exitFee<exitFee*BigInt(localRemaining)||amount(s.cashLamports)+minimum-exitFee<this.reserve()+exitFee*BigInt(s.positions.length-1+remaining))throw Error('Sale would consume fee cash required for the remaining positions');
      return;
    }
    const ref=auth.reference,e=auth.evidence,signal=auth.signal,q=intent.quote as Quote,reverse=auth.reverse;
    if(!e||!signal||!reverse||!fresh(e.at)||!fresh(e.market.observedAt)||!fresh(ref.at)||!fresh(q.receivedAt)||!fresh(reverse.receivedAt)||signal.expiresAt<Date.now())throw Error('Entry evidence, signal or quote is stale');
    if(e.token.id!==intent.mint||e.token.decimals!==intent.decimals||!e.safety.isSafe||e.safety.mint!==intent.mint||e.safety.expiresAt<=Date.now()||e.safety.checks.length!==8||e.safety.checks.some(c=>c.status!=='pass'))throw Error('Complete current safety checks are required');
    const invalid=this.screen?.(e);if(invalid||!this.screen)throw Error(invalid||'Token policy is unavailable');
    const blocked=this.entryBlock(s,o.bucket,o.mint,o.id);if(blocked)throw Error(blocked);
    if(signal.strategy!=='manual'&&(!s.settings.autoPilot||!(o.bucket==='normal'?s.settings.normalEnabled:s.settings.copyEnabled)))throw Error('Automatic entries disabled');
    if(o.bucket==='copy'&&!signal.sourceSignature)throw Error('Copy entry requires a claimed source swap');
    if(o.bucket==='copy'&&!Object.hasOwn(s.copy.claims,signal.sourceSignature!))throw Error('Copy source was not durably claimed');
    if(amount(o.amountRaw)>this.allowedSize(s,o.bucket,ref,o.mint))throw Error('Entry exceeds its all-in cash, allocation, exposure or risk limit');
    if(Math.abs(q.priceImpact)>this.c.core.impact||q.inAmount!==o.amountRaw||q.inputMint!==SOL||q.outputMint!==o.mint)throw Error('Entry quote or price impact mismatch');
    const held=s.mode==='paper'?haircut(q.outAmount,limit(this.c,'paperSlip')):amount(q.otherAmountThreshold);
    if(reverse.inAmount!==held.toString()||reverse.inputMint!==o.mint||reverse.outputMint!==SOL)throw Error('Reverse quote does not match our position size');
    const full=amount(o.amountRaw)+this.overhead(o.mint),exitFee=BigInt(s.mode==='paper'?limit(this.c,'paperNetwork'):this.c.core.networkCap);
    const proceeds=s.mode==='paper'?haircut(reverse.outAmount,limit(this.c,'paperSlip')):amount(reverse.otherAmountThreshold);
    const drag=Number(full-(proceeds-exitFee))/Number(full)*100;
    if(drag>limit(this.c,'roundTrip')||(drag>0&&limit(this.c,'take')/drag<limit(this.c,'minRewardCost')))throw Error('Estimated round-trip costs exceed policy');
    const unit=Number(amount(o.amountRaw))/1e9*ref.solUsdc/(Number(held)/10**intent.decimals);
    if(signal.maxUnitUsdc!==null&&(!Number.isFinite(unit)||unit>signal.maxUnitUsdc))throw Error('Quote exceeds the permitted source price');
  }
  async assertPersisted(signature:string):Promise<void> {
    this.ledger.assertOwner();const s=this.ledger.read(),o=s.orders.find(o=>o.signature===signature),a=this.authorization;
    if(!o||!a||!this.prepared||o.id!==a.orderId||o.stage!=='prepared'||this.prepared.signature!==signature||!o.nativeAudit||o.applied)throw Error('Exact signed intent has not been durably saved');
    if(JSON.stringify(o.nativeAudit)!==JSON.stringify(this.runtime().audit(this.prepared)))throw Error('Persisted native audit differs from preparation');
    await this.assertAllowed(a.intent);
  }
  submitCommand(value:unknown):CommandRecord {
    const command=parseCommand(value),hash=commandHash(command),s=this.ledger.read(),old=s.commands.find(row=>row.id===command.id);
    if(old){if(old.hash!==hash)throw Error('Command id was already used with different content');return old;}
    if(s.commands.length>=10000)throw Error('Command journal full; preserve and archive only after reconciliation');
    this.ledger.transact(next=>next.commands.push({id:command.id,hash,type:command.type,at:Date.now(),stage:'received',reason:null,orderId:null}));
    try{
      if(command.type==='QUICK_TRADE'){
        if(this.financial||s.orders.some(unresolved))throw Error('Another financial intent is in progress');
        const task=command.side==='buy'?()=>this.buy(command.mint,solToLamports(command.amountSol),{strategy:'manual',bucket:'normal',at:Date.now(),expiresAt:Date.now()+30000,maxUnitUsdc:null,sourceSignature:null},command.id):()=>this.sellPercent(command.mint,command.percentBps,command.id,'Manual sale');
        this.runFinancial(task,command.id);
      }else this.control(command);
    }catch(error){this.reject(command.id,error);}
    this.changed();return this.ledger.read().commands.find(c=>c.id===command.id)!;
  }
  private reject(commandId:string|null,error:unknown,orderId?:string):void {
    const reason=safeError(error,[this.c.core.rpc,this.c.core.apiKey,this.c.appAccessToken]);
    this.ledger.transact(s=>{const o=s.orders.find(o=>o.id===orderId);if(o){o.stage=o.signature?'unknown':'rejected';o.reason=reason;o.updatedAt=Date.now();}
      const cmd=s.commands.find(c=>c.id===commandId);if(cmd){cmd.stage=o?.stage??'rejected';cmd.reason=reason;}event(s,'ACTION_BLOCKED',{commandId,orderId:orderId??null,reason});});this.changed();
  }
  private control(command:Exclude<Command,{type:'QUICK_TRADE'}>):void {
    this.ledger.transact(s=>{
      if(command.type==='PANIC_CASH_OUT_ALL'){s.settings.panic=true;s.settings.paused=true;s.settings.autoPilot=false;s.settings.normalEnabled=false;s.settings.copyEnabled=false;for(const p of s.positions)p.exitReason='Sell all tokens to SOL';}
      if(command.type==='PAUSE_ENTRIES'){if(!command.paused&&s.settings.panic&&(s.positions.length||s.orders.some(unresolved)))throw Error('Finish or reconcile panic exits before resuming');s.settings.paused=command.paused;if(!command.paused)s.settings.panic=false;}
      if(command.type==='SET_BOT_PRESET'){
        const raw=solToLamports(command.amountSol);if(raw>this.c.maxBuyLamports)throw Error('Preset size exceeds MAX_BUY_SOL');
        if(s.settings.panic&&command.autoPilot)throw Error('Panic liquidation is active');
        if(command.copyEnabled&&!s.copy.leader)throw Error('Configure COPY_LEADER locally before enabling copy');
        Object.assign(s.settings,{preset:command.preset,autoPilot:command.autoPilot,normalEnabled:command.normalEnabled,copyEnabled:command.copyEnabled,orderLamports:raw.toString()});
      }
      if(command.type==='SET_ALLOCATIONS'){
        if(s.positions.length||s.orders.some(unresolved)||this.financial||s.settings.autoPilot)throw Error('Reallocation requires a flat portfolio, no pending orders and auto-pilot off');
        const total=amount(s.cashLamports),normal=total*BigInt(command.normalPct)/100n,copy=total*BigInt(command.copyPct)/100n;
        for(const [key,value,pct]of [['normal',normal,command.normalPct],['copy',copy,command.copyPct],['reserve',total-normal-copy,command.reservePct]] as const){
          const b=s.buckets[key],delta=value-amount(b.cashLamports);b.cashLamports=value.toString();b.pct=pct;
          // Move baselines by the same capital transfer; never clear loss/halts.
          b.dayStartLamports=max(0n,amount(b.dayStartLamports)+delta).toString();b.highWaterLamports=max(0n,amount(b.highWaterLamports)+delta).toString();
        }
      }
      const cmd=s.commands.find(c=>c.id===command.id)!;cmd.stage='accepted';event(s,'CONTROL_CHANGED',{commandId:command.id,type:command.type});
    });
  }
  private runFinancial(work:()=>Promise<void>,commandId:string|null=null):void {
    if(this.financial)throw Error('Financial operation is busy');
    this.financial=work().catch(error=>{const o=this.ledger.read().orders.find(o=>unresolved(o)&&(!commandId||o.commandId===commandId));this.reject(commandId,error,o?.id);this.report(error);}).finally(()=>{this.financial=null;this.authorization=null;this.prepared=null;this.pendingBuy=null;this.changed();});
  }
  async autoBuy(mint:string,signal:Signal):Promise<void>{
    if(this.financial||this.ledger.read().orders.some(unresolved))return;
    this.runFinancial(()=>this.buy(mint,amount(this.ledger.read().settings.orderLamports),signal,null));await this.financial;
  }
  private async buy(mint:string,requested:bigint,signal:Signal,commandId:string|null):Promise<void> {
    this.pendingBuy={mint,bucket:signal.bucket};
    if([SOL,USDC].includes(mint))throw Error('Base assets cannot be trade targets');
    const port=this.runtime(),ref=await port.reference();
    this.ledger.transact(s=>{s.reference=ref;this.updateRisk(s,ref);});
    let s=this.ledger.read();const blocked=this.entryBlock(s,signal.bucket,mint);if(blocked)throw Error(blocked);
    const size=signal.strategy==='manual'?requested:min(requested,this.allowedSize(s,signal.bucket,ref,mint));
    if(size<=0n||size>this.allowedSize(s,signal.bucket,ref,mint)||solCostMicroUsdc(size,ref)<1000000n)throw Error('Order size is outside the affordable risk limits (minimum 1 USDC equivalent)');
    const evidence=await port.candidate(mint),invalid=this.screen?.(evidence);if(invalid)throw Error(invalid);
    const quote=await port.quote('buy',mint,size.toString(),s.settings.preset!=='Safe');
    const held=s.mode==='paper'?haircut(quote.outAmount,limit(this.c,'paperSlip')):amount(quote.otherAmountThreshold);
    const reverse=await port.quote('sell',mint,held.toString());
    s=this.ledger.read();
    // Manual and normal entries also get a server-observed price-chase ceiling.
    if(signal.maxUnitUsdc===null)signal={...signal,maxUnitUsdc:evidence.token.usdPrice/ref.usdcUsd*(1+limit(this.c,'maxJump')/100)};
    const order=this.newOrder('buy',mint,evidence.token.symbol,evidence.token.decimals,signal.bucket,size.toString(),ref,commandId,signal,false,evidence.market.mcapUsd);
    const intent:SwapIntent={side:'buy',mint,decimals:evidence.token.decimals,amountRaw:size.toString(),quote,expiresAt:Math.min(signal.expiresAt,evidence.at+15000,quote.receivedAt+15000,reverse.receivedAt+15000)};
    this.authorization={orderId:order.id,intent,evidence,reverse,reference:ref,signal};
    await this.execute(order,intent);
  }
  private newOrder(side:'buy'|'sell',mint:string,symbol:string,decimals:number,bucket:Bucket,raw:string,ref:SolReference,commandId:string|null,signal:Signal|null,partialProfit:boolean,mcap:number|null):Order {
    const s=this.ledger.read();if(s.orders.some(unresolved)||s.orders.length>=10000)throw Error('Existing unresolved order or full order journal');
    const order:Order={id:randomUUID(),commandId,side,mint,symbol:symbol.slice(0,32),decimals,bucket,amountRaw:raw,stage:'preparing',createdAt:Date.now(),updatedAt:Date.now(),reason:null,
      strategy:signal?.strategy??'exit',signal,protection:protection(this.c,s.settings.preset,bucket),partialProfit,reserveLamports:(side==='buy'?amount(raw)+this.overhead(mint):BigInt(this.c.core.networkCap)).toString(),reference:ref,entryMcapUsd:mcap,
      fx:s.fx,signature:null,nativeAudit:null,lastValidBlockHeight:null,applied:false,receipt:null,preparationMs:null,transportMs:null,fillMs:null};
    this.ledger.transact(next=>{next.orders.push(order);const cmd=next.commands.find(c=>c.id===commandId);if(cmd){cmd.orderId=order.id;cmd.stage='preparing';}});return order;
  }
  private async sellPercent(mint:string,bps:number,commandId:string|null,reason:string,partial=false):Promise<void>{
    const p=this.ledger.read().positions.find(p=>p.mint===mint);if(!p)throw Error('No managed position');
    const raw=bps===10000?amount(p.quantityRaw):amount(p.quantityRaw)*BigInt(bps)/10000n;
    await this.sellRaw(mint,raw,commandId,reason,partial);
  }
  private async sellRaw(mint:string,raw:bigint,commandId:string|null,reason:string,partial=false):Promise<void>{
    const s=this.ledger.read(),p=s.positions.find(p=>p.mint===mint);if(!p||raw<=0n||raw>amount(p.quantityRaw))throw Error('Invalid managed sale quantity');
    const quote=await this.runtime().quote('sell',mint,raw.toString());
    const order=this.newOrder('sell',mint,p.symbol,p.decimals,p.bucket,raw.toString(),s.reference??p.entryReference,commandId,null,partial,p.entryMcapUsd);
    this.ledger.transact(next=>{next.orders.find(o=>o.id===order.id)!.reason=reason;});
    const intent:SwapIntent={side:'sell',mint,decimals:p.decimals,amountRaw:raw.toString(),quote,expiresAt:quote.receivedAt+15000};
    this.authorization={orderId:order.id,intent,evidence:null,reverse:null,reference:order.reference,signal:null};await this.execute(order,intent);
  }
  private async execute(order:Order,intent:SwapIntent):Promise<void>{
    const port=this.runtime();await this.assertAllowed(intent);await port.checkWallet(this.ledger.read());
    if(this.c.core.mode==='paper'){
      // Quote output is hypothetical. No signing or send path is reachable.
      await this.assertAllowed(intent);const q=intent.quote as Quote,out=haircut(q.outAmount,limit(this.c,'paperSlip'));
      if(out<amount(q.otherAmountThreshold))throw Error('Paper adverse fill would break the quote minimum');
      const fee=limit(this.c,'paperNetwork'),rent=order.side==='buy'&&!this.ledger.read().paperTokenAccounts.includes(order.mint)?limit(this.c,'paperRent'):0;
      const base=order.side==='buy'?-amount(order.amountRaw):out,token=order.side==='buy'?out:-amount(order.amountRaw),native=-base+BigInt(fee+rent);
      this.ledger.transact(s=>{applySettlement(s,order.id,{kind:'success',base:'SOL',baseDelta:base.toString(),tokenDelta:token.toString(),nativeSpent:Number(native),feeLamports:fee,tipLamports:0,rentDeltaLamports:rent,confirmation:'finalized'},limit(this.c,'cooldownMs'));this.applyQueuedSales(s);});
      this.changed();return;
    }
    const started=performance.now(),swap=await port.prepare(intent);this.prepared=swap;const audit=port.audit(swap);
    this.ledger.transact(s=>{const o=s.orders.find(o=>o.id===order.id)!;o.signature=swap.signature;o.nativeAudit=audit;o.lastValidBlockHeight=swap.lastValidBlockHeight;o.stage='prepared';o.preparationMs=performance.now()-started;o.updatedAt=Date.now();if(o.commandId)s.commands.find(c=>c.id===o.commandId)!.stage='prepared';});
    // Recheck wallet ownership/cash and the exact persisted audit before send.
    await port.checkWallet(this.ledger.read());await this.assertPersisted(swap.signature);
    try{
      const result=await port.send(swap);
      this.ledger.transact(s=>{const o=s.orders.find(o=>o.id===order.id)!;o.stage='submitted';o.transportMs=result.transportLatencyMs;o.updatedAt=Date.now();if(o.commandId)s.commands.find(c=>c.id===o.commandId)!.stage='submitted';event(s,'TRADE_SUBMITTED',{orderId:o.id,signature:o.signature,mode:s.mode});});
    }catch(error){this.reject(order.commandId,error,order.id);}
    this.nextReconcile=0;this.changed();
  }
  async reconcile():Promise<void>{
    const o=this.ledger.read().orders.find(unresolved);if(!o?.signature)return;
    const receipt=await this.runtime().settlement(o,o.applied?'finalized':this.c.core.liveCommitment);if(receipt.kind==='pending')return;
    try{
      if(receipt.feeLamports+(receipt.kind==='success'?receipt.tipLamports:0)>this.c.core.networkCap||receipt.kind==='success'&&receipt.rentDeltaLamports>this.c.core.rentCap)throw Error('Receipt fee/rent exceeds recorded limits');
      this.ledger.transact(s=>{applySettlement(s,o.id,receipt,limit(this.c,'cooldownMs'));this.applyQueuedSales(s);});
    }
    catch(error){this.ledger.transact(s=>{s.risk.halt='Settlement disagreement: manual reconciliation required';event(s,'SETTLEMENT_BLOCKED',{orderId:o.id});});throw error;}
    this.changed();
  }
  copySale(eventData:CopyEvent,signature:string):void {
    this.ledger.transact(s=>{
      const relevant=(this.pendingBuy?.mint===eventData.mint&&this.pendingBuy.bucket==='copy')||s.positions.some(p=>p.mint===eventData.mint&&p.bucket==='copy')||s.orders.some(o=>o.mint===eventData.mint&&o.bucket==='copy'&&o.side==='buy'&&unresolved(o));
      if(!relevant)return;
      const rows=s.copy.queuedSales[eventData.mint]??=[];
      if(rows.some(r=>r.signature===signature))return;
      if(rows.length>=50){s.copy.blocked='Too many leader sales awaiting reconciliation';s.risk.halt??='Copy exit queue requires reconciliation';return;}
      rows.push({event:eventData,signature});this.applyQueuedSales(s);
    });this.changed();
  }
  claimCopy(eventData:CopyEvent|null,signature:string,slot:number):boolean {
    let claimed=false;
    this.ledger.transact(s=>{
      if(Object.hasOwn(s.copy.claims,signature))return;
      if(Object.keys(s.copy.claims).length>=5000)throw Error('Copy claims exceed bounded coverage');
      s.copy.claims[signature]=slot;claimed=true;if(eventData)s.copy.lastSignalAt=eventData.at;
      if(eventData?.side==='sell'){
        const relevant=(this.pendingBuy?.mint===eventData.mint&&this.pendingBuy.bucket==='copy')||s.positions.some(p=>p.mint===eventData.mint&&p.bucket==='copy')||s.orders.some(o=>o.mint===eventData.mint&&o.bucket==='copy'&&o.side==='buy'&&unresolved(o));
        if(relevant){const rows=s.copy.queuedSales[eventData.mint]??=[];if(rows.length>=50)throw Error('Copy sale queue full');rows.push({event:eventData,signature});this.applyQueuedSales(s);}
      }
    });return claimed;
  }
  private applyQueuedSales(s:LedgerState):void{
    for(const [mint,rows]of Object.entries(s.copy.queuedSales)){
      const p=s.positions.find(p=>p.mint===mint&&p.bucket==='copy');if(!p||s.orders.some(o=>o.mint===mint&&unresolved(o)))continue;
      for(const row of rows){const before=amount(row.event.leaderBefore),sold=amount(row.event.tokenAmount),remaining=amount(p.quantityRaw)-amount(p.queuedSellRaw);
        if(this.c.core.copyExitPolicy==='full'||before<=0n||sold>before){p.queuedSellRaw=p.quantityRaw;p.exitReason='Leader sale requires full exit';}
        else p.queuedSellRaw=(amount(p.queuedSellRaw)+remaining*sold/before).toString();
      }delete s.copy.queuedSales[mint];
    }
  }
  async tick():Promise<void>{
    this.health.lastTick=Date.now();if(this.monitorWork)return;
    this.monitorWork=this.monitor().finally(()=>{this.monitorWork=null;});await this.monitorWork;
  }
  private async monitor():Promise<void>{
    if(this.financial)return;let s=this.ledger.read();
    if(s.orders.some(unresolved)){
      if(Date.now()>=this.nextReconcile){this.nextReconcile=Date.now()+3000;await this.reconcile();}return;
    }
    // Priority exits are decided before launching the next bounded mark refresh.
    for(const p of s.positions){
      let reason=p.exitReason??(s.settings.panic?'Sell all tokens to SOL':s.risk.halt||s.buckets[p.bucket].halt),raw=amount(p.quantityRaw),partial=false;
      if(!reason&&Date.now()-p.openedAt>=p.protection.holdMs)reason='Maximum holding time';
      if(!reason&&p.markLamports!==null&&p.markAt!==null&&fresh(p.markAt,30000)){
        const mark=Number(amount(p.markLamports)),cost=Number(amount(p.costLamports)),pct=(mark/cost-1)*100;
        if(pct<=-p.protection.stop)reason='Stop loss';
        else if(!p.partialTaken&&pct>=p.protection.take){reason='Take profit';partial=p.protection.partialBps<10000;raw=amount(p.quantityRaw)*BigInt(p.protection.partialBps)/10000n;if(raw===0n){raw=amount(p.quantityRaw);partial=false;}}
        else if(Number(amount(p.peakLamports))>=cost*(1+p.protection.trailStart/100)&&mark<=Number(amount(p.peakLamports))*(1-p.protection.trail/100))reason='Trailing stop';
      }
      if(!reason&&amount(p.queuedSellRaw)>0n){reason='Leader proportional sale';raw=amount(p.queuedSellRaw);}
      if(reason&&(this.retries.get(p.mint)??0)<=Date.now()){
        this.retries.set(p.mint,Date.now()+15000);this.runFinancial(()=>this.sellRaw(p.mint,raw,null,reason!,partial));return;
      }
    }
    if(s.positions.length&&!this.markWork&&Date.now()>=this.nextMark){
      this.nextMark=Date.now()+Math.max(1000,limit(this.c,'exitQuoteMs')/s.positions.length);
      const p=s.positions[this.markCursor++%s.positions.length]!;
      this.markWork=(async()=>{
      try{
        const q=await this.runtime().quote('sell',p.mint,p.quantityRaw),out=s.mode==='paper'?haircut(q.outAmount,limit(this.c,'paperSlip')):amount(q.otherAmountThreshold);
        const fee=BigInt(s.mode==='paper'?limit(this.c,'paperNetwork'):this.c.core.networkCap),net=max(0n,out-fee);
        this.ledger.transact(next=>{const current=next.positions.find(r=>r.id===p.id);if(!current||current.quantityRaw!==p.quantityRaw)return;current.markLamports=net.toString();current.markAt=Date.now();current.peakLamports=max(amount(current.peakLamports),net).toString();current.quoteFailures=0;});this.health.lastObservation=Date.now();
      }catch(error){this.ledger.transact(next=>{const current=next.positions.find(r=>r.id===p.id);if(current){current.quoteFailures++;if(current.quoteFailures>=3){current.markLamports=null;current.markAt=null;next.risk.halt??='Repeated exit-quote failures';}}});this.report(error);}
      })().finally(()=>{this.markWork=null;this.changed();});
    }
    s=this.ledger.read();if(s.reference&&fresh(s.reference.at))this.ledger.transact(next=>this.updateRisk(next,s.reference!));this.changed();
  }
  snapshot():Record<string,unknown>{
    const s=this.ledger.read(),ref=s.reference&&fresh(s.reference.at)?s.reference:null,complete=s.positions.every(p=>p.markLamports!==null&&p.markAt!==null&&fresh(p.markAt,30000));
    const eq=complete?equity(s):null,eur=s.fx&&fresh(s.fx.at,7*86400000)?s.fx.eurUsd:null;
    const quoteValue=(raw:bigint|null)=>raw===null||!ref?null:Number(raw)/1e9*ref.solUsd;
    const usd=quoteValue(eq),initialSol=Number(amount(s.initialCashLamports))/1e9;
    const reserved=s.orders.filter(o=>unresolved(o)&&!o.applied).reduce((sum,o)=>sum+amount(o.reserveLamports),0n);
    return {mode:s.mode,base:s.base,wallet:s.wallet,seq:s.seq,reportingDay:s.day,timezone:s.timezone,cashLamports:s.cashLamports,equityLamports:eq?.toString()??null,equityUsd:usd,equityEur:usd!==null&&eur?usd/eur:null,
      realizedTradingLamports:s.realizedLamports,capitalChangeLamports:eq===null?null:(eq-amount(s.fundingLamports)).toString(),referenceOnlyChangeUsd:ref?initialSol*(ref.solUsd-s.initialReference.solUsd):null,
      maxAffordableBuyLamports:{normal:ref&&!this.entryBlock(s,'normal','')?this.allowedSize(s,'normal',ref,'').toString():'0',copy:ref&&!this.entryBlock(s,'copy','')?this.allowedSize(s,'copy',ref,'').toString():'0'},
      reference:ref,fx:s.fx,feesLamports:s.feesLamports,rentLamports:s.rentLamports,reservedLamports:reserved.toString(),unreservedCashLamports:max(0n,amount(s.cashLamports)-reserved).toString(),allocations:s.buckets,settings:s.settings,halt:s.risk.halt,
      positions:s.positions.map(p=>{const valid=p.markAt!==null&&fresh(p.markAt,30000)&&p.markLamports!==null,pnl=valid?amount(p.markLamports!)-amount(p.costLamports):null;return {...p,markStale:!valid,estimatedPnlLamports:pnl?.toString()??null,pnlPercent:pnl===null?null:Number(pnl)/Number(amount(p.costLamports))*100};}),
      pending:s.orders.filter(unresolved),recentOrders:s.orders.slice(-30),recentCommands:s.commands.slice(-30),copy:{leader:s.copy.leader,blocked:s.copy.blocked,lastPollAt:s.copy.lastPollAt,lastSignalAt:s.copy.lastSignalAt,streamReady:s.copy.streamReady,estimatedHistoryCredits:s.copy.credits},health:this.health};
  }
}

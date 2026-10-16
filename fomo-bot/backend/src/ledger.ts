import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {atomicJson, mintAddress, object, rawAmount} from './util.js';
import type {LedgerState, Order, Settlement, RiskAccount, Bucket, DurableEvent} from './controllerTypes.js';
import type {Mode} from './types.js';
import type {SolReference} from './priceReference.js';

export const amount = (v:string):bigint => rawAmount(v);
export const signed = (v:string):bigint => {if(typeof v!=='string'||! /^-?(0|[1-9]\d{0,24})$/.test(v)||v==='-0')throw Error('Invalid signed amount');return BigInt(v);};
export function reportingDay(now=Date.now(),timezone='Europe/Dublin'):string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  return ['year','month','day'].map(key=>parts.find(p=>p.type===key)!.value).join('-');
}
const integer=(v:unknown,min=0)=>{if(!Number.isSafeInteger(v)||Number(v)<min)throw Error('Invalid integer in ledger');};
function unique(rows:string[]):void {if(new Set(rows).size!==rows.length)throw Error('Duplicate ledger identity');}
function risk(r:RiskAccount):void {amount(r.dayStartLamports);amount(r.highWaterLamports);integer(r.entries);if(r.halt!==null&&typeof r.halt!=='string')throw Error('Invalid risk halt');}
export function validateLedger(value:unknown):asserts value is LedgerState {
  const s=value as LedgerState;
  if(!s||s.version!==1||s.base!=='SOL'||!['paper','live'].includes(s.mode)||typeof s.wallet!=='string')throw Error('Unsupported controller ledger; do not reset or overwrite it');
  if(s.mode==='live')mintAddress(s.wallet);else if(s.wallet!=='paper')throw Error('Paper wallet mismatch');
  reportingDay(Date.now(),s.timezone);integer(s.createdAt);integer(s.updatedAt);integer(s.seq);integer(s.notificationCursor);
  for(const key of ['initialCashLamports','fundingLamports','cashLamports','feesLamports'] as const)amount(s[key]);
  signed(s.realizedLamports);signed(s.rentLamports);risk(s.risk);
  let cash=0n,pct=0;
  for(const key of ['normal','copy','reserve'] as const){const b=s.buckets[key];risk(b);integer(b.pct);if(b.pct>100)throw Error('Invalid allocation');pct+=b.pct;cash+=amount(b.cashLamports);}
  if(pct!==100||cash!==amount(s.cashLamports))throw Error('Allocation cash does not conserve total cash');
  if(!Array.isArray(s.positions)||s.positions.length>4||!Array.isArray(s.orders)||s.orders.length>10000||!Array.isArray(s.commands)||s.commands.length>10000)throw Error('Invalid ledger collections');
  unique(s.positions.map(p=>p.mint));unique(s.positions.map(p=>p.id));unique(s.orders.map(o=>o.id));unique(s.commands.map(c=>c.id));
  unique(s.orders.flatMap(o=>o.signature?[o.signature]:[]));
  for(const p of s.positions){
    mintAddress(p.mint);if(!['normal','copy'].includes(p.bucket)||amount(p.quantityRaw)<=0n||amount(p.costLamports)<=0n)throw Error('Invalid position');
    integer(p.decimals);if(p.decimals>18)throw Error('Invalid decimals');integer(p.openedAt);amount(p.peakLamports);
    if(p.markLamports!==null)amount(p.markLamports);if(p.markAt!==null)integer(p.markAt);
    if(amount(p.queuedSellRaw)>amount(p.quantityRaw))throw Error('Oversized queued sale');
    if(typeof p.partialTaken!=='boolean'||typeof p.symbol!=='string')throw Error('Invalid position state');
    for(const key of ['stop','take','trailStart','trail','holdMs','partialBps'] as const)if(!Number.isFinite(p.protection[key])||p.protection[key]<0)throw Error('Invalid protection');
    if(p.protection.partialBps>10000)throw Error('Invalid partial fraction');
  }
  const carryingCost=s.positions.reduce((sum,p)=>sum+amount(p.costLamports),0n);
  if(amount(s.cashLamports)+carryingCost!==amount(s.fundingLamports)+signed(s.realizedLamports))throw Error('Cash, remaining cost basis and realized results do not conserve funding');
  const active=s.orders.filter(unresolved);if(active.length>1)throw Error('Multiple unresolved financial orders');
  for(const o of s.orders){
    mintAddress(o.mint);amount(o.amountRaw);amount(o.reserveLamports);integer(o.createdAt);integer(o.updatedAt);
    if(!['buy','sell'].includes(o.side)||!['normal','copy'].includes(o.bucket)||!['received','preparing','prepared','submitted','unknown','confirmed','finalized','failed','rejected'].includes(o.stage))throw Error('Invalid order state');
    if(o.signature!==null){
      if(!o.nativeAudit||bs58.decode(o.signature).length!==64||o.nativeAudit.base!=='SOL'||o.nativeAudit.mint!==o.mint||o.nativeAudit.side!==o.side||o.nativeAudit.inputRaw!==o.amountRaw)throw Error('Order audit mismatch');
      amount(o.nativeAudit.minimumRaw);integer(o.lastValidBlockHeight,1);
      for(const key of ['feeLamports','tipLamports'] as const)integer(o.nativeAudit[key]);
      if(!Number.isSafeInteger(o.nativeAudit.rentDeltaLamports)||!Array.isArray(o.nativeAudit.tokenAccounts))throw Error('Invalid audit');
      o.nativeAudit.tokenAccounts.forEach(mintAddress);
    }
    if(['prepared','submitted','unknown','confirmed'].includes(o.stage)&&!o.signature)throw Error('Missing pending signature');
    if(typeof o.applied!=='boolean'||(o.applied&&(!o.receipt||o.receipt.kind==='pending')))throw Error('Invalid receipt application');
    if(o.commandId!==null&&!s.commands.some(c=>c.id===o.commandId))throw Error('Order has no command claim');
  }
  for(const c of s.commands){if(typeof c.id!=='string'||!/^[a-f0-9]{64}$/.test(c.hash)||typeof c.type!=='string')throw Error('Invalid durable command');integer(c.at);if(c.orderId&&!s.orders.some(o=>o.id===c.orderId))throw Error('Command refers to a missing order');}
  for(const [mint,at]of Object.entries(s.cooldowns)){mintAddress(mint);integer(at);}
  if(!Array.isArray(s.paperTokenAccounts))throw Error('Invalid rent record');s.paperTokenAccounts.forEach(mintAddress);unique(s.paperTokenAccounts);
  const cfg=s.settings;
  for(const key of ['autoPilot','normalEnabled','copyEnabled','panic','paused'] as const)if(typeof cfg[key]!=='boolean')throw Error('Invalid controller setting');
  if(!['Safe','Fast','Degen'].includes(cfg.preset)||amount(cfg.orderLamports)<=0n)throw Error('Invalid preset settings');
  if(!s.copy||!s.copy.claims||!s.copy.queuedSales)throw Error('Invalid copy state');
  if(s.copy.leader!==null)mintAddress(s.copy.leader);integer(s.copy.credits);
  if(s.copy.baselineSlot!==null)integer(s.copy.baselineSlot);if(s.copy.nextSlot!==null)integer(s.copy.nextSlot);
  if(s.copy.scan){integer(s.copy.scan.fromSlot);integer(s.copy.scan.toSlot);integer(s.copy.scan.at);if(s.copy.scan.fromSlot>s.copy.scan.toSlot||s.copy.scan.token!==null&&typeof s.copy.scan.token!=='string')throw Error('Invalid copy scan');}
  if(typeof s.copy.streamReady!=='boolean'||!s.copy.streamUsage||!/^\d{4}-\d{2}-\d{2}$/.test(s.copy.streamUsage.day))throw Error('Invalid stream state');integer(s.copy.streamUsage.bytes);integer(s.copy.streamUsage.connections);
  if(Object.keys(s.copy.claims).length>5000||Object.keys(s.copy.queuedSales).length>4)throw Error('Copy coverage bound exceeded');
  for(const [sig,slot]of Object.entries(s.copy.claims)){if(bs58.decode(sig).length!==64)throw Error('Invalid copy signature');integer(slot);}
  for(const [mint,rows]of Object.entries(s.copy.queuedSales)){mintAddress(mint);if(!Array.isArray(rows)||rows.length>50)throw Error('Invalid queued copy sales');for(const row of rows){amount(row.event.leaderBefore);amount(row.event.tokenAmount);}}
  if(!Array.isArray(s.events)||s.events.length>500)throw Error('Invalid event log');
  unique(s.events.map(e=>String(e.seq)));let previous=0;for(const event of s.events){integer(event.seq);integer(event.at);if(event.seq>s.seq||event.seq<=previous)throw Error('Invalid event sequence');previous=event.seq;}
  object(s.initialReference);if(!Number.isFinite(s.initialReference.solUsd)||s.initialReference.solUsd<=0)throw Error('Missing funding valuation');
}
export function unresolved(o:Order):boolean {return !['finalized','failed','rejected'].includes(o.stage);}
export function equity(s:LedgerState,bucket?:Bucket|'reserve'):bigint {
  return amount(bucket?s.buckets[bucket].cashLamports:s.cashLamports)+s.positions.filter(p=>!bucket||p.bucket===bucket).reduce((sum,p)=>sum+amount(p.markLamports??'0'),0n);
}
export function event(s:LedgerState,type:string,data:Record<string,unknown>):DurableEvent {
  const row={seq:++s.seq,at:Date.now(),type,data};s.events.push(row);s.events=s.events.slice(-500);return row;
}
export function moveCash(s:LedgerState,bucket:Bucket,delta:bigint):void {
  const total=amount(s.cashLamports)+delta,local=amount(s.buckets[bucket].cashLamports)+delta;
  if(total<0n||local<0n)throw Error('Settlement would borrow reserve or overdraw an allocation');
  s.cashLamports=total.toString();s.buckets[bucket].cashLamports=local.toString();
}
function baseRisk(cash:bigint):RiskAccount{return{dayStartLamports:cash.toString(),highWaterLamports:cash.toString(),entries:0,halt:null};}
export function initialLedger(input:{mode:Mode;wallet:string;cash:bigint;reference:SolReference;normalPct:number;copyPct:number;leader:string|null;orderLamports:bigint;timezone?:string}):LedgerState {
  const now=Date.now(),normal=input.cash*BigInt(input.normalPct)/100n,copy=input.cash*BigInt(input.copyPct)/100n,reserve=input.cash-normal-copy;
  const timezone=input.timezone??'Europe/Dublin';
  const s:LedgerState={version:1,mode:input.mode,base:'SOL',wallet:input.wallet,timezone,createdAt:now,updatedAt:now,seq:0,
    initialCashLamports:input.cash.toString(),fundingLamports:input.cash.toString(),cashLamports:input.cash.toString(),realizedLamports:'0',feesLamports:'0',rentLamports:'0',
    day:reportingDay(now,timezone),risk:baseRisk(input.cash),
    buckets:{normal:{pct:input.normalPct,cashLamports:normal.toString(),...baseRisk(normal)},copy:{pct:input.copyPct,cashLamports:copy.toString(),...baseRisk(copy)},reserve:{pct:100-input.normalPct-input.copyPct,cashLamports:reserve.toString(),...baseRisk(reserve)}},
    settings:{autoPilot:false,normalEnabled:true,copyEnabled:Boolean(input.leader),preset:'Safe',orderLamports:input.orderLamports.toString(),panic:false,paused:false},
    positions:[],orders:[],commands:[],cooldowns:{},paperTokenAccounts:[],
    copy:{leader:input.leader,baselineSlot:null,nextSlot:null,scan:null,claims:{},queuedSales:{},blocked:null,lastPollAt:null,lastSignalAt:null,creditDay:new Date(now).toISOString().slice(0,10),credits:0,streamReady:false,streamGapAt:null,streamUsage:{day:new Date(now).toISOString().slice(0,10),bytes:0,connections:0}},
    reference:input.reference,initialReference:input.reference,fx:null,events:[],notificationCursor:0};
  event(s,'INITIALIZED',{mode:s.mode,cashLamports:s.cashLamports});validateLedger(s);return s;
}

/** Only synchronous, copy-on-write transactions may mutate this file. A failed
 * validation/write leaves the old in-memory state authoritative. */
export class Ledger {
  private state:LedgerState; private fd:number; private lockFile:string; private owner:string; private closed=false;
  constructor(readonly file:string,initial:()=>LedgerState,expected:{mode:Mode;wallet:string}) {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});this.lockFile=file+'.lock';this.owner=randomUUID();
    try{this.fd=fs.openSync(this.lockFile,'wx',0o600);}catch{throw Error('Controller is already running, or its lock needs explicit recovery');}
    try{
      fs.writeFileSync(this.fd,JSON.stringify({pid:process.pid,host:os.hostname(),owner:this.owner,at:Date.now()}));fs.fsyncSync(this.fd);
      this.state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')) as LedgerState:initial();validateLedger(this.state);
      if(this.state.mode!==expected.mode||this.state.wallet!==expected.wallet)throw Error('Ledger mode/wallet mismatch');
      if(!fs.existsSync(file))atomicJson(file,this.state);
    }catch(error){fs.closeSync(this.fd);fs.unlinkSync(this.lockFile);throw error;}
  }
  read():LedgerState {return structuredClone(this.state);}
  assertOwner():void {if(this.closed||object(JSON.parse(fs.readFileSync(this.lockFile,'utf8'))).owner!==this.owner)throw Error('Controller lost exclusive ledger ownership');}
  transact(work:(next:LedgerState)=>void):LedgerState {
    this.assertOwner();const next=this.read();work(next);next.updatedAt=Date.now();validateLedger(next);atomicJson(this.file,next);this.state=next;return this.read();
  }
  close():void {if(this.closed)return;this.assertOwner();this.closed=true;fs.closeSync(this.fd);fs.unlinkSync(this.lockFile);}
}

/** Explicit local crash recovery only. Never touch portfolio or submission
 * journals, and never infer a dead process from permission errors. */
export function recoverControllerLock(ledgerFile:string):string {
  const lock=ledgerFile+'.lock',bytes=fs.readFileSync(lock,'utf8'),row=object(JSON.parse(bytes));
  if(row.host!==os.hostname()||typeof row.owner!=='string'||!Number.isSafeInteger(row.pid)||Number(row.pid)<=0)throw Error('Cannot verify this lock owner on this computer');
  try{process.kill(Number(row.pid),0);throw Error('The recorded controller process is still running');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  if(fs.readFileSync(lock,'utf8')!==bytes)throw Error('Lock ownership changed during recovery');
  const backup=lock+'.recovered-'+randomUUID();fs.renameSync(lock,backup);return backup;
}

export function applySettlement(s:LedgerState,orderId:string,receipt:Exclude<Settlement,{kind:'pending'}>,cooldownMs:number):void {
  const o=s.orders.find(row=>row.id===orderId);if(!o)throw Error('Missing durable order');
  if(o.applied){
    const strip=(r:Exclude<Settlement,{kind:'pending'}>)=>{const {confirmation:_,...rest}=r;return JSON.stringify(rest);};
    if(!o.receipt||o.receipt.kind==='pending'||strip(o.receipt)!==strip(receipt))throw Error('Finality receipt disagrees with booked settlement');
    if(receipt.confirmation==='finalized'){o.receipt=receipt;o.stage=receipt.kind==='failed'?'failed':'finalized';o.updatedAt=Date.now();}
  }else{
    integer(receipt.nativeSpent,Number.MIN_SAFE_INTEGER);integer(receipt.feeLamports);
    if(receipt.kind==='failed'){
      if(receipt.nativeSpent!==receipt.feeLamports)throw Error('Failed receipt has unexplained cash movements');
      moveCash(s,o.bucket,-BigInt(receipt.feeLamports));s.feesLamports=(amount(s.feesLamports)+BigInt(receipt.feeLamports)).toString();
      s.realizedLamports=(signed(s.realizedLamports)-BigInt(receipt.feeLamports)).toString();
    }else{
      integer(receipt.tipLamports);if(!Number.isSafeInteger(receipt.rentDeltaLamports))throw Error('Invalid receipt rent');
      const fees=BigInt(receipt.feeLamports+receipt.tipLamports),rent=BigInt(receipt.rentDeltaLamports),base=signed(receipt.baseDelta),tokens=signed(receipt.tokenDelta);
      if(base-fees-rent!==-BigInt(receipt.nativeSpent))throw Error('Native cash receipt does not balance');
      if(o.side==='buy'){
        if(base!==-amount(o.amountRaw)||tokens<=0n||s.positions.some(p=>p.mint===o.mint)||receipt.nativeSpent<=0)throw Error('Buy receipt does not match its intent');
        const cost=BigInt(receipt.nativeSpent);if(cost>amount(o.reserveLamports))throw Error('Buy exceeds durable reservation');
        moveCash(s,o.bucket,-cost);
        s.positions.push({id:o.id,mint:o.mint,symbol:o.symbol,decimals:o.decimals,bucket:o.bucket,strategy:o.strategy,quantityRaw:tokens.toString(),costLamports:cost.toString(),openedAt:Date.now(),entrySignature:o.signature,
          markLamports:null,markAt:null,peakLamports:'0',quoteFailures:0,protection:o.protection,partialTaken:false,queuedSellRaw:'0',exitReason:null,entryReference:o.reference,entryMcapUsd:o.entryMcapUsd,entryFx:o.fx});
        s.risk.entries++;s.buckets[o.bucket].entries++;
        if(s.mode==='paper'&&!s.paperTokenAccounts.includes(o.mint))s.paperTokenAccounts.push(o.mint);
      }else{
        const p=s.positions.find(p=>p.mint===o.mint&&p.bucket===o.bucket);if(!p)throw Error('Sell has no managed position');
        const qty=amount(o.amountRaw),owned=amount(p.quantityRaw),cost=amount(p.costLamports);
        if(tokens!==-qty||qty>owned||base<=0n)throw Error('Sell receipt does not match its intent');
        const allocated=qty===owned?cost:cost*qty/owned,net=-BigInt(receipt.nativeSpent);
        moveCash(s,o.bucket,net);s.realizedLamports=(signed(s.realizedLamports)+net-allocated).toString();
        const remaining=owned-qty;
        if(remaining===0n){s.positions=s.positions.filter(row=>row.id!==p.id);s.cooldowns[p.mint]=Date.now()+cooldownMs;delete s.copy.queuedSales[p.mint];}
        else{p.quantityRaw=remaining.toString();p.costLamports=(cost-allocated).toString();p.peakLamports=(amount(p.peakLamports)*remaining/owned).toString();p.markLamports=null;p.markAt=null;
          p.queuedSellRaw=(amount(p.queuedSellRaw)>qty?amount(p.queuedSellRaw)-qty:0n).toString();if(o.partialProfit)p.partialTaken=true;}
      }
      s.feesLamports=(amount(s.feesLamports)+fees).toString();s.rentLamports=(signed(s.rentLamports)+rent).toString();
    }
    o.applied=true;o.receipt=receipt;o.stage=receipt.confirmation==='finalized'?(receipt.kind==='failed'?'failed':'finalized'):'confirmed';o.updatedAt=Date.now();o.fillMs=Date.now()-o.createdAt;
    event(s,receipt.kind==='success'?'TRADE_FILLED':'TRADE_FAILED',{orderId:o.id,mint:o.mint,side:o.side,mode:s.mode,signature:o.signature,confirmation:receipt.confirmation,fillMs:o.fillMs,receipt,reference:o.reference,fx:o.fx});
  }
  if(o.commandId){const command=s.commands.find(c=>c.id===o.commandId)!;command.stage=o.stage;command.reason=o.reason;}
}

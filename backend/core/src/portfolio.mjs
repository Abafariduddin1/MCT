import { day,raw,usdc,units } from './util.mjs';
import {movePaperSol,solUnits,syncSolPaper} from './paper.mjs';

export function createBuckets(balance,c) {
  const result={};
  for(const [name,pct] of [['normal',c.normalPct],['copy',c.copyPct],['reserve',c.reservePct]]) {
    const allocation=balance*pct/100;
    result[name]={pct,initialEquity:allocation,cash:allocation,equity:allocation,highWater:allocation,
      maxDrawdown:0,day:day(),dayStart:allocation,dayEntries:0,halt:null};
  }
  return result;
}
export const bucketName = value => value || 'normal';
export function bucketLimits(s,c,name) {
  const active=c.normalPct+c.copyPct;
  const fraction=active ? s.buckets[name].pct/active : 0;
  return {...c,maxOpen:c.maxOpenPerBucket,maxExposure:Math.min(c.maxExposure,s.buckets[name].initialEquity),
    dailyLoss:c.dailyLoss*fraction,totalLoss:c.totalLoss*fraction};
}
export function bucketState(s,name) {
  const bucket=s.buckets[name];
  return {...bucket,positions:s.positions.filter(p=>bucketName(p.bucket)===name),cooldowns:s.cooldowns,
    pending:s.pending,paused:s.paused,halt:s.halt||bucket.halt};
}
export function recalculateBuckets(s,c,now=Date.now()) {
  for(const [name,b] of Object.entries(s.buckets)) {
    b.equity=b.cash+s.positions.filter(p=>bucketName(p.bucket)===name).reduce((sum,p)=>sum+p.mark,0);
    if(b.day!==day(now)){b.day=day(now);b.dayStart=b.equity;b.dayEntries=0;}
    b.highWater=Math.max(b.highWater,b.equity);b.maxDrawdown=Math.max(b.maxDrawdown,b.highWater-b.equity);
    if(name==='reserve'||b.pct===0)continue;
    const limits=bucketLimits(s,c,name);
    if(b.highWater-b.equity>=limits.totalLoss)b.halt||='Strategy drawdown limit reached';
    if(b.dayStart-b.equity>=limits.dailyLoss)b.halt||='Strategy daily loss limit reached';
  }
}
export function allocationCheck(s,c) {
  if(!s.buckets)throw new Error('Version 4 requires a portfolio ledger; use a new data directory and keep old records');
  if(s.buckets.normal.pct!==c.normalPct||s.buckets.copy.pct!==c.copyPct||s.buckets.reserve.pct!==c.reservePct)
    throw new Error('Allocation differs from saved portfolio; use the allocate command while stopped and flat');
}
export function assertPortfolio(s,mode) {
  if(s.paper?.base==='SOL'){
    const cash=raw(s.paper.cashLamports),buckets=Object.values(s.paper.buckets).reduce((a,b)=>a+raw(b),0n);
    if(cash!==buckets)throw new Error('SOL bucket amounts differ from paper wallet');
  }
  const liquid=Object.values(s.buckets).reduce((sum,b)=>sum+b.cash,0);
  const expected=s.cash-(mode==='live'?(s.nativeCosts||0):0);
  if(Math.abs(liquid-expected)>0.00001)throw new Error('Portfolio bucket cash differs from the wallet ledger');
}
export function applyExit(s,mode,position,amount,received,network,reason,signature,now=Date.now(),native=null) {
  const current=s.positions.find(p=>position.id?p.id===position.id:p.mint===position.mint);
  if(!current)throw new Error('Position missing from ledger');
  const whole=raw(current.amount),sold=raw(String(amount));
  if(sold<=0n||sold>whole)throw new Error('Exit amount exceeds holding');
  const fraction=Number(sold)/Number(whole),cost=sold===whole?current.cost:units(usdc(current.cost)*sold/whole);
  const name=bucketName(current.bucket),pnl=received-network-cost;
  s.cash+=received-(mode==='paper'?network:0);
  if(mode==='live')s.nativeCosts=(s.nativeCosts||0)+network;
  s.buckets[name].cash+=received-network;
  const record={positionId:current.id,bucket:name,strategy:current.strategy,mint:current.mint,symbol:current.symbol,
    openedAt:current.openedAt,closedAt:now,amount:sold.toString(),cost,received,exitNetworkCost:network,pnl,reason,
    positionClosed:sold===whole,entrySignature:current.entrySignature,exitSignature:signature};
  if(current.base==='SOL'){
    if(mode!=='paper'||!native)throw new Error('SOL paper exit requires exact native amounts');
    const receivedRaw=raw(native.received),fee=raw(native.network),wholeCost=raw(current.costLamports);
    const soldCost=sold===whole?wholeCost:wholeCost*sold/whole;
    movePaperSol(s,name,receivedRaw-fee);
    Object.assign(record,{base:'SOL',costSol:solUnits(soldCost),receivedSol:solUnits(receivedRaw),exitNetworkSol:solUnits(fee),pnlSol:solUnits(receivedRaw-fee-soldCost)});
    if(sold!==whole){
      current.costLamports=String(wholeCost-soldCost);
      current.markLamports=String(raw(current.markLamports||'0')*(whole-sold)/whole);
      current.peakLamports=String(raw(current.peakLamports||'0')*(whole-sold)/whole);
    }
  }
  if(s.valuation?.eurPerUsdc)record.pnlEur=pnl*s.valuation.eurPerUsdc;
  s.trades.push(record);
  if(sold===whole){s.positions=s.positions.filter(p=>p.mint!==current.mint);s.cooldowns[current.mint]=now;}
  else{
    current.amount=(whole-sold).toString();current.cost-=cost;
    current.mark=Math.max(0,current.mark*(1-fraction)-network*fraction);
    current.peak*=1-fraction;current.markAt=0;
    current.pendingCopySell=raw(current.pendingCopySell||'0')>sold?(raw(current.pendingCopySell)-sold).toString():'0';
  }
  if(current.base==='SOL')syncSolPaper(s,s.valuation.solUsdc);
  return record;
}

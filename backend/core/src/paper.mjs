import {raw} from './util.mjs';
const billion=1000000000;
export const lamports=n=>BigInt(Math.floor(n*billion+1e-5));
export const solUnits=n=>Number(BigInt(n))/billion;
export function initialiseSolPaper(s,c,solUsdc,fx,usdcUsd=1){
  if(!Number.isFinite(solUsdc)||solUsdc<=0)throw new Error('A SOL price is required for SOL paper capital');
  const initial=c.paperInitialSol>0?lamports(c.paperInitialSol):lamports(c.paperBalanceEur*fx.eurUsd/usdcUsd/solUsdc);
  if(initial<=0n)throw new Error('Initial SOL paper capital is too small');
  const normal=initial*BigInt(Math.round(c.normalPct*1000))/100000n,copy=initial*BigInt(Math.round(c.copyPct*1000))/100000n;
  s.paper={base:'SOL',cashLamports:String(initial),buckets:{normal:String(normal),copy:String(copy),reserve:String(initial-normal-copy)},
    initialSol:solUnits(initial),createdTokenAccounts:[]};
  s.valuation={solUsdc,usdcUsd,eurPerUsdc:usdcUsd/fx.eurUsd,fx};
  const initialValue=solUnits(initial)*solUsdc;
  s.initialEquity=initialValue;s.cash=initialValue;s.equity=initialValue;s.highWater=initialValue;s.dayStart=initialValue;
  s.initialEquityEur=initialValue*s.valuation.eurPerUsdc;
  for(const [name,b]of Object.entries(s.buckets)){
    const value=solUnits(s.paper.buckets[name])*solUsdc;
    Object.assign(b,{initialEquity:value,cash:value,equity:value,highWater:value,dayStart:value});
  }
}
export function syncSolPaper(s,solUsdc){
  if(s.paper?.base!=='SOL')return;
  s.cash=solUnits(s.paper.cashLamports)*solUsdc;
  for(const [name,b]of Object.entries(s.buckets))b.cash=solUnits(s.paper.buckets[name])*solUsdc;
  for(const p of s.positions)if(p.base==='SOL'){
    p.mark=solUnits(p.markLamports||'0')*solUsdc;
    p.peak=solUnits(p.peakLamports||p.markLamports||'0')*solUsdc;
  }
}
export function movePaperSol(s,name,delta){
  const d=BigInt(delta),bucket=raw(s.paper.buckets[name])+d,total=raw(s.paper.cashLamports)+d;
  if(bucket<0n||total<0n)throw new Error('SOL paper cash cannot be negative');
  s.paper.buckets[name]=String(bucket);s.paper.cashLamports=String(total);
}
export function recordLatency(s,stage,elapsedMs,targetMs,extra={}){
  s.latency||={};const m=s.latency[stage]||{count:0,underTarget:0,maxMs:0,recentMs:[]};
  m.count++;m.underTarget+=Number(elapsedMs<=targetMs);m.maxMs=Math.max(m.maxMs,elapsedMs);
  m.recentMs.push(elapsedMs);m.recentMs=m.recentMs.slice(-100);m.last={elapsedMs,targetMs,...extra,at:new Date().toISOString()};s.latency[stage]=m;
}

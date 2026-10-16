import fs from 'node:fs';
import path from 'node:path';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const usdc = n => BigInt(Math.floor(n * 1e6 + 1e-7));
export const units = n => Number(BigInt(n)) / 1e6;
export function raw(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Malformed integer token amount');
  return BigInt(value);
}
export function signedRaw(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new Error('Malformed signed token balance change');
  return BigInt(value);
}
export const haircut = (amount, bps) => raw(String(amount)) * BigInt(10000 - bps) / 10000n;
export const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  // A directory fsync is supported on Unix; Windows may reject it.
  try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {}
}
export function cleanError(error, c = {}) {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of [c.apiKey, c.rpc, c.wsUrl, c.telegramToken]) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:https?|wss?):\/\/[^\s]+/g, '[URL]').slice(0, 400);
}
export function summary(s) {
  const fills=s.trades;
  const grouped=new Map();
  for(const fill of fills){const id=fill.positionId||`${fill.mint}:${fill.openedAt}`;const g=grouped.get(id)||{...fill,pnl:0,closed:false};
    g.pnl+=fill.pnl;g.closed||=fill.positionClosed!==false;grouped.set(id,g);}
  const trades=[...grouped.values()].filter(t=>t.closed);
  const pnls = trades.map(t => t.pnl);
  const wins = pnls.filter(n => n > 0), losses = pnls.filter(n => n < 0);
  const profit = wins.reduce((a,b) => a+b, 0), loss = -losses.reduce((a,b) => a+b, 0);
  const interval=(wins,total)=>{
    if(!total)return null;const z=1.96,p=wins/total,den=1+z*z/total;
    const centre=(p+z*z/(2*total))/den,half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/den;
    return [100*Math.max(0,centre-half),100*Math.min(1,centre+half)];
  };
  const byStrategy={};
  for(const name of ['momentum','breakout','pullback','mean_reversion','copy']){
    const rows=trades.filter(t=>(t.strategy||'momentum')===name),win=rows.filter(t=>t.pnl>0).length;
    byStrategy[name]={closedPositions:rows.length,netRealisedUsdc:rows.reduce((a,t)=>a+t.pnl,0),winRatePct:rows.length?100*win/rows.length:null,
      winRate95Pct:interval(win,rows.length)};
  }
  return {
    mode: s.mode, strategy: s.strategy || 'momentum', tradingBase:s.paper?.base||'USDC',cashUsdc: s.cash, estimatedEquityUsdc: s.equity,
    ...(s.paper?.base==='SOL'?{cashSol:Number(s.paper.cashLamports)/1e9,estimatedEquitySol:s.equity/s.valuation.solUsdc,
      initialCapitalSol:s.paper.initialSol,totalChangeSol:s.equity/s.valuation.solUsdc-s.paper.initialSol,
      realisedTradingPnlSol:fills.reduce((a,b)=>a+(b.pnlSol||0),0)}:{}),
    ...(s.valuation?.eurPerUsdc?{estimatedEquityEur:s.equity*s.valuation.eurPerUsdc,initialCapitalEur:s.initialEquityEur||s.initialEquity*s.valuation.eurPerUsdc,
      realisedPnlEurAtFill:fills.reduce((a,b)=>a+(b.pnlEur||0),0),valuation:s.valuation}:{}),
    realisedPnlUsdc: fills.reduce((a,b) => a+b.pnl, 0),exitFills:fills.length,
    feesOnFailedTransactionsUsdc: s.failedCosts || 0,
    netChangeUsdc: s.equity - s.initialEquity,
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRatePct: trades.length ? wins.length / trades.length * 100 : null,
    winRate95Pct:interval(wins.length,trades.length),byStrategy,
    averageNetTradeUsdc: trades.length ? (profit - loss) / trades.length : null,
    profitFactor: loss ? profit/loss : null,
    maxDrawdownUsdc: s.maxDrawdown, openPositions: s.positions,
    pending: s.pending ? { signature: s.pending.signature, side: s.pending.side } : null,
    allocations:s.buckets,health:s.health,diagnostics:s.diagnostics||null,market:s.market||null,
    pendingFinality:s.finality?.map(r=>({signature:r.intent.signature,recordedAt:r.recordedAt}))||[],
    latency:Object.fromEntries(Object.entries(s.latency||{}).map(([name,m])=>{const sorted=[...m.recentMs].sort((a,b)=>a-b);return[name,{count:m.count,underTargetPct:100*m.underTarget/m.count,
      p50Ms:sorted[Math.floor((sorted.length-1)*0.5)],p95Ms:sorted[Math.floor((sorted.length-1)*0.95)],maxMs:m.maxMs,last:m.last}];})),
    halt: s.halt, paused: s.paused, copyLeader: s.copy?.leader || null,copyHealth:s.copy?{blocked:s.copy.blocked,lastPoll:s.copy.lastPoll,
      estimatedHistoryCredits:s.copy.estimatedCredits,coveredThroughSlot:s.copy.coveredThroughSlot,backlog:Boolean(s.copy.scan)}:null,updatedAt: s.updatedAt
  };
}

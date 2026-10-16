import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, day } from './util.mjs';
import { createBuckets, assertPortfolio } from './portfolio.mjs';
import {initialiseSolPaper} from './paper.mjs';
export class Store {
  constructor(c) { this.c = c; this.dir = c.dataDir; this.file = path.join(this.dir, 'state.json'); }
  acquire() {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, 'run.lock');
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      this.lock = lock;
    } catch { throw new Error(`Another bot or stale lock exists: ${lock}. See recovery instructions.`); }
  }
  release() { if (this.lock) { try { fs.unlinkSync(this.lock); } catch {} this.lock = null; } }
  exists() { return fs.existsSync(this.file); }
  read() {
    const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (s.version !== 4 || s.mode !== this.c.mode || !Array.isArray(s.positions) || !Array.isArray(s.trades) || !Number.isFinite(s.cash))
      throw new Error('State is not version 4; preserve old records and set DATA_DIR=./data-v4');
    for (const name of ['equity','initialEquity','highWater','maxDrawdown','dayStart','dayEntries'])
      if (!Number.isFinite(s[name])) throw new Error(`Invalid stored ${name}; refusing to reset accounting`);
    if (typeof s.paused !== 'boolean' || (s.halt !== null && typeof s.halt !== 'string')
        || !s.cooldowns || typeof s.cooldowns !== 'object' || Array.isArray(s.cooldowns)
        || Object.values(s.cooldowns).some(value => !Number.isFinite(value))
        || !Number.isInteger(s.dayEntries) || s.dayEntries < 0 || s.maxDrawdown < 0)
      throw new Error('Invalid saved risk controls; refusing to reset accounting');
    if (s.trades.some(trade => !Number.isFinite(trade.pnl))) throw new Error('Invalid saved trade ledger');
    if (s.copy && (typeof s.copy.leader !== 'string' || !Array.isArray(s.copy.seen) || !Number.isFinite(s.copy.startedAt)
        || (s.copy.cursor !== null && typeof s.copy.cursor !== 'string'))) throw new Error('Invalid saved copy cursor');
    if(!s.buckets||Object.keys(s.buckets).sort().join(',')!=='copy,normal,reserve')throw new Error('Invalid portfolio buckets');
    for(const b of Object.values(s.buckets))for(const field of ['pct','initialEquity','cash','equity','highWater','maxDrawdown','dayStart','dayEntries'])
      if(!Number.isFinite(b[field]))throw new Error('Invalid stored portfolio amounts');
    if(Object.values(s.buckets).some(b=>b.pct<0||b.pct>100||(b.halt!==null&&typeof b.halt!=='string'))
      ||Math.abs(Object.values(s.buckets).reduce((a,b)=>a+b.pct,0)-100)>0.000001)throw new Error('Invalid portfolio allocation percentages');
    if(s.pending&&(!['buy','sell'].includes(s.pending.side)||typeof s.pending.signature!=='string'||typeof s.pending.mint!=='string'
      ||!/^\d+$/.test(s.pending.amount)))throw new Error('Invalid stored transaction intent; manual recovery required');
    assertPortfolio(s,this.c.mode);
    if(!Array.isArray(s.finality)||s.finality.length>20||s.finality.some(r=>!r.intent||typeof r.intent.signature!=='string'
      ||!Number.isSafeInteger(r.intent.lastValidBlockHeight)||!r.result||!['success','failed'].includes(r.result.kind)||!Number.isSafeInteger(r.result.nativeSpent)))
      throw new Error('Invalid stored finality verification records');
    if(s.streamUsage&&(!Number.isSafeInteger(s.streamUsage.bytes)||s.streamUsage.bytes<0||!Number.isSafeInteger(s.streamUsage.connections)||s.streamUsage.connections<0))
      throw new Error('Invalid stored stream usage');
    if(this.c.mode==='paper'&&!['SOL','USDC'].includes(s.paper?.base))throw new Error('Invalid paper base');
    if(s.paper?.base==='SOL'&&(!Number.isFinite(s.paper.initialSol)||s.paper.initialSol<=0||!Number.isFinite(s.valuation?.solUsdc)||s.valuation.solUsdc<=0
      ||!Array.isArray(s.paper.createdTokenAccounts)))throw new Error('Invalid SOL paper valuation');
    for (const p of s.positions) if (!/^\d+$/.test(p.amount) || BigInt(p.amount) <= 0n || !Number.isFinite(p.cost) || p.cost <= 0 || !Number.isFinite(p.mark)
        || p.mark < 0 || !Number.isFinite(p.peak) || !Number.isFinite(p.openedAt))
      throw new Error('Invalid saved position; manual recovery required');
    for(const p of s.positions)if(p.base==='SOL'&&(!/^\d+$/.test(p.costLamports)||BigInt(p.costLamports)<=0n||!/^\d+$/.test(p.markLamports)||!/^\d+$/.test(p.peakLamports)))
      throw new Error('Invalid SOL paper position amounts');
    return s;
  }
  create(balance, wallet = null, paperReference = null) {
    const s = { version: 4, mode: this.c.mode, strategy:this.c.strategy || 'hybrid', wallet, initialEquity: balance, cash: balance,
      equity: balance, highWater: balance, maxDrawdown: 0, day: day(), dayStart: balance,
      dayEntries: 0, positions: [], trades: [], cooldowns: {}, pending: null,
      paused: false, halt: null, failedCosts: 0, observedSolLamports: null,
      buckets:createBuckets(balance,this.c),signals:{},health:{lastScan:null,lastMonitor:null,lastError:null},
      finality:[],latency:{},paper:this.c.mode==='paper'?{base:this.c.paperBase||'USDC'}:null,
      updatedAt: new Date().toISOString() };
    if(this.c.mode==='paper'&&this.c.paperBase==='SOL'){
      if(!paperReference)throw new Error('SOL paper capital needs an initial market and EUR reference');
      initialiseSolPaper(s,this.c,paperReference.solUsdc,paperReference.fx,paperReference.usdcUsd);
    }
    this.save(s); return s;
  }
  save(s) { s.updatedAt = new Date().toISOString(); atomicJson(this.file, s); this.lastSavedAt=Date.now(); }
  checkpoint(s) { if(!this.lastSavedAt||Date.now()-this.lastSavedAt>=5000)this.save(s); }
  log(type, details = {}) {
    const row = { ...details, at: new Date().toISOString(), type };
    fs.appendFileSync(path.join(this.dir, `events-${day()}.jsonl`), JSON.stringify(row) + '\n', { mode: 0o600 });
    if (!['snapshot', 'reject', 'mark'].includes(type)) console.log(JSON.stringify(row));
  }
  flag(name) { return fs.existsSync(path.join(this.dir, name)); }
  clear(name) { try { fs.unlinkSync(path.join(this.dir, name)); } catch {} }
}

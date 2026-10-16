import { USDC, SOL, TOKEN_PROGRAM } from './config.mjs';
import { day } from './util.mjs';
const finite = x => typeof x === 'number' && Number.isFinite(x);
export function screen(t, c, now = Date.now(), slot) {
  if (!t || typeof t.id !== 'string' || [USDC, SOL].includes(t.id)) return 'Unsupported candidate';
  if (t.tokenProgram !== TOKEN_PROGRAM) return 'Token-2022 or unknown token program';
  if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 18) return 'Unknown token decimals';
  if (c.verified && t.isVerified !== true) return 'Provider verification required';
  const created = Date.parse(t.firstPool?.createdAt ?? '');
  if (!Number.isFinite(created) || now - created < c.ageHours * 3600000) return 'Pool too young or age unavailable';
  if (!finite(t.liquidity) || t.liquidity < c.liquidity) return 'Insufficient or unknown liquidity';
  if (!finite(t.holderCount) || t.holderCount < c.holders) return 'Insufficient or unknown holder count';
  if (!finite(t.organicScore) || t.organicScore < c.organic) return 'Organic score too low or unavailable';
  if (t.audit?.mintAuthorityDisabled !== true || t.audit?.freezeAuthorityDisabled !== true) return 'Authority audit failed';
  if (!finite(t.audit?.topHoldersPercentage) || t.audit.topHoldersPercentage > c.topHolders || t.audit.topHoldersPercentage < 0)
    return 'Concentrated holdings or missing concentration audit';
  if (!finite(t.usdPrice) || t.usdPrice <= 0 || !Number.isSafeInteger(t.priceBlockId)) return 'Missing price or price block';
  if (slot !== undefined && (slot - t.priceBlockId > c.priceAgeSlots || t.priceBlockId > slot + 10)) return 'Stale or inconsistent price';
  const h = t.stats1h;
  if (!finite(h?.buyVolume) || !finite(h?.sellVolume) || h.buyVolume < 0 || h.sellVolume < 0 || h.buyVolume + h.sellVolume < c.volume)
    return 'Insufficient or unknown hourly volume';
  return null;
}
export function buyPressure(t,minimum) {
  const m=t.stats5m;
  if(!finite(m?.buyVolume)||!finite(m?.sellVolume)||m.sellVolume<=0||m.buyVolume<0)return false;
  return m.buyVolume/m.sellVolume>=minimum;
}
export class Signals {
  constructor(c) { this.c = c; this.history = new Map(); }
  restore(history,now=Date.now()) {
    for(const [mint,rows] of Object.entries(history||{})) {
      if(Array.isArray(rows)&&rows.length&&rows.every(r=>Number.isFinite(r.at)&&Number.isFinite(r.price)&&r.price>0&&Number.isSafeInteger(r.slot))
        &&now-rows.at(-1).at<=this.c.scanMs*2.5)this.history.set(mint,rows);
    }
  }
  export(){return Object.fromEntries(this.history);}
  observe(t, now = Date.now()) {
    let rows = this.history.get(t.id) || [];
    if (rows.length && rows.at(-1).slot === t.priceBlockId) return { enter: false, reason: 'Price block has not advanced' };
    if (rows.length && (t.priceBlockId < rows.at(-1).slot || now - rows.at(-1).at > this.c.scanMs * 2.5)) rows = [];
    const point={at:now,price:t.usdPrice,slot:t.priceBlockId};
    const sampled=!rows.length||now-rows.at(-1).at>=(this.c.signalSampleMs||5000);
    if(sampled)rows.push(point);
    rows = rows.filter(r => now - r.at <= Math.max(this.c.windowMs,this.c.trendWindowMs)*1.5 + this.c.scanMs);
    this.history.set(t.id, rows);
    if(this.history.size>this.c.candidates){const oldest=[...this.history].sort((a,b)=>a[1].at(-1).at-b[1].at(-1).at);this.history.delete(oldest[0][0]);}
    for (const [mint, old] of this.history) if (now - old.at(-1).at > this.c.windowMs * 3) this.history.delete(mint);
    if(!sampled)rows=[...rows,point];
    if (rows.length < 3 || now - rows[0].at < this.c.windowMs) return { enter: false, reason: 'Collecting momentum window' };
    if(Math.abs(t.usdPrice/rows.at(-2).price-1)*100>this.c.maxJump)return{enter:false,reason:'One-tick price jump exceeds cap'};
    const target=now-this.c.windowMs;
    const base=[...rows].reverse().find(r=>r.at<=target)||rows[0];
    const momentum=(t.usdPrice/base.price-1)*100;
    const strategies=this.c.normalStrategies||['momentum'];
    const rising=t.usdPrice>rows.at(-2).price;
    if(strategies.includes('momentum')&&momentum>=this.c.minMomentum&&momentum<=this.c.maxMomentum&&rising&&buyPressure(t,this.c.buySell))
      return{enter:true,strategy:'momentum',momentum,reason:'Measured momentum and buy pressure'};
    if(now-rows[0].at<this.c.trendWindowMs||rows.length<8)return{enter:false,momentum,reason:'Collecting trend window; momentum not confirmed'};
    const prices=rows.map(r=>r.price),past=prices.slice(0,-1),last=t.usdPrice;
    const ema=(values,minutes)=>values.reduce((a,p,i)=>i===0?p:a+(1-Math.exp(-(rows[i].at-rows[i-1].at)/(minutes*30000)))*(p-a),values[0]);
    const fast=ema(prices,5),slow=ema(prices,15);
    const priorHigh=Math.max(...past),trend=(last/rows[0].price-1)*100;
    if(strategies.includes('breakout')&&last>=priorHigh*(1+this.c.breakoutPct/100)&&last<=priorHigh*(1+this.c.maxMomentum/100)
      &&fast>slow&&buyPressure(t,this.c.buySell))return{enter:true,strategy:'breakout',momentum,reason:'Prior-range breakout with trend and pressure'};
    const priorFast=ema(past,5);
    if(strategies.includes('pullback')&&trend>0.5&&fast>slow&&past.at(-1)<=priorFast&&last>fast&&rising
      &&momentum>=-1&&momentum<=this.c.maxMomentum&&buyPressure(t,Math.max(1,this.c.buySell-0.1)))
      return{enter:true,strategy:'pullback',momentum,reason:'Rebound after pullback inside an upward trend'};
    if(strategies.includes('mean_reversion')) {
      const mean=past.reduce((a,p)=>a+p,0)/past.length;
      const deviation=Math.sqrt(past.reduce((a,p)=>a+(p-mean)**2,0)/past.length);
      const z=deviation?(last-mean)/deviation:0;
      if(Math.abs(trend)<1&&z<=-1.5&&rising&&buyPressure(t,1))return{enter:true,strategy:'mean_reversion',momentum,reason:'Range rebound; experimental strategy'};
    }
    return{enter:false,momentum,reason:'No enabled strategy confirmed an entry'};
  }
}
export function updateRisk(s, c, now = Date.now()) {
  const currentDay = day(now);
  if (s.day !== currentDay) { s.day = currentDay; s.dayStart = s.equity; s.dayEntries = 0; }
  s.highWater = Math.max(s.highWater, s.equity);
  const drawdown = s.highWater - s.equity;
  s.maxDrawdown = Math.max(s.maxDrawdown, drawdown);
  if (drawdown >= c.totalLoss) s.halt ||= 'Total drawdown limit reached';
  if (s.dayStart - s.equity >= c.dailyLoss) s.halt ||= 'Daily loss limit reached';
  return s.halt;
}
export function entryBlock(s, c, mint, now = Date.now()) {
  if (s.halt || s.paused || s.pending) return 'Entries paused or settlement pending';
  if (s.positions.some(p => p.mint === mint)) return 'Already holding this token';
  if ((s.cooldowns[mint] || 0) > now) return 'Token cooldown';
  if (s.positions.length >= c.maxOpen) return 'Open-position limit';
  if (s.dayEntries >= c.maxEntries) return 'Daily entry limit';
  if (s.dayStart - s.equity >= c.dailyLoss || s.highWater - s.equity >= c.totalLoss) return 'Loss budget exhausted';
  return null;
}
export function positionSize(s, c, entryOverhead = 0) {
  const exposure = s.positions.reduce((sum, p) => sum + p.cost, 0);
  // A stop is an estimate, not a guaranteed maximum loss. Whole-position exposure is capped separately.
  const riskSize = c.risk / ((c.stop + c.roundTrip) / 100);
  const remainingLoss = Math.min(c.dailyLoss - (s.dayStart - s.equity), c.totalLoss - (s.highWater - s.equity));
  const lossSize = Math.max(0, remainingLoss) / ((c.stop + c.roundTrip) / 100);
  return Math.floor(Math.max(0, Math.min(c.maxPosition, riskSize, lossSize, c.maxExposure - exposure, s.cash - 1) - entryOverhead) * 100) / 100;
}
export function exitReason(p, c, now = Date.now(), forced = false) {
  if (forced) return 'Manual flatten';
  const pct = (p.mark / p.cost - 1) * 100;
  if (pct <= -c.stop) return 'Stop loss';
  if (pct >= c.take) return 'Take profit';
  if (p.peak >= p.cost * (1 + c.trailStart / 100) && p.mark <= p.peak * (1 - c.trail / 100)) return 'Trailing stop';
  if (now - p.openedAt >= c.holdMs) return 'Maximum holding time';
  return null;
}

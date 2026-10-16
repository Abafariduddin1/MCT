import { USDC, SOL } from './config.mjs';
import { Signals, screen, entryBlock, positionSize, exitReason, updateRisk } from './risk.mjs';
import { usdc, units, haircut, raw, signedRaw, cleanError } from './util.mjs';
import { CopyWatcher } from './copy.mjs';
import { bucketState,bucketLimits,bucketName,recalculateBuckets,allocationCheck,assertPortfolio,applyExit } from './portfolio.mjs';
import { randomUUID } from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {FxReference} from './reference.mjs';
import {WalletStream} from './stream.mjs';
import {WakeSignal} from './wake.mjs';
import {syncSolPaper,movePaperSol,lamports,solUnits,recordLatency} from './paper.mjs';
export class Engine {
  constructor(c, api, chain, store, notifier = async () => {}, services = {}) {
    Object.assign(this, { c, api, chain, store, notifier });
    this.signals = new Signals(c); this.stopping = false; this.solPrice = null; this.solPriceAt = 0;
    this.nextScan = 0; this.nextCopy=0; this.nextMonitor = 0; this.failures = 0;
    this.copy = c.copyPct>0&&c.copyLeader ? new CopyWatcher(c, chain.connection, store,chain.history) : null;
    this.marketBlocked = false;
    this.fx=services.fx||new FxReference();this.WebSocketClass=services.WebSocketClass||globalThis.WebSocket;
    this.wake=new WakeSignal();this.copyHint=null;this.lastCopyFetch=0;this.stream=null;
    this.shortlist=[];this.nextShortlist=0;this.discoveryJob=null;this.discoveryReady=null;this.marketJob=null;this.marketReady=null;
    this.nextSettlement=0;this.nextFinality=0;
    this.notificationTail=Promise.resolve();this.notificationsQueued=0;
  }
  async init() {
    const { c, store } = this;
    if (c.mode === 'live' && !c.liveReady) throw new Error('Live execution requires ENABLE_LIVE_TRADING=true and explicit acknowledgement');
    store.acquire();
    try {
      if (store.exists()) this.s = store.read();
      else if (c.mode === 'paper') {
        if(c.paperBase==='SOL'){
          const ref=await this.readReferences();
          this.solPrice=ref.solUsdc;this.solPriceAt=Date.now();
          this.s=store.create(c.paperBalance,null,ref);this.s.lastSolPrice=ref.solUsdc;
        }else this.s = store.create(c.paperBalance);
      }
      else {
        const balances = await this.chain.balances();
        if (balances.usdc <= 0 || balances.usdc > c.liveCap) throw new Error('Initial wallet USDC balance must be positive and within LIVE_INITIAL_USDC_CAP');
        if (balances.native < c.reserveSol * 1e9) throw new Error('Not enough SOL reserve');
        if (Object.entries(balances.tokens).some(([m, v]) => m !== USDC && v > 0n)) throw new Error('Begin with a dedicated wallet holding only USDC and SOL');
        this.s = store.create(balances.usdc, this.chain.address);
        this.s.observedSolLamports = balances.native; store.save(this.s);
      }
      if (c.mode === 'live' && this.s.wallet !== this.chain.address) throw new Error('Wallet does not match saved live state');
      if (c.mode === 'live' && !this.s.pending) await this.checkWallet();
      allocationCheck(this.s,c);
      if(c.mode==='paper'&&(this.s.paper?.base||'USDC')!==c.paperBase)throw new Error('Paper base differs from saved state; keep its original settings or use a separate data directory');
      this.s.strategy = c.strategy;
      this.signals.restore(this.s.signals);
      if (Number.isFinite(this.s.lastSolPrice) && this.s.lastSolPrice > 0) this.solPrice = this.s.lastSolPrice;
      if(this.s.valuation?.fx?.source?.startsWith('ECB')&&Date.now()-this.s.valuation.fx.fetchedAt<7*86400000)this.fx.value=this.s.valuation.fx;
      if(this.copy){
        try{await this.copy.init(this.s);}catch(error){
          this.s.health.copyError=cleanError(error,c);this.copy=null;
          for(const p of this.s.positions.filter(p=>p.bucket==='copy'))p.copyExitReason='Copy initialization unavailable: '+this.s.health.copyError;
          store.log('copy_unavailable',{reason:this.s.health.copyError,normalTradingContinues:true});
        }
      }
      store.save(this.s);
      store.log('started', { mode: c.mode, strategy: c.strategy, paperBase:this.s.paper?.base, cashUsdc: this.s.cash, positions: this.s.positions.length });
    } catch (error) { store.release(); throw error; }
  }
  async notify(text) {
    if(this.notificationsQueued>=20){this.store.log('notification_skipped',{reason:'Notification queue is full'});return;}
    this.notificationsQueued++;
    this.notificationTail=this.notificationTail.then(async()=>{
      if(this.stopping)return;
      try{await this.notifier(text);}catch{this.store.log('notification_failed');}
    }).finally(()=>{this.notificationsQueued--;});
  }
  get baseMint(){return this.c.mode==='paper'&&this.c.paperBase==='SOL'?SOL:USDC;}
  get solPaper(){return this.baseMint===SOL;}
  async readReferences(tokens=null){
    tokens||=await this.api.tokens([SOL,USDC],4);
    const token=tokens.find(t=>t.id===SOL),stable=tokens.find(t=>t.id===USDC);
    if(!Number.isFinite(token?.usdPrice)||token.usdPrice<=0||!Number.isFinite(stable?.usdPrice)||stable.usdPrice<=0)
      throw new Error('SOL/USDC reference prices unavailable');
    if(Math.abs(stable.usdPrice-1)>0.01)throw new Error('USDC reference deviates more than 1%; entries paused');
    let fx=this.c.eurUsd>0?{eurUsd:this.c.eurUsd,source:'Manual EUR/USD reference',date:new Date().toISOString().slice(0,10),fetchedAt:Date.now()}:null;
    if(this.solPaper&&!fx){
      if(this.fx.value&&Date.now()-Date.parse(this.fx.value.date)<7*86400000){
        fx=this.fx.value;
        if(!this.fxJob){this.fxAbort=new AbortController();this.fxJob=this.fx.get(this.fxAbort.signal)
          .catch(error=>{if(this.s&&!this.stopping)this.s.health.fxError=cleanError(error,this.c);})
          .finally(()=>{this.fxJob=null;this.fxAbort=null;});}
      }else fx=await this.fx.get();
    }
    return{solUsdc:token.usdPrice/stable.usdPrice,usdcUsd:stable.usdPrice,fx};
  }
  async refreshSol(tokens=null){
    if(!tokens&&this.solPrice&&Date.now()-this.solPriceAt<this.c.referenceMs)return;
    try{
      const ref=await this.readReferences(tokens);this.solPrice=ref.solUsdc;this.solPriceAt=Date.now();this.marketBlocked=false;
      this.s.lastSolPrice=this.solPrice;
      this.s.valuation={...this.s.valuation,solUsdc:this.solPrice,usdcUsd:ref.usdcUsd,
        ...(ref.fx?{eurPerUsdc:ref.usdcUsd/ref.fx.eurUsd,fx:ref.fx}:{}),at:new Date().toISOString()};
      syncSolPaper(this.s,this.solPrice);
    }catch(error){this.marketBlocked=true;this.s.paused=true;throw error;}
  }
  quoteValue(amount){return this.solPaper?solUnits(amount)*this.solPrice:units(amount);}
  inputAmount(value){return this.solPaper?lamports(value/this.solPrice):usdc(value);}
  paperRent(mint){return this.solPaper&&this.s.paper.createdTokenAccounts.includes(mint)?0:this.c.paperRent;}
  networkEstimate(q, entry = false) {
    if (this.c.mode === 'paper') return (this.c.paperNetwork + (entry ? this.c.paperRent : 0)) / 1e9 * this.solPrice;
    return (q.signatureFeeLamports + q.prioritizationFeeLamports + q.rentFeeLamports) / 1e9 * this.solPrice;
  }
  async checkWallet() {
    const b = await this.chain.balances();
    if (Math.abs(b.usdc - this.s.cash) > 0.000002) throw new Error('Wallet USDC differs from ledger; external deposits/withdrawals require reconciliation');
    for (const p of this.s.positions) if ((b.tokens[p.mint] || 0n) !== raw(p.amount))
      throw new Error('Wallet token balance differs from saved position');
    if (Object.entries(b.tokens).some(([mint, amount]) => amount > 0n && mint !== USDC && !this.s.positions.some(p => p.mint === mint)))
      throw new Error('Unrecorded wallet holdings require reconciliation');
    if (this.s.observedSolLamports !== null && Math.abs(b.native - this.s.observedSolLamports) > 1)
      throw new Error('Wallet SOL changed outside the recorded transaction; reconcile before trading');
    return b;
  }
  async controls() {
    if (this.store.flag('PAUSE')) this.s.paused = true;
    if (this.store.flag('RESUME')) {
      this.store.clear('RESUME');
      if (this.s.halt) this.store.log('resume_rejected', { reason: this.s.halt });
      else { this.store.clear('PAUSE'); this.s.paused = false; }
    }
    if (this.store.flag('FLATTEN')) this.s.paused = true;
    if(this.s.paused!==this.lastPaused){this.store.save(this.s);this.lastPaused=this.s.paused;}
  }
  async monitor() {
    if (this.s.pending) { await this.settle(); if (this.s.pending) return; }
    const { s, c, api, store } = this;
    try {
      const refs=[api.cachedToken?.(SOL,c.shortlistMs*3),api.cachedToken?.(USDC,c.shortlistMs*3)];
      if(refs.every(Boolean))await this.refreshSol(refs);
      else if(!this.solPrice||!api.cachedToken)await this.refreshSol();
      else this.marketBlocked=Date.now()-this.solPriceAt>c.shortlistMs*3;
    }
    catch (error) {
      this.marketBlocked = true; s.paused = true;
      store.log('reference_price_error', { reason: cleanError(error,c), cachedPriceAvailable: Boolean(this.solPrice) });
      // Preserve exit monitoring with the saved cost reference; never use it for new entries.
      if (!this.solPrice) { store.save(s); throw error; }
    }
    for (const row of [...s.positions]) {
      const p=s.positions.find(position=>position.mint===row.mint);if(!p)continue;
      try {
        const cached=api.cachedToken?.(p.mint,c.shortlistMs*3),ref=s.valuation;
        if(cached&&Number.isFinite(cached.usdPrice)&&ref?.usdcUsd){
          const value=Number(raw(p.amount))/10**p.decimals*cached.usdPrice/ref.usdcUsd;
          p.mark=Math.max(0,value*(1-c.exitSlippage/10000)-c.paperNetwork/1e9*this.solPrice);
          if(this.solPaper){p.markLamports=String(lamports(p.mark/this.solPrice));p.peakLamports=String(raw(p.peakLamports||'0')>raw(p.markLamports)?raw(p.peakLamports):raw(p.markLamports));}
          p.peak=Math.max(p.peak,p.mark);
        }
        const urgent=store.flag('FLATTEN')||s.halt||s.buckets[bucketName(p.bucket)].halt||p.copyExitReason||raw(p.pendingCopySell||'0')>0n||this.positionExitReason(p);
        if(!urgent&&Date.now()-(p.routeAt||0)<c.exitQuoteMs)continue;
        const quoteStarted=performance.now();
        if(raw(p.pendingCopySell||'0')>0n&&!p.copyExitReason&&!store.flag('FLATTEN')&&!s.halt&&!s.buckets[bucketName(p.bucket)].halt&&!this.positionExitReason(p)){
          let amount=raw(p.pendingCopySell);if(amount>raw(p.amount)||p.mark*(1-Number(amount)/Number(raw(p.amount)))<1)amount=raw(p.amount);
          const q=await api.quote(p.mint,this.baseMint,String(amount),c.mode==='live'?this.chain.address:undefined,{side:'sell'});q.preparationStarted=quoteStarted;
          await this.sell(p,q,'Leader proportional sale',String(amount));if(s.pending)break;continue;
        }
        const q = await api.quote(p.mint, this.baseMint, p.amount, c.mode === 'live' ? this.chain.address : undefined,{side:'sell'});
        q.preparationStarted=quoteStarted;
        const out=c.mode === 'paper' ? haircut(q.outAmount, c.paperSlip) : raw(q.otherAmountThreshold);
        const proceeds=this.quoteValue(out);p.routeAt=Date.now();
        if(this.solPaper){const mark=out>BigInt(c.paperNetwork)?out-BigInt(c.paperNetwork):0n;
          p.markLamports=String(mark);p.peakLamports=String(raw(p.peakLamports||'0')>mark?raw(p.peakLamports):mark);}
        p.mark = Math.max(0, proceeds - this.networkEstimate(q));
        p.markAt = Date.now(); p.quoteFailures = 0; p.peak = Math.max(p.peak, p.mark);
        const forced = store.flag('FLATTEN') || Boolean(s.halt) || Boolean(s.buckets[bucketName(p.bucket)].halt);
        const protection=this.positionExitReason(p,forced);
        const hasCopySell=raw(p.pendingCopySell||'0')>0n;
        const reason = protection || p.copyExitReason || (hasCopySell?'Leader proportional sale':null);
        store.log('mark', { mint: p.mint, estimatedNetUsdc: p.mark, pnlPct: (p.mark / p.cost - 1) * 100 });
        if(reason){
          let amount=raw(p.amount);
          if(hasCopySell&&!protection&&!p.copyExitReason){
            amount=raw(p.pendingCopySell);if(amount>raw(p.amount))amount=raw(p.amount);
            if(p.mark*(1-Number(amount)/Number(raw(p.amount)))<1)amount=raw(p.amount);
          }
          await this.sell(p,q,reason,amount.toString());
        }
      } catch (error) {
        if (s.pending) break;
        p.quoteFailures = (p.quoteFailures || 0) + 1;
        // Missing sell routes are not marked at a fictitious unchanged price.
        // After 3 failures use zero as a conservative risk value and halt new entries.
        if (p.quoteFailures >= 3) { p.mark = 0;if(p.base==='SOL')p.markLamports='0';s.halt ||= 'Repeated sell-quote failures; position may be unsellable'; }
        store.log('exit_problem', { mint: p.mint, failures: p.quoteFailures, reason: cleanError(error, c) });
        if (p.quoteFailures === 1 || p.quoteFailures === 3) await this.notify(`Exit problem for ${p.mint}: ${cleanError(error, c)}`);
      }
      if (s.pending) break;
    }
    this.markEquity();
    s.health.lastMonitor=new Date().toISOString();
    if (store.flag('FLATTEN') && !s.positions.length && !s.pending) {
      store.clear('FLATTEN'); store.log('flatten_complete'); await this.notify('All bot positions closed. Entries remain paused.');
    }
    store.save(s);
  }
  positionExitReason(p,forced=false){
    const values=p.base==='SOL'?{...p,cost:solUnits(p.costLamports),mark:solUnits(p.markLamports||'0'),peak:solUnits(p.peakLamports||'0')}:p;
    return exitReason(values,{...this.c,holdMs:p.bucket==='copy'?this.c.copyHoldMs:this.c.holdMs},Date.now(),forced);
  }
  markEquity() {
    const { s } = this;
    syncSolPaper(s,this.solPrice||s.valuation?.solUsdc);
    s.equity = s.cash + s.positions.reduce((sum, p) => sum + p.mark, 0)
      - (this.c.mode === 'live' ? (s.nativeCosts || 0) : 0);
    const wasHalted = s.halt;
    updateRisk(s, this.c);
    recalculateBuckets(s,this.c);assertPortfolio(s,this.c.mode);
    if (!wasHalted && s.halt) { this.store.log('halt', { reason: s.halt, equityUsdc: s.equity }); void this.notify(s.halt); }
  }
  async screeningSlot(){
    // A fresh processed slot is sufficient for a conservative metadata age
    // screen. Actual entry validation still obtains a confirmed RPC slot.
    const health=this.stream?.health;
    if(health?.ready&&Number.isSafeInteger(health.lastSlot)&&Date.now()-health.lastSlotAt<2000)return health.lastSlot;
    return this.chain.connection.getSlot('confirmed');
  }
  async scan(tokens=null,stage='discovery') {
    const { s, c, api, store } = this;
    if (c.normalPct===0 || s.pending || s.halt || s.paused || store.flag('FLATTEN') || store.flag('PAUSE')) return;
    await this.refreshSol();
    if (this.marketBlocked || s.paused) return;
    const slot = await this.screeningSlot();
    tokens ||= await api.candidates();
    const reasons={};let eligible=0,warming=0,attempted=0;
    const reject=(mint,reason)=>{reasons[reason]=(reasons[reason]||0)+1;if(stage!=='shortlist')store.log('reject',{mint,reason});};
    for (const t of tokens.slice(0, c.candidates)) {
      if(stage!=='shortlist')store.log('snapshot', { mint: t.id, price: t.usdPrice, priceBlockId: t.priceBlockId,
        liquidity: t.liquidity, stats5m: t.stats5m, stats1h: t.stats1h, audit: t.audit });
      const rejected = screen(t, c, Date.now(), slot);
      if (rejected) { reject(t.id,rejected); continue; }
      eligible++;
      const signal = this.signals.observe(t);
      if(!signal.enter){if(signal.reason.includes('Collecting'))warming++;reject(t.id,signal.reason);continue;}
      const blocked=this.entryBlocked('normal',t.id);
      if(blocked){reject(t.id,blocked);continue;}
      if(attempted>=1){reject(t.id,'Per-scan entry attempt budget');continue;}
      attempted++;
      try {
        const fresh=api.cachedToken?.(t.id)||(await api.tokens([t.id],3)).find(token=>token.id===t.id);
        await this.tryEntry(fresh,'normal',signal);
      } catch (error) {
        reject(t.id,cleanError(error,c));store.log('entry_problem', { mint: t.id, reason: cleanError(error, c) });
        s.cooldowns[t.id] = Date.now() + c.cooldownMs; store.save(s);
      }
    }
    s.signals=this.signals.export();s.health.lastScan=new Date().toISOString();
    s.diagnostics={...s.diagnostics,[stage]:{candidates:tokens.length,eligible,warming,attempted,reasons,at:new Date().toISOString()},candidates:tokens.length,eligible,warming,attempted,reasons};store.checkpoint(s);
    if(stage!=='shortlist'||Date.now()-(this.lastShortlistLog||0)>=15000){
      store.log('scan_complete', { stage,candidates: tokens.length,eligible,warming,attempted,positions: s.positions.length,reasons });
      if(stage==='shortlist')this.lastShortlistLog=Date.now();
    }
  }
  entryBlocked(name,mint) {
    return (name==='copy'&&this.stream&&!this.stream.health.ready?'Copy stream is not ready':null)
      ||(this.s.finality?.length>=16?'Finality verification queue is full':null)
      ||entryBlock(this.s,this.c,mint)||entryBlock(bucketState(this.s,name),bucketLimits(this.s,this.c,name),mint);
  }
  async tryEntry(t,name,signal) {
    if(!t)throw new Error('Candidate metadata unavailable');
    const blocked=this.entryBlocked(name,t.id);if(blocked)throw new Error(blocked);
    const slot=await this.chain.connection.getSlot('confirmed');
    const invalid=screen(t,this.c,Date.now(),slot);if(invalid)throw new Error(invalid);
    await this.chain.verifyMint(t.id,t.decimals);
    const c=this.c,overhead=(c.mode==='paper'?c.paperNetwork+this.paperRent(t.id):c.networkCap+c.rentCap)/1e9*this.solPrice;
    const size=Math.min(positionSize(this.s,c,overhead),positionSize(bucketState(this.s,name),bucketLimits(this.s,c,name),overhead));
    if(size<1)throw new Error('Strategy budget is below one USDC after costs');
    return this.buy(t,size,{...signal,bucket:name});
  }
  async buy(t, size, signal) {
    const { api, c, s, store } = this;
    const name=signal.bucket||(signal.copyLeader?'copy':'normal');
    const bstate=bucketState(s,name),limits=bucketLimits(s,c,name);
    const started=performance.now(),rent=this.paperRent(t.id);
    const amount = this.inputAmount(size);size=this.quoteValue(amount);
    // Assemble a live order once, without signing or spending until the reverse
    // route and all cost/security checks have passed.
    const buy = await api.quote(this.baseMint, t.id, amount,c.mode==='live'?this.chain.address:undefined,{side:'buy'});
    if (Math.abs(buy.priceImpact) > c.impact) throw new Error('Entry price impact exceeds cap');
    const held = c.mode === 'paper' ? haircut(buy.outAmount, c.paperSlip) : raw(buy.otherAmountThreshold);
    if (held <= 0n) throw new Error('Entry quote yields no tokens');
    if (signal.maxUnitPriceUsdc !== undefined && size / (Number(held) / 10 ** t.decimals) > signal.maxUnitPriceUsdc)
      throw new Error('Copy quote is worse than the allowed leader entry price');
    const reverse = await api.quote(t.id, this.baseMint, held,undefined,{side:'sell'});
    let entryCost = size + (c.paperNetwork + rent) / 1e9 * this.solPrice;
    let exitCost = c.paperNetwork / 1e9 * this.solPrice;
    let output = this.quoteValue(haircut(reverse.outAmount, c.paperSlip));
    if (c.mode === 'live') {
      // Reserve the fee caps until an assembled transaction gives an exact estimate.
      entryCost = size + (c.networkCap + c.rentCap) / 1e9 * this.solPrice;
      exitCost = c.networkCap / 1e9 * this.solPrice;
      output = units(raw(reverse.otherAmountThreshold));
    }
    const drag = (entryCost - (output - exitCost)) / entryCost * 100;
    if (drag > c.roundTrip || (drag>0&&c.take/drag<c.minRewardCost) || entryCost > c.maxPosition || entryCost * (c.stop + c.roundTrip) / 100 > c.risk + 1e-9
        || entryCost > s.cash || entryCost > c.maxExposure - s.positions.reduce((a,p) => a+p.cost, 0))
      throw new Error(`Entry rejected: estimated round-trip drag ${drag.toFixed(2)}% or exposure/cash cap`);
    if(entryCost>bstate.cash||entryCost>limits.maxExposure-bstate.positions.reduce((a,p)=>a+p.cost,0))throw new Error('Entry exceeds its strategy allocation');
    if (Date.now() - buy.receivedAt > 15000 || Date.now() - reverse.receivedAt > 15000)
      throw new Error('Quote expired while checking the reverse route');
    if (signal.expiresAt && Date.now() > signal.expiresAt) throw new Error('Leader signal became too old during quote checks');
    if (store.flag('PAUSE') || store.flag('FLATTEN') || this.entryBlocked(name,t.id)) return;
    if (c.mode === 'paper') {
      const paperNative=amount+BigInt(c.paperNetwork+rent);
      if(this.solPaper){movePaperSol(s,name,-paperNative);if(rent&&!s.paper.createdTokenAccounts.includes(t.id))s.paper.createdTokenAccounts.push(t.id);}
      s.cash -= entryCost;
      s.buckets[name].cash-=entryCost;s.buckets[name].dayEntries++;
      s.positions.push({ id:randomUUID(),mint: t.id,bucket:name,strategy:signal.strategy||'momentum', symbol: String(t.symbol || t.id.slice(0,6)).slice(0,24), decimals: t.decimals,
        amount: held.toString(), cost: entryCost, openedAt: Date.now(), mark: Math.max(0, output - exitCost),
        peak: Math.max(0, output - exitCost), markAt: Date.now(), quoteFailures: 0, entrySignature: null,
        copyLeader: signal.copyLeader || null, leaderSignature: signal.leaderSignature || null,
        ...(this.solPaper?{base:'SOL',costLamports:String(paperNative),markLamports:String(lamports(Math.max(0,output-exitCost)/this.solPrice)),peakLamports:String(lamports(Math.max(0,output-exitCost)/this.solPrice))}:{base:'USDC'}) });
      s.dayEntries++; this.markEquity();recordLatency(s,'paperEntry',performance.now()-started,c.latencyTargetMs,{origin:signal.detectedAt?'copy':'normal',eventToFillMs:signal.detectedAt?Date.now()-signal.detectedAt:null});store.save(s);
      store.log('buy', { mode: c.mode,bucket:name,strategy:signal.strategy, mint: t.id, inputUsdc: size, totalCostUsdc: entryCost, amount: held.toString(), momentumPct: signal.momentum });
      await this.notify(`PAPER buy ${t.symbol || t.id}: ${size.toFixed(2)} USDC; cost ${entryCost.toFixed(2)} USDC.`);
    } else {
      const b = await this.checkWallet();
      const q=buy;
      const prepared = await this.chain.prepare(q, 'buy', t.id, amount);
      if (store.flag('PAUSE') || store.flag('FLATTEN')) return;
      const finalBlock=this.entryBlocked(name,t.id);if(finalBlock)throw new Error(finalBlock);
      if (signal.expiresAt && Date.now() > signal.expiresAt) throw new Error('Leader signal became too old during transaction validation');
      const pending = { ...prepared, side: 'buy',bucket:name,strategy:signal.strategy||'momentum',copyLeader:signal.copyLeader||null,leaderSignature:signal.leaderSignature||null,
        mint: t.id, symbol: String(t.symbol || t.id.slice(0,6)).slice(0,24),
        decimals: t.decimals, amount: amount.toString(), submittedAt: Date.now(), solPrice: this.solPrice,
        beforeUsdc: b.usdc, beforeNative: b.native, beforeToken: String(b.tokens[t.id] || 0n), checks: 0 };
      pending.detectedAt=signal.detectedAt||null;pending.preparationMs=performance.now()-started;
      await this.submit(pending);
    }
  }
  requestCopyExit(event,signature,persist=true,detectedAt=Date.now()) {
    const p=this.s.positions.find(p=>p.mint===event.mint&&p.bucket==='copy'&&p.copyLeader===this.c.copyLeader);
    if(!p){const pending=this.s.pending;if(pending?.side==='buy'&&pending.bucket==='copy'&&pending.mint===event.mint){pending.copySells||=[];if(pending.copySells.length<50)pending.copySells.push({event,signature,detectedAt});else this.s.halt||='Too many copy exits while buy unresolved';}return;}
    p.copyExitDetectedAt=Math.min(p.copyExitDetectedAt||detectedAt,detectedAt);
    if(this.c.copyExitPolicy==='full'){p.copyExitReason='Leader sold or reduced position';}
    else{
      const before=raw(event.leaderBefore),sold=raw(event.tokenAmount);
      if(before<=0n||sold>before){p.copyExitReason='Leader sale fraction unavailable';}
      else{
        const total=raw(p.amount),queued=raw(p.pendingCopySell||'0');
        const remaining=total-queued,additional=remaining*sold/before;
        p.pendingCopySell=(queued+additional).toString();
      }
    }
    if(persist){this.store.save(this.s);this.store.log('copy_exit_requested',{mint:p.mint,signature,policy:this.c.copyExitPolicy});}
  }
  async sell(p, q, reason,amount=p.amount) {
    const { s, c, store } = this;
    const started=q.preparationStarted??performance.now();
    if(amount!==p.amount&&q.inAmount!==String(amount))q=await this.api.quote(p.mint,this.baseMint,amount,c.mode==='live'?this.chain.address:undefined,{side:'sell'});
    if (c.mode === 'paper') {
      const nativeReceived=haircut(q.outAmount,c.paperSlip);
      const received = this.quoteValue(nativeReceived);
      const network = this.networkEstimate(q);
      this.close(p, received, network, reason, null,amount,this.solPaper?{received:String(nativeReceived),network:String(c.paperNetwork)}:null);
      recordLatency(s,'paperExit',performance.now()-started,c.latencyTargetMs,{eventToFillMs:p.copyExitDetectedAt?Date.now()-p.copyExitDetectedAt:null});store.save(s);
    } else {
      const b = await this.checkWallet();
      const prepared = await this.chain.prepare(q, 'sell', p.mint, amount);
      await this.submit({ ...prepared, side: 'sell',bucket:bucketName(p.bucket), mint: p.mint, amount, reason,
        submittedAt: Date.now(), solPrice: this.solPrice, beforeUsdc: b.usdc, beforeNative: b.native,
        beforeToken: String(b.tokens[p.mint] || 0n), checks: 0,preparationMs:performance.now()-started,detectedAt:p.copyExitDetectedAt||null });
    }
  }
  close(p, received, network, reason, signature,amount=p.amount,native=null) {
    const { s, store, c } = this;
    const record=applyExit(s,c.mode,p,amount,received,network,reason,signature,Date.now(),native);
    const pnl=record.pnl;
    if(record.positionClosed)s.cooldowns[p.mint]=Date.now()+c.cooldownMs;
    this.markEquity(); store.save(s);
    store.log('sell', { mint: p.mint, netPnlUsdc: pnl, reason, signature });
    void this.notify(`${c.mode.toUpperCase()} sell ${p.symbol}: net P&L ${pnl.toFixed(2)} USDC (${reason}).`);
  }
  async submit(pending) {
    const { s, store } = this;
    if (s.pending) throw new Error('Another transaction is unresolved');
    const signed = pending.signedTransaction;
    // Never put signed transaction bytes or wallet secrets in state/logs.
    delete pending.signedTransaction;
    s.pending = pending;
    if (pending.side === 'buy') {s.dayEntries++;s.buckets[bucketName(pending.bucket)].dayEntries++;}
    store.save(s); // Durable intent exists before any network submission.
    if(Number.isFinite(pending.preparationMs))recordLatency(s,'liveSubmissionPreparation',pending.preparationMs,this.c.latencyTargetMs,{side:pending.side,eventToSubmissionMs:pending.detectedAt?Date.now()-pending.detectedAt:null});store.save(s);
    store.log('submitted', { side: pending.side, mint: pending.mint, signature: pending.signature });
    try {
      const result = await this.api.execute(signed, pending.requestId);
      if (result.signature && result.signature !== pending.signature) throw new Error('Execution returned an unexpected signature');
      store.log('execute_response', { status: result.status, code: result.code });
    } catch (error) { store.log('execution_unknown', { reason: cleanError(error, this.c), signature: pending.signature }); }
    // Treat every response as provisional; confirmed on-chain balances are authoritative.
    await this.settle();
  }
  async settle() {
    const { s, store, c } = this;
    const p = s.pending;
    if (!p) return;
    const result = await this.chain.settlement(p,c.liveCommitment);
    if (result.kind === 'pending') {
      p.checks++;
      if (p.checks === 4) await this.notify(`Settlement pending for ${p.signature}. New orders are blocked.`);
      // A missing status after final expiry can be cancelled only if all relevant balances are unchanged.
      if (await this.chain.connection.getBlockHeight('finalized') > p.lastValidBlockHeight + 32) {
        const b = await this.chain.balances();
        if (Math.abs(b.usdc - p.beforeUsdc) < 0.000001 && b.native === p.beforeNative && String(b.tokens[p.mint] || 0n) === p.beforeToken) {
          s.pending = null; s.cooldowns[p.mint] = Date.now() + c.cooldownMs;
          store.log('expired_unexecuted', { signature: p.signature });
        } else {
          s.halt ||= 'Expired transaction has changed balances but no confirmed record; manual reconciliation needed';
        }
      }
      store.save(s); return;
    }
    const network = result.nativeSpent / 1e9 * p.solPrice;
    if (!Number.isFinite(network)) throw new Error('Missing fee valuation on pending transaction');
    // Build the complete next ledger separately. Save once before notifications or logs.
    // A failed write leaves both memory and disk at the original pending intent.
    const next = structuredClone(s);
    let event, message;
    if (result.kind === 'failed') {
      next.nativeCosts = (next.nativeCosts || 0) + network;
      next.failedCosts += network;
      next.cooldowns[p.mint] = Date.now() + c.cooldownMs;
      next.buckets[bucketName(p.bucket)].cash-=network;
      event = ['transaction_failed', { signature: p.signature, costUsdc: network }];
      message = `Transaction failed; estimated SOL cost ${network.toFixed(4)} USDC.`;
    } else if (p.side === 'buy') {
      const spent = -units(result.usdcDelta), got = signedRaw(result.tokenDelta);
      if (spent <= 0 || got <= 0n || Math.abs(spent - units(p.amount)) > 0.000002) throw new Error('Confirmed entry amount differs from request');
      next.cash -= spent;
      next.buckets[bucketName(p.bucket)].cash-=spent+network;
      // Actual network + rent remain costs even if some rent could be reclaimed later.
      next.nativeCosts = (next.nativeCosts || 0) + network;
      if(p.minimum&&got<raw(p.minimum))throw new Error('Confirmed buy is below the saved minimum output');
      next.positions.push({ id:randomUUID(),mint: p.mint,bucket:bucketName(p.bucket),strategy:p.strategy||'momentum',copyLeader:p.copyLeader||null,
        leaderSignature:p.leaderSignature||null, symbol: p.symbol, decimals: p.decimals, amount: got.toString(),
        cost: spent + network, openedAt: Date.now(), mark: spent, peak: spent, markAt: 0, quoteFailures: 0,
        entrySignature: p.signature });
      event = ['buy', { mode: c.mode, mint: p.mint, inputUsdc: spent, totalCostUsdc: spent + network, signature: p.signature }];
      message = `LIVE buy ${p.symbol}: ${spent.toFixed(2)} USDC. ${p.signature}`;
    } else {
      const position = next.positions.find(x => x.mint === p.mint);
      const received = units(result.usdcDelta);
      if (!position || -signedRaw(result.tokenDelta) !== raw(p.amount) || raw(p.amount)>raw(position.amount) || received <= 0)
        throw new Error('Confirmed exit amount differs from position');
      if(p.minimum&&signedRaw(result.usdcDelta)<raw(p.minimum))throw new Error('Confirmed sale is below the saved minimum output');
      const record=applyExit(next,'live',position,p.amount,received,network,p.reason,p.signature);
      const pnl=record.pnl;
      if(record.positionClosed)next.cooldowns[p.mint]=Date.now()+c.cooldownMs;
      event = ['sell', { mint:p.mint, netPnlUsdc:pnl, reason:p.reason, signature:p.signature }];
      message = `LIVE sell ${position.symbol}: net P&L ${pnl.toFixed(2)} USDC (${p.reason}).`;
    }
    next.observedSolLamports = p.beforeNative - result.nativeSpent;
    next.pending = null;
    if(result.confirmation==='confirmed'){
      next.finality||=[];next.finality.push({intent:{...p},result:{...result},recordedAt:Date.now()});
    }
    if(p.side==='buy'&&result.kind==='success'&&p.copySells?.length){
      const position=next.positions.find(x=>x.mint===p.mint);let queued=0n,total=raw(position.amount);
      for(const {event}of p.copySells){
        if(c.copyExitPolicy==='full'){position.copyExitReason='Leader sold while copy buy was awaiting confirmation';break;}
        const before=raw(event.leaderBefore),sold=raw(event.tokenAmount);
        if(before<=0n||sold>before){position.copyExitReason='Leader exit fraction unavailable';break;}
        queued+=(total-queued)*sold/before;
      }
      position.pendingCopySell=String(queued);
      position.copyExitDetectedAt=Math.min(...p.copySells.map(r=>r.detectedAt||Date.now()));
    }
    next.equity = next.cash + next.positions.reduce((sum, position) => sum + position.mark, 0) - (next.nativeCosts || 0);
    updateRisk(next,c);
    recalculateBuckets(next,c);assertPortfolio(next,c.mode);
    store.save(next);
    // Copy polling holds this object across monitor/entry calls. A finalized fill
    // must keep that reference alive so later claims and coverage are persisted.
    const copyState=s.copy;
    Object.assign(s,next);
    if(copyState&&next.copy){Object.assign(copyState,next.copy);s.copy=copyState;}
    store.log(...event); await this.notify(message);
    await this.checkWallet();
  }
  async verifyFinality(){
    const row=this.s.finality?.[0];if(!row)return;
    const result=await this.chain.settlement(row.intent,'finalized');
    if(result.kind==='pending'){
      if(await this.chain.connection.getBlockHeight('finalized')>row.intent.lastValidBlockHeight+32){
        this.s.halt||='A confirmed fill lost finality; manual reconciliation required';this.s.paused=true;this.store.save(this.s);
      }return;
    }
    if(['kind','nativeSpent','usdcDelta','tokenDelta'].some(k=>result[k]!==row.result[k])){
      this.s.halt||='Finalized fill differs from the confirmed ledger';this.s.paused=true;this.store.save(this.s);throw new Error(this.s.halt);
    }
    this.s.finality.shift();this.s.health.lastFinality=new Date().toISOString();this.store.save(this.s);
    this.store.log('fill_finalized',{signature:row.intent.signature});
  }
  startStream(){
    if(!this.copy||!this.c.wsEnabled)return;
    this.stream=new WalletStream(this.c,this.c.copyLeader,hint=>{
      this.copyHint=this.copyHint?{...hint,detectedAt:Math.min(this.copyHint.detectedAt,hint.detectedAt)}:hint;
      this.wake.wake();
    },health=>{
      const wasReady=this.s.health.stream?.ready;this.s.health.stream=health;this.s.streamUsage={...this.stream.usage};
      if(!health.ready)this.streamLostAt||=Date.now();else{
        this.streamLostAt=null;
        if(!wasReady){this.copyHint={slot:0,detectedAt:Date.now(),kind:'stream_reconnect'};this.nextCopy=0;}
      }
      this.wake.wake();
    },this.WebSocketClass);
    if(this.s.streamUsage?.day===new Date().toISOString().slice(0,10))this.stream.usage={...this.s.streamUsage};
    this.stream.start();
  }
  launchDiscovery(){
    if(this.discoveryJob)return;
    this.discoveryAbort=new AbortController();
    this.discoveryJob=this.api.candidates(this.discoveryAbort.signal)
      .then(tokens=>{if(!this.stopping)this.discoveryReady={tokens};},error=>{if(!this.stopping)this.discoveryReady={error};})
      .finally(()=>{this.discoveryJob=null;this.discoveryAbort=null;this.wake.wake();});this.nextScan=Date.now()+this.c.scanMs;
  }
  launchMarket(){
    if(this.marketJob)return;
    const ids=[...new Set([SOL,USDC,...this.s.positions.map(p=>p.mint),...this.shortlist])].slice(0,100);
    this.marketAbort=new AbortController();
    this.marketJob=this.api.tokens(ids,10,true,this.marketAbort.signal)
      .then(tokens=>{if(!this.stopping)this.marketReady={tokens};},error=>{if(!this.stopping)this.marketReady={error};})
      .finally(()=>{this.marketJob=null;this.marketAbort=null;this.wake.wake();});this.nextShortlist=Date.now()+this.c.shortlistMs;
  }
  async step(){
    await this.controls();
    if(this.stream?.stopped&&this.stream.usage.day!==new Date().toISOString().slice(0,10))this.stream.start();
    if(this.streamLostAt&&Date.now()-this.streamLostAt>5000){
      for(const p of this.s.positions.filter(p=>p.bucket==='copy'))p.copyExitReason||='Copy stream unavailable for more than five seconds';
    }
    if(Date.now()>=this.nextSettlement&&this.s.pending){await this.settle();this.nextSettlement=Date.now()+500;return;}
    if(Date.now()>=this.nextFinality&&this.s.finality?.length){await this.verifyFinality();this.nextFinality=Date.now()+500;return;}
    // Launch due read-only work before ready-result branches return. These
    // requests share a fair API queue; financial mutations remain serialized.
    if(!this.discoveryJob&&!this.discoveryReady&&Date.now()>=this.nextScan&&this.c.normalPct>0&&!this.s.pending&&!this.s.paused&&!this.s.halt)this.launchDiscovery();
    if(!this.marketJob&&!this.marketReady&&Date.now()>=this.nextShortlist)this.launchMarket();
    if(this.marketReady){const result=this.marketReady;this.marketReady=null;
      if(result.error)throw result.error;
      await this.refreshSol(result.tokens);this.marketBlocked=false;
      this.s.health.lastMarket=new Date().toISOString();this.latestMarket=result.tokens;this.nextMonitor=0;
    }
    if(Date.now()>=this.nextMonitor){await this.monitor();this.nextMonitor=Date.now()+this.c.monitorMs;}
    if(this.copy&&!this.s.halt&&((this.copyHint&&Date.now()-this.lastCopyFetch>=this.c.copyFetchCooldownMs)||Date.now()>=this.nextCopy)){
      const hint=this.copyHint;this.copyHint=null;this.lastCopyFetch=Date.now();
      await this.copy.poll(this,hint);this.nextCopy=Date.now()+this.c.copyPollMs;
      // Processed notifications can arrive before the confirmed history index.
      // Keep a bounded hint retry until coverage catches up, without busy polling.
      if(hint&&((this.s.copy.coveredThroughSlot||this.s.copy.nextSlot-1)<hint.slot||Date.now()-hint.detectedAt<this.c.copyIndexWaitMs)
        &&Date.now()-hint.detectedAt<this.c.copyMaxAgeMs&&!this.s.copy.blocked)this.copyHint=hint;
      return;
    }
    if(this.discoveryReady){const result=this.discoveryReady;this.discoveryReady=null;
      if(result.error)throw result.error;
      const slot=await this.screeningSlot();
      this.shortlist=result.tokens.filter(t=>!screen(t,this.c,Date.now(),slot)).slice(0,this.c.shortlistSize).map(t=>t.id);
      this.s.market={candidateCount:result.tokens.length,shortlist:this.shortlist,discoveredAt:new Date().toISOString()};
      await this.scan(result.tokens,'discovery');return;
    }
    if(this.latestMarket){const tokens=this.latestMarket;this.latestMarket=null;
      const selected=tokens.filter(t=>this.shortlist.includes(t.id));
      if(selected.length)await this.scan(selected,'shortlist');return;
    }
  }
  async run(){
    await this.init();this.startStream();
    try{
      while(!this.stopping){
        try{await this.step();this.failures=0;}
        catch(error){this.failures++;this.s.health.lastError={at:new Date().toISOString(),reason:cleanError(error,this.c)};
          this.store.log('cycle_error',{reason:cleanError(error,this.c),consecutive:this.failures});
          if(this.failures>=3){this.s.halt||='Repeated API or reconciliation errors';this.store.save(this.s);}
          await this.wake.wait(Math.min(1000,100*this.failures));
        }
        // A coalesced copy hint gets its own due time even if the configured
        // idle scheduler wait is longer than the fetch cooldown.
        const wait=this.copyHint&&this.copy&&!this.s.halt
          ?Math.max(1,Math.min(this.c.loopMs,this.lastCopyFetch+this.c.copyFetchCooldownMs-Date.now())):this.c.loopMs;
        await this.wake.wait(wait);
      }
    }finally{this.stream?.stop();this.discoveryAbort?.abort();this.marketAbort?.abort();this.fxAbort?.abort();
      try{await Promise.allSettled([this.discoveryJob,this.marketJob,this.fxJob].filter(Boolean));this.store.save(this.s);}
      finally{this.store.release();}
      console.log('Stopped. Open positions remain saved; no automatic sale on Ctrl+C.');}
  }
}

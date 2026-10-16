import { PublicKey } from '@solana/web3.js';
import { SOL, USDC } from './config.mjs';
import { raw, cleanError, day } from './util.mjs';
import { HistorySource } from './history.mjs';
import { isSwapInstruction } from './venues.mjs';
import {performance} from 'node:perf_hooks';
import {recordLatency} from './paper.mjs';

const keyString = key => typeof key === 'string' ? key : key?.toBase58?.();

// Deliberately narrow: signed, successful known-venue swaps with one non-base asset.
// Transfers, airdrops, LP operations, multiple-asset bundles and unknown layouts are skipped.
export function parseLeaderSwap(tx, leader) {
  if (!tx?.meta || tx.meta.err || !Number.isSafeInteger(tx.blockTime)) return null;
  const message = tx.transaction?.message;
  const keys = message?.accountKeys;
  if (!Array.isArray(keys)) return null;
  const walletIndex = keys.findIndex(k => keyString(k.pubkey) === leader && k.signer === true);
  if (walletIndex < 0) return null;
  const instructions = [...(message.instructions || []), ...(tx.meta.innerInstructions || []).flatMap(x => x.instructions || [])];
  if (!instructions.some(isSwapInstruction)) return null;
  const before = tx.meta.preTokenBalances, after = tx.meta.postTokenBalances;
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  // Missing ownership metadata makes attribution ambiguous.
  if ([...before,...after].some(r => !r.owner || !Number.isInteger(r.accountIndex))) return null;
  const amounts = new Map(), decimals = new Map(), owned = new Set();
  for (const [rows, sign] of [[before,-1n],[after,1n]]) {
    for (const row of rows) {
      if (row.owner !== leader) continue;
      if (!Number.isInteger(row.uiTokenAmount?.decimals) || row.uiTokenAmount.decimals < 0 || row.uiTokenAmount.decimals > 18) return null;
      if (decimals.has(row.mint) && decimals.get(row.mint) !== row.uiTokenAmount.decimals) return null;
      decimals.set(row.mint,row.uiTokenAmount.decimals); owned.add(row.accountIndex);
      try { amounts.set(row.mint,(amounts.get(row.mint) || 0n) + sign * raw(row.uiTokenAmount.amount)); }
      catch { return null; }
    }
  }
  for (const index of owned) {
    const pre = before.find(r => r.accountIndex === index), post = after.find(r => r.accountIndex === index);
    if ((pre && pre.owner !== leader) || (post && post.owner !== leader)) return null;
  }
  const candidates = [...amounts].filter(([mint, delta]) => ![USDC,SOL].includes(mint) && delta !== 0n);
  if (candidates.length !== 1) return null;
  const [mint, tokenDelta] = candidates[0];
  if (decimals.get(USDC) !== undefined && decimals.get(USDC) !== 6) return null;
  let nativeDelta = 0n;
  try {
    const delta = index => {
      const pre = tx.meta.preBalances[index], post = tx.meta.postBalances[index];
      if (!Number.isSafeInteger(pre) || !Number.isSafeInteger(post)) throw new Error('Invalid lamports');
      return BigInt(post) - BigInt(pre);
    };
    nativeDelta = delta(walletIndex);
    // Include owned token-account lamports to neutralise ATA rent and include wrapped SOL.
    for (const index of owned) if (index !== walletIndex) nativeDelta += delta(index);
    if (walletIndex === 0) {
      if (!Number.isSafeInteger(tx.meta.fee) || tx.meta.fee < 0) return null;
      nativeDelta += BigInt(tx.meta.fee);
    }
  } catch { return null; }
  const stableDelta = amounts.get(USDC) || 0n;
  const baseMint = stableDelta !== 0n ? USDC : SOL;
  const baseDelta = stableDelta !== 0n ? stableDelta : nativeDelta;
  // A sizeable simultaneous SOL movement in a USDC trade is not a simple swap.
  if (baseMint === USDC && (nativeDelta > 100000n || nativeDelta < -100000n)) return null;
  if (baseDelta === 0n || (tokenDelta > 0n) === (baseDelta > 0n)) return null;
  const leaderBefore=before.filter(r=>r.owner===leader&&r.mint===mint).reduce((sum,r)=>sum+raw(r.uiTokenAmount.amount),0n);
  return { side:tokenDelta > 0n ? 'buy' : 'sell', mint, decimals:decimals.get(mint), baseMint,leaderBefore:leaderBefore.toString(),
    baseAmount:(baseDelta < 0n ? -baseDelta : baseDelta).toString(),
    tokenAmount:(tokenDelta < 0n ? -tokenDelta : tokenDelta).toString(), at:tx.blockTime * 1000 };
}

export class CopyWatcher {
  constructor(c,connection,store,source=new HistorySource(c)) {
    this.c=c;this.store=store;this.source=source;this.leader=new PublicKey(c.copyLeader).toBase58();
  }
  async init(s) {
    if(s.copy&&s.copy.leader!==this.leader){
      if(s.positions.some(p=>p.bucket==='copy'))throw new Error('Close copied positions before changing COPY_LEADER');
      s.copy=null;
    }
    if(s.copy)return;
    const slot=await this.source.slot();
    if(!Number.isSafeInteger(slot)||slot<0)throw new Error('Invalid history baseline slot');
    s.copy={leader:this.leader,cursor:null,startedAt:Date.now(),baselineSlot:slot+1,nextSlot:slot+1,scan:null,seen:[],claimSlots:{},
      creditDay:day(),estimatedCredits:0,blocked:null,lastPoll:null,signals:0,skipped:0};
    this.store.save(s);this.store.log('copy_baseline',{leader:this.leader,nextSlot:slot+1,futureOnly:true});
  }
  block(engine,reason) {
    const s=engine.s;s.copy.blocked=reason;
    // A stream gap affects the copy sleeve, not independent normal trading.
    for(const p of s.positions.filter(p=>p.bucket==='copy'))p.copyExitReason='Copy tracking unavailable: '+reason;
    this.store.save(s);this.store.log('copy_blocked',{reason});
  }
  async poll(engine,hint=null) {
    const {c,store}=this;const s=engine.s,state=s.copy;
    if(s.halt)return;
    if(state.creditDay!==day()){state.creditDay=day();state.estimatedCredits=0;}
    if(store.flag('RESUME_COPY')){
      store.clear('RESUME_COPY');state.blocked=null;
    }
    if(state.blocked)return;
    try{
      if(!state.scan){
        const toSlot=await this.source.slot();
        const fromSlot=Math.max(state.baselineSlot||state.nextSlot,state.nextSlot-c.copyOverlap);
        if(toSlot<fromSlot||(toSlot<state.nextSlot&&!hint))return;
        state.scan={fromSlot,toSlot,token:null,createdAt:Date.now()};store.save(s);
      }
      let accepted=0;
      for(let page=0;page<c.copyPages;page++){
        if(engine.stopping)break;
        if(state.estimatedCredits+10>c.copyCreditBudget){this.block(engine,'Daily history-credit budget reached');return;}
        state.estimatedCredits+=10;store.save(s); // conservative reservation before the request
        const scan=state.scan;
        const response=await this.source.page(this.leader,scan.fromSlot,scan.toSlot,scan.token);
        if(!Array.isArray(response.data)||response.data.length>c.copyPage)throw new Error('Invalid filtered-history response');
        if(response.data.length&&response.data.some(tx=>!Number.isSafeInteger(tx.slot)||tx.slot<scan.fromSlot||tx.slot>scan.toSlot))
          throw new Error('History result is outside the requested coverage interval');
        const rows=[...response.data].sort((a,b)=>a.slot-b.slot||(a.transactionIndex||0)-(b.transactionIndex||0));
        for(const tx of rows){
          if(engine.stopping)break;
          if(s.positions.length&&Date.now()>=engine.nextMonitor){await engine.monitor();engine.nextMonitor=Date.now()+c.monitorMs;}
          const signature=tx.transaction?.signatures?.[0];
          if(typeof signature!=='string')throw new Error('History transaction has no signature');
          if(state.seen.includes(signature))continue;
          const event=parseLeaderSwap(tx,this.leader);
          if(state.seen.length>=5000)throw new Error('Copy claim history exceeds its bounded coverage window');
          state.seen.push(signature);state.claimSlots||={};state.claimSlots[signature]=tx.slot;state.cursor=signature;
          if(event?.side==='sell'){engine.requestCopyExit(event,signature,false,hint?.detectedAt||Date.now());engine.nextMonitor=0;engine.wake?.wake();}
          store.save(s); // claim before entry; a crash may miss a fill, never duplicate it
          if(!event){state.skipped++;continue;}
          state.signals++;
          store.log('copy_signal',{signature,...event,leaderAt:event.at});
          if(event.side==='sell')continue;
          const expiresAt=event.at+c.copyMaxAgeMs;
          if(Date.now()>expiresAt||event.at>Date.now()+10000){state.skipped++;store.log('copy_skip',{signature,reason:'Stale or future-dated leader buy'});continue;}
          if(accepted>=c.copyBatch){state.skipped++;store.log('copy_skip',{signature,reason:'Entry processing budget; exits still observed'});continue;}
          accepted++;
          try{
            const blocked=engine.entryBlocked('copy',event.mint);if(blocked)throw new Error(blocked);
            const started=performance.now();
            await engine.refreshSol();
            if(engine.marketBlocked||s.paused)throw new Error('Reference feed or pause blocks entries');
            const cached=engine.api.cachedToken?.(event.mint);const t=cached||(await engine.api.tokens([event.mint],3)).find(token=>token.id===event.mint);
            if(!t||t.decimals!==event.decimals)throw new Error('Leader token metadata mismatch');
            const base=Number(raw(event.baseAmount))/(event.baseMint===USDC?1e6:1e9)*(event.baseMint===USDC?1:engine.solPrice);
            const tokenUnits=Number(raw(event.tokenAmount))/10**event.decimals;
            const maxUnitPriceUsdc=base/tokenUnits*(1+c.copyWorse/100);
            if(!Number.isFinite(maxUnitPriceUsdc)||maxUnitPriceUsdc<=0)throw new Error('Invalid leader reference price');
            await engine.tryEntry(t,'copy',{strategy:'copy',copyLeader:this.leader,leaderSignature:signature,expiresAt,maxUnitPriceUsdc,detectedAt:hint?.detectedAt||Date.now()});
            recordLatency(s,'validatedCopyHandling',performance.now()-started,c.latencyTargetMs,{signature,sourceCommitment:c.copyCommitment});
          }catch(error){state.skipped++;store.log('copy_skip',{signature,reason:cleanError(error,c)});}
        }
        if(engine.stopping){store.save(s);return;}
        const token=response.paginationToken;
        if(token!==null&&token!==undefined&&typeof token!=='string')throw new Error('Invalid history pagination token');
        if(token&&token===scan.token)throw new Error('History pagination did not advance');
        if(token){state.scan.token=token;store.save(s);}
        else{
          state.nextSlot=scan.toSlot+1;state.coveredThroughSlot=scan.toSlot;state.scan=null;
          const earliest=Math.max(state.baselineSlot||0,state.nextSlot-c.copyOverlap)-4;
          state.seen=state.seen.filter(sig=>{if(state.claimSlots?.[sig]<earliest){delete state.claimSlots[sig];return false;}return true;});
          store.save(s);break;
        }
      }
      state.lastPoll=new Date().toISOString();store.save(s);
      store.log('copy_poll_complete',{signals:state.signals,skipped:state.skipped,estimatedCredits:state.estimatedCredits,
        backlog:Boolean(state.scan),positions:s.positions.filter(p=>p.bucket==='copy').length});
      if(state.scan&&Date.now()-state.scan.createdAt>c.copyMaxAgeMs&&s.positions.some(p=>p.bucket==='copy')){
        this.block(engine,'History backlog is incomplete; cannot rely on leader exits');
      }
    }catch(error){this.block(engine,cleanError(error,c));}
  }
}

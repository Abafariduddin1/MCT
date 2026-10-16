import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { config, requireConnections, USDC, SOL } from './config.mjs';
import { Jupiter } from './api.mjs';
import { Chain, ata } from './chain.mjs';
import { Engine } from './engine.mjs';
import { Store } from './store.mjs';
import { summary, cleanError } from './util.mjs';
import { screen } from './risk.mjs';
import { HistorySource } from './history.mjs';
import { parseLeaderSwap } from './copy.mjs';
import { assertPortfolio } from './portfolio.mjs';
import {WalletStream} from './stream.mjs';
import {FxReference} from './reference.mjs';
import {solUnits} from './paper.mjs';
import {performance} from 'node:perf_hooks';
const command = process.argv[2] || 'run';
const c = config();
async function notify(message) {
  if (!c.telegramToken || !c.telegramChat) return;
  const response = await fetch(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: c.telegramChat, text: message.slice(0,4000), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000), redirect: 'error'
  });
  if (!response.ok) throw new Error('Telegram notification failed');
}
async function main() {
  const store = new Store(c);
  if (command === 'wallet') {
    const walletFile = path.resolve(process.argv[3] || './wallet.json');
    const wallet = Keypair.generate();
    const fd = fs.openSync(walletFile, 'wx', 0o600); // Never overwrite an existing key.
    try { fs.writeFileSync(fd, JSON.stringify([...wallet.secretKey])); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    console.log(`Wallet address: ${wallet.publicKey.toBase58()}\nPrivate key saved to ${walletFile}. Keep this file private and backed up.`);
    return;
  }
  if (['pause','resume','flatten','resume-copy'].includes(command)) {
    fs.mkdirSync(c.dataDir, { recursive: true });
    fs.writeFileSync(path.join(c.dataDir, { pause: 'PAUSE', resume: 'RESUME', flatten: 'FLATTEN','resume-copy':'RESUME_COPY' }[command]), '', { mode: 0o600 });
    console.log(command === 'flatten' ? 'Flatten requested. Leave the bot running until all positions close.' : `${command} requested for ${c.mode} mode.`);
    return;
  }
  if (['status','export'].includes(command)) {
    if (!store.exists()) { console.log(`No ${c.mode} state yet. Run the bot first.`); return; }
    const state = store.read();
    if (command === 'status') console.log(JSON.stringify(summary(state), null, 2));
    else {
      const file = path.join(c.dataDir, 'trades.csv');
      const fields = ['positionId','bucket','strategy','base','mint','symbol','openedAt','closedAt','amount','cost','received','exitNetworkCost','pnl','costSol','receivedSol','exitNetworkSol','pnlSol','pnlEur','positionClosed','reason','entrySignature','exitSignature'];
      const safeCell = value => {
        let s = String(value ?? '');
        if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // Keep token labels from becoming spreadsheet formulas.
        return '"' + s.replaceAll('"','""') + '"';
      };
      fs.writeFileSync(file, [fields.join(','), ...state.trades.map(t => fields.map(f => safeCell(t[f])).join(','))].join('\n') + '\n', { mode: 0o600 });
      console.log(`Exported ${state.trades.length} closed trades to ${file}`);
    }
    return;
  }
  if(command==='allocate'){
    const normal=Number(process.argv[3]),copy=Number(process.argv[4]);
    if(!Number.isFinite(normal)||!Number.isFinite(copy)||normal<0||copy<0||normal+copy>100)throw new Error('Use: npm.cmd run allocate -- NORMAL_PERCENT COPY_PERCENT');
    store.acquire();try{
      const state=store.read();if(state.positions.length||state.pending||state.finality.length)throw new Error('Allocation changes require a stopped bot, no positions and no pending transaction or finality records');
      if(c.mode==='live'){
        requireConnections(c);const chain=new Chain(c);const engine=new Engine(c,new Jupiter(c),chain,store);engine.s=state;await engine.checkWallet();
      }
      const liquid=state.cash-(c.mode==='live'?(state.nativeCosts||0):0);
      if(state.paper?.base==='SOL'){
        const total=BigInt(state.paper.cashLamports),n=total*BigInt(Math.round(normal*1000))/100000n,cp=total*BigInt(Math.round(copy*1000))/100000n;
        state.paper.buckets={normal:String(n),copy:String(cp),reserve:String(total-n-cp)};
      }
      for(const [name,pct] of [['normal',normal],['copy',copy],['reserve',100-normal-copy]]){
        const b=state.buckets[name],next=state.paper?.base==='SOL'?solUnits(state.paper.buckets[name])*state.valuation.solUsdc:liquid*pct/100,difference=next-b.cash;
        b.pct=pct;b.cash=next;b.equity=next;b.dayStart+=difference;b.highWater=Math.max(next,b.highWater+difference);
        b.initialEquity=state.initialEquity*pct/100;
      }
      assertPortfolio(state,c.mode);store.save(state);
      console.log(`Allocation saved. Set NORMAL_ALLOCATION_PCT=${normal} and COPY_ALLOCATION_PCT=${copy} in .env before restarting. Global loss history and halts were retained.`);
    }finally{store.release();}return;
  }
  if (!['doctor','run','diagnose','leader-check','preflight','feed-check','latency'].includes(command)) throw new Error('Unknown command. See README commands.');
  requireConnections(c);
  for (const mint of c.watchlist) new PublicKey(mint);
  const api = new Jupiter(c);
  if(command==='feed-check'){
    if(!c.copyLeader)throw new Error('Set COPY_LEADER');
    const result=await WalletStream.probe(c,c.copyLeader);console.log(JSON.stringify({readOnly:true,...result,note:'Checks subscriptions; does not prove real trade latency.'},null,2));
    if(!result.ready)process.exitCode=1;return;
  }
  if(command==='latency'){
    const started=performance.now(),rpc=new Chain({...c,mode:'paper'});const measures={};
    let at=performance.now();await rpc.connection.getSlot('confirmed');measures.rpcMs=performance.now()-at;
    at=performance.now();const tokens=await api.tokens([SOL,USDC]);measures.metadataMs=performance.now()-at;
    at=performance.now();const buy=await api.quote(USDC,SOL,'1000000',undefined,{side:'buy'});measures.buyQuoteMs=performance.now()-at;
    at=performance.now();await api.quote(SOL,USDC,buy.otherAmountThreshold,undefined,{side:'sell'});measures.reverseQuoteMs=performance.now()-at;
    console.log(JSON.stringify({readOnly:true,targetMs:c.latencyTargetMs,...measures,totalMs:performance.now()-started,
      referenceSolUsd:tokens.find(t=>t.id===SOL)?.usdPrice,note:'Includes rate-limit waits. No signing/submission/fill or latency guarantee.'},null,2));return;
  }
  if(command==='leader-check'){
    if(!c.copyLeader)throw new Error('Set COPY_LEADER to a public address');new PublicKey(c.copyLeader);
    const source=new HistorySource(c),slot=await source.slot();
    const data=await source.page(c.copyLeader,Math.max(0,slot-1500),slot);
    const events=data.data.map(tx=>parseLeaderSwap(tx,c.copyLeader)).filter(Boolean);
    console.log(JSON.stringify({leader:c.copyLeader,transactions:data.data.length,supportedSwaps:events.length,
      recentSignals:events.slice(-10),moreHistory:Boolean(data.paginationToken),note:'Read-only sample; this does not verify a 400-day profit record.'},null,2));return;
  }
  if(command==='preflight'){
    const mint=process.argv[3],size=Number(process.argv[4]||'1');
    if(!mint||!Number.isFinite(size)||size<1||size>c.maxPosition)throw new Error('Use: npm.cmd run preflight -- MINT USDC_AMOUNT (1 to position cap)');
    new PublicKey(mint);
    const chain=new Chain({...c,mode:'live',liveReady:true,liveAck:'I_ACCEPT_REAL_TRADES'});
    const token=(await api.tokens([mint])).find(t=>t.id===mint);
    const reason=screen(token,c,Date.now(),await chain.connection.getSlot('confirmed'));if(reason)throw new Error(reason);
    await chain.verifyMint(mint,token.decimals);
    const q=await api.quote(USDC,mint,String(Math.floor(size*1e6)),chain.address);
    const result=await chain.prepare(q,'buy',mint,String(Math.floor(size*1e6)));
    console.log(`DRY RUN: signing and simulation passed for ${size} USDC. Transaction was NOT submitted. Signature: ${result.signature}`);return;
  }
  const chain = new Chain(c);
  if(command==='diagnose'){
    const slot=await chain.connection.getSlot('confirmed'),tokens=await api.candidates(),reasons={},eligible=[];
    for(const t of tokens){const reason=screen(t,c,Date.now(),slot);if(reason)reasons[reason]=(reasons[reason]||0)+1;else eligible.push({mint:t.id,symbol:t.symbol});}
    console.log(JSON.stringify({examined:tokens.length,securityEligible:eligible.length,reasons,eligible,
      note:'Eligible tokens still require a strategy signal, affordable reverse quote and remaining budget; no order submitted.'},null,2));return;
  }
  if (command === 'doctor') {
    const [slot, tokens] = await Promise.all([chain.connection.getSlot('confirmed'), api.tokens([SOL, USDC])]);
    const sol = tokens.find(t => t.id === SOL);
    if (!sol || !Number.isFinite(sol.usdPrice)) throw new Error('Token API did not provide a SOL price');
    const quote = await api.quote(USDC, SOL, '1000000'); // A quote request does not spend money.
    console.log(`RPC connected at slot ${slot}. Jupiter token and order APIs responding.\nMode: ${c.mode}. SOL indicative USD price: ${sol.usdPrice}.\nOne-USDC quote output: ${quote.outAmount} raw SOL units.`);
    if (c.mode === 'live') {
      const b = await chain.balances();
      console.log(`Bot wallet: ${chain.address}\nUSDC: ${b.usdc}; SOL: ${b.native / 1e9}\nUSDC account: ${ata(chain.address, USDC).toBase58()}`);
    }
    console.log('Doctor checks connections only. It does not prove the strategy is profitable or submit a transaction.');
    if(c.mode==='paper'&&c.paperBase==='SOL'){
      const fx=c.eurUsd?{eurUsd:c.eurUsd,source:'Manual reference'}:await new FxReference().get();console.log(`SOL paper EUR/USD reference: ${fx.eurUsd} (${fx.source}).`);
    }
    if(c.copyPct>0&&c.copyLeader){
      try{const source=new HistorySource(c),slot=await source.slot();await source.page(c.copyLeader,slot,slot);
        console.log('Filtered copy history RPC is responding, with transaction version 1 read support.');}
      catch(error){console.log('Copy history check failed: '+cleanError(error,c)+'; copy entries will be unavailable.');}
      if(c.wsEnabled){const result=await WalletStream.probe(c,c.copyLeader);console.log(result.ready?'Standard copy WebSocket subscriptions responding.':'Copy stream check failed: '+(result.error||'not ready'));}
    }
    return;
  }
  const engine = new Engine(c, api, chain, store, notify);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { engine.stopping = true;engine.wake.wake(); });
  await engine.run();
}
main().catch(error => { console.error(cleanError(error, c)); process.exitCode = 1; });

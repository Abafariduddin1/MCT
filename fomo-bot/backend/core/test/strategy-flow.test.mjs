import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Keypair} from '@solana/web3.js';
import {config,USDC,SOL} from '../src/config.mjs';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {Signals} from '../src/risk.mjs';
import {summary} from '../src/util.mjs';
import {assertPortfolio} from '../src/portfolio.mjs';
import {mint,token,quote} from './helpers.mjs';

async function automaticFlow(mode){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'strategy-flow-'));
  const c=config({MODE:mode,ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES',DATA_DIR:root,NORMAL_STRATEGIES:'momentum'});
  const wallet=Keypair.generate().publicKey.toBase58();let price=1,block=1000,executions=0,prepared=null;const orders=[];
  let balance={usdc:20,native:20000000,tokens:{[USDC]:20000000n}};
  const api={candidates:async()=>[token(mint,price,block)],tokens:async ids=>ids.includes(SOL)?[{id:SOL,usdPrice:100},{id:USDC,usdPrice:1}]:[token(mint,price,block)],
    quote:async(i,o,a,taker)=>{orders.push({input:i,output:o,taker});return quote(i,o,a,price,taker);},execute:async()=>{executions++;return{signature:prepared.signature,status:'Success'};}};
  const chain={address:wallet,connection:{getSlot:async()=>block+5,getBlockHeight:async()=>100},verifyMint:async()=>{},
    balances:async()=>balance,prepare:async(q,side,_mint,amount)=>{prepared={signature:side+'-signature',requestId:'request',lastValidBlockHeight:99999,
      signedTransaction:'mock-signed-bytes',minimum:q.otherAmountThreshold};return prepared;},
    settlement:async pending=>{
      const amount=BigInt(pending.amount),network=56000;
      const stable=pending.side==='buy'?-amount:BigInt(Math.floor(Number(amount)*price));
      const tokens=pending.side==='buy'?BigInt(Math.floor(Number(amount)/price)):-amount;
      balance={usdc:balance.usdc+Number(stable)/1e6,native:balance.native-network,
        tokens:{[USDC]:balance.tokens[USDC]+stable,[mint]:(balance.tokens[mint]||0n)+tokens}};
      return{kind:'success',nativeSpent:network,usdcDelta:String(stable),tokenDelta:String(tokens)};
    }};
  const store=new Store(c),e=new Engine(c,api,chain,store);const actualNow=Date.now;let now=actualNow();Date.now=()=>now;
  try{
    await e.init();await e.refreshSol();
    for(let i=0;i<4;i++){now+=i===0?0:60000;price=1+i*0.003;block++;await e.scan();}
    assert.equal(e.s.positions.length,1,'automatic scan must create a position after measured valid momentum');
    assert.equal(e.s.positions[0].strategy,'momentum');assert.equal(e.s.positions[0].bucket,'normal');
    assert.equal(e.s.buckets.copy.cash,e.s.initialEquity*0.3);assert.equal(e.s.buckets.reserve.cash,e.s.initialEquity*0.2);
    assert.ok(e.s.diagnostics.eligible>0);assert.ok(e.s.diagnostics.attempted>0);
    if(mode==='live'){assert.equal(orders.length,2,'entry needs one assembled order and one reverse-liquidity quote');assert.equal(orders[0].taker,wallet);assert.equal(orders[1].taker,undefined);}
    const initialCopy=e.s.buckets.copy.cash,initialReserve=e.s.buckets.reserve.cash;
    now+=60000;price=1.4;block++;await e.monitor();
    assert.equal(e.s.positions.length,0);assert.equal(e.s.trades.length,1);assert.equal(e.s.trades[0].reason,'Take profit');
    assert.equal(e.s.buckets.copy.cash,initialCopy);assert.equal(e.s.buckets.reserve.cash,initialReserve);
    assertPortfolio(e.s,mode);assert.equal(store.read().pending,null);
    if(mode==='live'){assert.equal(executions,2);assert.equal(e.s.trades[0].entrySignature,'buy-signature');assert.equal(e.s.trades[0].exitSignature,'sell-signature');}
    else assert.equal(executions,0);
  }finally{Date.now=actualNow;store.release();fs.rmSync(root,{recursive:true,force:true});}
}
test('automatic paper scan produces a buy and later a costed sell through the full engine',()=>automaticFlow('paper'));
test('live-mode engine routes a valid buy and sell through submission and finalized settlement using mocks',()=>automaticFlow('live'));

test('buy-pressure rejection does not erase the observed price history',()=>{
  const c=config({NORMAL_STRATEGIES:'momentum'}),s=new Signals(c),start=Date.now();
  for(let i=0;i<4;i++){
    const t=token(mint,1+i*0.003,1000+i);if(i===1)t.stats5m={buyVolume:100,sellVolume:200};
    const signal=s.observe(t,start+i*60000);if(i===3)assert.equal(signal.enter,true);
  }
});
test('breakout uses the prior range, while a one-tick pump is refused',()=>{
  const c=config({NORMAL_STRATEGIES:'breakout'}),s=new Signals(c),start=Date.now();
  let signal;
  for(let i=0;i<=10;i++)signal=s.observe(token(mint,i===10?1.004:1+(i%2)*0.0005,1000+i),start+i*60000);
  assert.equal(signal.enter,true);assert.equal(signal.strategy,'breakout');
  assert.equal(s.observe(token(mint,1.2,1011),start+11*60000).enter,false);
});
test('experimental range reversion is explicit and allocation totals cannot overbook capital',()=>{
  assert.throws(()=>config({NORMAL_ALLOCATION_PCT:'80',COPY_ALLOCATION_PCT:'40'}),/100/);
  assert.throws(()=>config({NORMAL_STRATEGIES:'mean_reversion'}),/EXPERIMENTAL/);
  const settings=config({NORMAL_STRATEGIES:'mean_reversion',ENABLE_EXPERIMENTAL_MEAN_REVERSION:'true'});
  assert.equal(settings.normalStrategies[0],'mean_reversion');
  const signals=new Signals(settings),start=Date.now();let rebound;
  const prices=[1,1.006,1.004,1.002,1.005,1.003,1.004,1.002,1.006,0.991,0.992];
  for(let i=0;i<prices.length;i++)rebound=signals.observe(token(mint,prices[i],1000+i),start+i*60000);
  assert.equal(rebound.enter,true);assert.equal(rebound.strategy,'mean_reversion');
});
test('pullback confirms a rebound inside an upward trend rather than demanding a new high',()=>{
  const c=config({NORMAL_STRATEGIES:'pullback'}),signals=new Signals(c),start=Date.now();
  const prices=[1,1.002,1.004,1.006,1.008,1.012,1.014,1.013,1.008,1.007,1.012];let result;
  for(let i=0;i<prices.length;i++)result=signals.observe(token(mint,prices[i],1000+i),start+i*60000);
  assert.equal(result.enter,true);assert.equal(result.strategy,'pullback');
});
test('a security-ineligible scan reports the rejection and never submits an order',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reject-scan-')),c=config({DATA_DIR:root});const store=new Store(c);
  let calls=0;const bad={...token(),isVerified:false};
  const api={candidates:async()=>[bad],tokens:async()=>[{id:SOL,usdPrice:100},{id:USDC,usdPrice:1}],quote:async()=>{calls++;throw Error('Must not quote');}};
  const e=new Engine(c,api,{connection:{getSlot:async()=>1005}},store);
  try{await e.init();await e.scan();assert.equal(calls,0);assert.equal(e.s.positions.length,0);
    assert.equal(e.s.diagnostics.reasons['Provider verification required'],1);assert.equal(e.s.diagnostics.eligible,0);
  }finally{store.release();fs.rmSync(root,{recursive:true,force:true});}
});
test('performance counts completed positions instead of inflating wins with partial exits',()=>{
  const s={mode:'paper',strategy:'hybrid',cash:200,equity:201,initialEquity:200,maxDrawdown:0,positions:[],trades:[
    {positionId:'a',pnl:1,positionClosed:false,strategy:'copy'},{positionId:'a',pnl:-2,positionClosed:true,strategy:'copy'},
    {positionId:'b',pnl:2,positionClosed:true,strategy:'momentum'}]};
  const report=summary(s);assert.equal(report.trades,2);assert.equal(report.exitFills,3);assert.equal(report.winRatePct,50);
  assert.equal(report.byStrategy.copy.winRatePct,0);assert.equal(report.byStrategy.copy.netRealisedUsdc,-1);
  assert.ok(report.winRate95Pct[0]<50&&report.winRate95Pct[1]>50);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {config,SOL,USDC} from '../src/config.mjs';import {Store} from '../src/store.mjs';import {Engine} from '../src/engine.mjs';
import {assertPortfolio} from '../src/portfolio.mjs';import {summary} from '../src/util.mjs';import {FxReference} from '../src/reference.mjs';
import {mint,token} from './helpers.mjs';
async function setup(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sol-paper-'));
  const c=config({MODE:'paper',PAPER_BASE:'SOL',EUR_USD_REFERENCE:'1.1',DATA_DIR:root});
  let solPrice=100,tokenPrice=1,block=1000;const routes=[];
  const api={tokens:async ids=>ids.map(id=>id===SOL?{id,usdPrice:solPrice}:id===USDC?{id,usdPrice:1}:token(id,tokenPrice,block)),
    candidates:async()=>[token(mint,tokenPrice,block)],quote:async(i,o,a)=>{
      routes.push([i,o]);const out=i===SOL?BigInt(Math.floor(Number(a)/1e9*solPrice/tokenPrice*1e6)):BigInt(Math.floor(Number(a)/1e6*tokenPrice/solPrice*1e9));
      return{inAmount:String(a),outAmount:String(out),otherAmountThreshold:String(out*9950n/10000n),priceImpact:0.1,receivedAt:Date.now()};
    },execute:async()=>{throw Error('Paper cannot submit');}};
  const chain={connection:{getSlot:async()=>block+5},verifyMint:async()=>{}};const store=new Store(c),engine=new Engine(c,api,chain,store);await engine.init();
  return{c,root,store,engine,api,routes,set tokenPrice(v){tokenPrice=v;},set solPrice(v){solPrice=v;},set block(v){block=v;},cleanup(){store.release();fs.rmSync(root,{recursive:true,force:true});}};
}
test('SOL paper begins with EUR-valued virtual native balance and isolated exact-lamport budgets',async()=>{
  const f=await setup();try{
    assert.equal(f.engine.s.paper.initialSol,2.2);assert.ok(Math.abs(f.engine.s.cash-220)<0.000001);assert.ok(Math.abs(summary(f.engine.s).estimatedEquityEur-200)<0.000001);
    assert.equal(f.engine.s.paper.buckets.normal,'1100000000');assert.equal(f.engine.s.paper.buckets.copy,'660000000');assert.equal(f.engine.s.paper.buckets.reserve,'440000000');
    assertPortfolio(f.engine.s,'paper');assert.equal(f.store.read().version,4);
  }finally{f.cleanup();}
});
test('SOL paper automatically buys and sells via SOL pairs, books rent/fees and survives restart',async()=>{
  const f=await setup(),original=Date.now;let now=original();Date.now=()=>now;
  try{
    for(let i=0;i<4;i++){now+=i?60000:0;f.tokenPrice=1+i*0.003;f.block=1000+i;await f.engine.scan();}
    assert.equal(f.engine.s.positions.length,1);assert.equal(f.engine.s.positions[0].base,'SOL');assert.ok(f.routes.every(([i,o])=>i===SOL||o===SOL));
    assert.equal(f.engine.s.paper.buckets.reserve,'440000000');assert.equal(f.engine.s.paper.buckets.copy,'660000000');
    f.store.release();const restarted=new Engine(f.c,f.api,{connection:{getSlot:async()=>1010},verifyMint:async()=>{}},new Store(f.c));await restarted.init();
    now+=60000;f.tokenPrice=1.4;await restarted.monitor();
    assert.equal(restarted.s.positions.length,0);assert.equal(restarted.s.trades.length,1);assert.ok(restarted.s.trades[0].pnlSol>0);
    assert.ok(restarted.s.trades[0].pnlEur>0);assertPortfolio(restarted.s,'paper');assert.equal(restarted.store.read().trades.length,1);restarted.store.release();
  }finally{Date.now=original;f.cleanup();}
});
test('SOL partial exits retain exact remaining native cost basis and never touch another sleeve',async()=>{
  const f=await setup();try{
    await f.engine.buy(token(),7,{bucket:'copy',strategy:'copy'});const p=f.engine.s.positions[0],whole=BigInt(p.amount),cost=BigInt(p.costLamports);
    const amount=whole/5n,q=await f.api.quote(mint,SOL,String(amount));await f.engine.sell(p,q,'trim',String(amount));
    const left=f.engine.s.positions[0];assert.equal(BigInt(left.amount),whole-amount);assert.equal(BigInt(left.costLamports),cost-cost*amount/whole);
    assert.equal(f.engine.s.trades[0].positionClosed,false);assert.equal(f.engine.s.paper.buckets.normal,'1100000000');assert.equal(f.engine.s.paper.buckets.reserve,'440000000');
    assertPortfolio(f.engine.s,'paper');
  }finally{f.cleanup();}
});
test('idle SOL reprices in EUR without fabricating a realised trading profit',async()=>{
  const f=await setup();try{
    f.solPrice=105;f.engine.solPriceAt=0;await f.engine.refreshSol();f.engine.markEquity();const r=summary(f.engine.s);
    assert.equal(r.cashSol,2.2);assert.equal(r.estimatedEquitySol,2.2);assert.equal(r.realisedTradingPnlSol,0);
    assert.ok(Math.abs(r.estimatedEquityEur-210)<0.000001);assert.equal(f.engine.s.paper.cashLamports,'2200000000');
  }finally{f.cleanup();}
});
test('SOL paper fee history charges first token-account rent only once for a reused mint',async()=>{
  const f=await setup();try{
    await f.engine.buy(token(),7,{bucket:'normal'});const p=f.engine.s.positions[0];await f.engine.sell(p,await f.api.quote(mint,SOL,p.amount),'close');
    delete f.engine.s.cooldowns[mint];const before=BigInt(f.engine.s.paper.cashLamports);await f.engine.buy(token(),7,{bucket:'normal'});
    assert.equal(before-BigInt(f.engine.s.paper.cashLamports),70000000n+BigInt(f.c.paperNetwork));assertPortfolio(f.engine.s,'paper');
  }finally{f.cleanup();}
});
test('ECB reference parser accepts current USD rate and refuses stale/invalid data',async()=>{
  const date=new Date().toISOString().slice(0,10);const good=new FxReference(async()=>({ok:true,text:async()=>`<Cube time='${date}'><Cube currency='USD' rate='1.1'/></Cube>`}));
  assert.equal((await good.get()).eurUsd,1.1);
  const stale=new FxReference(async()=>({ok:true,text:async()=>"<Cube time='2020-01-01'><Cube currency='USD' rate='1.1'/></Cube>"}));await assert.rejects(stale.get(),/stale/);
});

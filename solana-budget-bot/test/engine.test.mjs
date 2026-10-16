import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, USDC } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
function fixture(mode = 'paper') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-bot-test-'));
  const c = config({ MODE: mode, DATA_DIR: dir, MAX_POSITION_USDC:'20', RISK_PER_TRADE_USDC:'2', MAX_ROUND_TRIP_COST_PCT: '10', PAPER_ENTRY_RENT_LAMPORTS: '0' });
  const store = new Store(c);
  return { c, store, dir, cleanup() { store.release(); fs.rmSync(dir,{ recursive:true, force:true }); } };
}
function q(input,output,amount,out) {
  return { inputMint:input,outputMint:output,inAmount:String(amount),outAmount:String(out),
    otherAmountThreshold:String(BigInt(out)*9950n/10000n),priceImpact:0.1,receivedAt:Date.now() };
}
test('paper flow uses executable quotes, charges costs, survives restart and records a real simulated loss', async () => {
  const f = fixture();
  try {
    let selling = false;
    const api = { quote: async (input,output,amount) => input === USDC
      ? q(input,output,amount,1000000n)
      : q(input,output,amount,selling ? 6000000n : 9940000n) };
    const engine = new Engine(f.c,api,{},f.store);
    await engine.init(); engine.solPrice = 100; engine.solPriceAt = Date.now();
    await engine.buy({ id:'mint',symbol:'TEST',decimals:6 },10,{ momentum:1 });
    assert.equal(engine.s.positions.length,1);
    assert.ok(engine.s.cash < 190);
    f.store.release();
    const restarted = new Engine(f.c,api,{},new Store(f.c));
    await restarted.init(); restarted.solPrice = 100; restarted.solPriceAt = Date.now();
    assert.equal(restarted.s.positions[0].amount,'997000');
    selling = true; await restarted.monitor();
    assert.equal(restarted.s.positions.length,0);
    assert.equal(restarted.s.trades.length,1);
    assert.ok(restarted.s.trades[0].pnl < -4);
    assert.equal(restarted.s.trades[0].reason,'Stop loss');
    assert.ok(Math.abs(restarted.s.cash - (200 + restarted.s.trades[0].pnl)) < 1e-9);
    restarted.store.release();
  } finally { f.cleanup(); }
});
test('unknown live execution persists intent and blocks replacement orders after restart', async () => {
  const f = fixture('live');
  try {
    let attempts = 0;
    const chain = { address: 'wallet', settlement: async () => ({ kind:'pending' }), connection: { getBlockHeight: async () => 100 } };
    const api = { execute: async () => { attempts++; throw new Error('timeout'); } };
    const e = new Engine(f.c,api,chain,f.store);
    e.s = f.store.create(20,'wallet');
    await e.submit({ side:'buy',mint:'mint',amount:'1000000',signature:'sig',signedTransaction:'secret-bytes',
      requestId:'id',lastValidBlockHeight:200,beforeUsdc:20,beforeNative:10000000,beforeToken:'0',checks:0 });
    assert.equal(attempts,1);
    const saved = f.store.read();
    assert.equal(saved.pending.signature,'sig');
    assert.equal(saved.pending.signedTransaction,undefined);
    assert.equal(saved.dayEntries,1);
    const restarted = new Engine(f.c,api,chain,f.store); restarted.s = saved;
    await restarted.settle(); assert.equal(attempts,1); assert.ok(restarted.s.pending);
  } finally { f.cleanup(); }
});
test('live equity deducts SOL fees once and failed fees count towards loss limits', () => {
  const f = fixture('live');
  try {
    const e = new Engine(f.c,{}, {},f.store); e.s = f.store.create(20,'wallet');
    e.s.cash = 10; e.s.nativeCosts = 0.2; e.s.buckets.normal.cash = 20*e.c.normalPct/100 - 10.2;
    e.s.positions = [{ mint:'mint',symbol:'T',amount:'1000000',cost:10.2,mark:9.8,openedAt:Date.now() }];
    e.markEquity(); assert.ok(Math.abs(e.s.equity - 19.6) < 1e-9);
    e.close(e.s.positions[0],11,0.01,'test','sig'); e.markEquity();
    assert.ok(Math.abs(e.s.equity - 20.79) < 1e-9);
    assert.ok(Math.abs(e.s.trades[0].pnl - 0.79) < 1e-9);
    e.s.nativeCosts += 6; e.s.buckets.normal.cash -= 6; e.markEquity(); assert.match(e.s.halt,/Daily/);
  } finally { f.cleanup(); }
});
test('three unavailable sell routes halt entries and retain the unsold position', async () => {
  const f = fixture();
  try {
    const e = new Engine(f.c,{ quote:async () => { throw new Error('No route'); } },{},f.store);
    await e.init(); e.solPrice = 100; e.solPriceAt = Date.now();
    e.s.cash = 190; e.s.buckets.normal.cash -= 10; e.s.positions = [{ mint:'mint',amount:'100',cost:10,mark:10,peak:10,openedAt:Date.now() }];
    await e.monitor(); await e.monitor(); await e.monitor();
    assert.equal(e.s.positions.length,1); assert.equal(e.s.trades.length,0);
    assert.match(e.s.halt,/sell-quote/); assert.equal(e.s.positions[0].mark,0);
  } finally { f.cleanup(); }
});
test('a second process cannot share an accounting directory', () => {
  const f = fixture();
  try { f.store.acquire(); assert.throws(() => new Store(f.c).acquire(),/lock/); } finally { f.cleanup(); }
});
test('an expired unknown transaction clears only when wallet balances are unchanged', async () => {
  const f = fixture('live');
  try {
    let changed = true;
    const chain = { settlement:async () => ({kind:'pending'}), connection:{getBlockHeight:async () => 300},
      balances:async () => ({usdc:changed ? 19 : 20,native:10000000,tokens:{mint:0n}}) };
    const e = new Engine(f.c,{},chain,f.store); e.s = f.store.create(20,'wallet');
    e.s.pending = {side:'buy',mint:'mint',signature:'sig',lastValidBlockHeight:200,beforeUsdc:20,beforeNative:10000000,beforeToken:'0',checks:0};
    await e.settle(); assert.ok(e.s.pending); assert.match(e.s.halt,/changed balances/);
    changed = false; await e.settle(); assert.equal(e.s.pending,null); assert.ok(e.s.halt);
  } finally { f.cleanup(); }
});
test('confirmed sales accept negative token deltas and survive repeated settlement checks', async () => {
  const f = fixture('live');
  try {
    const chain = { address:'wallet', settlement:async () => ({kind:'success',nativeSpent:56000,usdcDelta:'11000000',tokenDelta:'-1000000'}),
      balances:async () => ({usdc:21,native:9944000,tokens:{[USDC]:21000000n}}) };
    const e = new Engine(f.c,{},chain,f.store); e.s = f.store.create(20,'wallet');
    e.s.cash = 10; e.s.nativeCosts = 0.2; e.s.buckets.normal.cash = 20*e.c.normalPct/100 - 10.2;
    e.s.positions = [{mint:'mint',symbol:'T',amount:'1000000',cost:10.2,mark:10,peak:10,openedAt:Date.now()}];
    e.s.pending = {side:'sell',mint:'mint',signature:'sale',reason:'test',amount:'1000000',beforeNative:10000000,solPrice:100};
    f.store.save(e.s);
    await e.settle(); await e.settle();
    assert.equal(e.s.pending,null); assert.equal(e.s.positions.length,0); assert.equal(e.s.trades.length,1);
    assert.ok(Math.abs(e.s.trades[0].pnl - 0.7944) < 1e-9);
    const restored = f.store.read(); assert.equal(restored.trades.length,1); assert.equal(restored.cash,21);
  } finally { f.cleanup(); }
});
test('a failed settlement save cannot apply a fill twice in memory or on restart', async () => {
  const f = fixture('live');
  try {
    const chain = { address:'wallet',settlement:async () => ({kind:'success',nativeSpent:56000,usdcDelta:'-1000000',tokenDelta:'100'}),
      balances:async () => ({usdc:19,native:9944000,tokens:{[USDC]:19000000n,mint:100n}}) };
    const e = new Engine(f.c,{},chain,f.store); e.s = f.store.create(20,'wallet');
    e.s.pending = {side:'buy',mint:'mint',symbol:'T',decimals:6,amount:'1000000',signature:'buy',beforeNative:10000000,solPrice:100};
    f.store.save(e.s);
    const save = f.store.save.bind(f.store); let failOnce = true;
    f.store.save = state => { if(failOnce) {failOnce=false;throw new Error('disk failure');} save(state); };
    await assert.rejects(e.settle(),/disk failure/);
    assert.equal(e.s.cash,20); assert.equal(e.s.positions.length,0); assert.ok(e.s.pending);
    assert.equal(f.store.read().cash,20);
    await e.settle(); await e.settle();
    assert.equal(e.s.cash,19); assert.equal(e.s.positions.length,1); assert.equal(f.store.read().positions.length,1);
  } finally { f.cleanup(); }
});
test('reference-price outage pauses entries but keeps cached-reference protective exits running', async () => {
  const f = fixture();
  try {
    const api = {tokens:async () => {throw new Error('price feed down');},quote:async (i,o,a) => q(i,o,a,6000000)};
    const e = new Engine(f.c,api,{},f.store); await e.init(); e.solPrice=100; e.solPriceAt=0;
    e.s.cash=190; e.s.buckets.normal.cash -= 10; e.s.positions=[{mint:'mint',amount:'100',symbol:'T',cost:10,mark:10,peak:10,openedAt:Date.now()}];
    await e.monitor();
    assert.equal(e.s.positions.length,0); assert.equal(e.s.trades[0].reason,'Stop loss'); assert.equal(e.s.paused,true);
  } finally { f.cleanup(); }
});
test('all-in entry cost cannot bypass the position ceiling or sizing-risk budget', async () => {
  const f = fixture();
  try {
    const api = {quote:async (i,o,a) => q(i,o,a,i===USDC ? 1000000 : 19900000)};
    const e = new Engine(f.c,api,{},f.store); await e.init(); e.solPrice=100;e.solPriceAt=Date.now();
    await assert.rejects(e.buy({id:'mint',symbol:'T',decimals:6},20,{momentum:1}),/Entry rejected/);
    assert.equal(e.s.positions.length,0);
  } finally { f.cleanup(); }
});
test('live start is blocked before wallet inspection or execution', async () => {
  const f = fixture('live');
  try {
    const e = new Engine(f.c,{}, {balances:async () => {throw new Error('should not be called');}},f.store);
    await assert.rejects(e.init(),/Live execution requires/);
    assert.equal(f.store.exists(),false);
  } finally { f.cleanup(); }
});
test('expired and worsened copy quotes cannot create a paper position',async()=>{
  const f=fixture();try{
    let stale=false;
    const api={quote:async(i,o,a)=>({...q(i,o,a,i===USDC?1000000:9940000),receivedAt:Date.now()-(stale?20000:0)})};
    const e=new Engine(f.c,api,{},f.store);await e.init();e.solPrice=100;e.solPriceAt=Date.now();
    const token={id:'mint',symbol:'T',decimals:6};
    await assert.rejects(e.buy(token,10,{maxUnitPriceUsdc:1}),/worse/);
    stale=true;await assert.rejects(e.buy(token,10,{}),/expired/);
    stale=false;await assert.rejects(e.buy(token,10,{expiresAt:Date.now()-1}),/too old/);
    assert.equal(e.s.positions.length,0);assert.equal(e.s.cash,200);
  }finally{f.cleanup();}
});
test('a leader signal expiring during live validation cannot be submitted',async()=>{
  const f=fixture('live'),actualNow=Date.now;let now=actualNow(),submissions=0,validated=false;Date.now=()=>now;
  try{
    const api={quote:async(i,o,a)=>q(i,o,a,i===USDC?1000000:4975000),execute:async()=>{submissions++;}};
    const chain={address:'wallet',balances:async()=>({usdc:20,native:10000000,tokens:{[USDC]:20000000n}}),
      prepare:async()=>{validated=true;now+=2000;return{signedTransaction:'mock-bytes',signature:'mock'};}};
    const e=new Engine(f.c,api,chain,f.store);e.s=f.store.create(20,'wallet');e.solPrice=100;e.solPriceAt=now;
    await assert.rejects(e.buy({id:'mint',symbol:'T',decimals:6},5,{bucket:'copy',strategy:'copy',expiresAt:now+1000}),/too old during transaction/);
    assert.equal(validated,true);assert.equal(submissions,0);assert.equal(e.s.pending,null);assert.equal(e.s.positions.length,0);
    assert.equal(e.s.cash,20);assert.equal(e.s.buckets.copy.cash,6);
  }finally{Date.now=actualNow;f.cleanup();}
});
test('resume cannot erase a drawdown halt and flatten remains paused after closing',async()=>{
  const f=fixture();try{
    const e=new Engine(f.c,{}, {},f.store);await e.init();e.s.halt='Daily loss limit reached';e.s.paused=true;
    fs.writeFileSync(path.join(f.c.dataDir,'RESUME'),'');await e.controls();assert.ok(e.s.halt);assert.equal(e.s.paused,true);
    e.s.halt=null;fs.writeFileSync(path.join(f.c.dataDir,'FLATTEN'),'');await e.controls();
    e.solPrice=100;e.solPriceAt=Date.now();await e.monitor();
    assert.equal(e.s.paused,true);assert.equal(f.store.flag('FLATTEN'),false);
  }finally{f.cleanup();}
});
test('stored malformed risk controls and trade P&L cannot silently reset accounting',()=>{
  const f=fixture();try{
    const s=f.store.create(200);s.paused='false';f.store.save(s);assert.throws(()=>f.store.read(),/risk controls/);
    s.paused=false;s.trades=[{pnl:'unknown'}];f.store.save(s);assert.throws(()=>f.store.read(),/trade ledger/);
  }finally{f.cleanup();}
});

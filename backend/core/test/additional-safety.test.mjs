import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {realtimeFixture} from './realtime-fixture.mjs';import {assertPortfolio} from '../src/portfolio.mjs';import {config,SOL,USDC} from '../src/config.mjs';
import {Engine} from '../src/engine.mjs';import {Store} from '../src/store.mjs';import {token,quote,mint} from './helpers.mjs';

test('missing routes in SOL paper are marked zero and cannot be revived by cash repricing',async()=>{
  const f=await realtimeFixture();try{
    f.buy();f.notify();await f.engine.step();f.api.quote=async()=>{throw Error('No sell route');};
    await f.engine.monitor();await f.engine.monitor();await f.engine.monitor();f.engine.markEquity();
    assert.equal(f.engine.s.positions[0].markLamports,'0');assert.equal(f.engine.s.positions[0].mark,0);assert.ok(f.engine.s.halt);assertPortfolio(f.engine.s,'paper');
  }finally{f.cleanup();}
});
test('a slow notifier cannot stall paper order handling',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'notification-engine-')),c=config({DATA_DIR:root}),store=new Store(c);let release;
  const api={quote:async(i,o,a)=>quote(i,o,a,1)};const e=new Engine(c,api,{},store,()=>new Promise(r=>{release=r;}));
  try{await e.init();e.solPrice=100;e.solPriceAt=Date.now();const at=performance.now();await e.buy(token(),7,{bucket:'normal'});
    assert.equal(e.s.positions.length,1);assert.ok(performance.now()-at<100);release?.();await e.notificationTail;
  }finally{store.release();fs.rmSync(root,{recursive:true,force:true});}
});
test('SOL reallocation changes exact native buckets while retaining the total and accounting history',async()=>{
  const f=await realtimeFixture();try{
    f.engine.stream.stop();f.store.release();
    execFileSync(process.execPath,['src/cli.mjs','allocate','60','20'],{cwd:process.cwd(),env:{...process.env,MODE:'paper',PAPER_BASE:'SOL',DATA_DIR:f.root,EUR_USD_REFERENCE:'1.1',JUPITER_API_KEY:'',RPC_HTTP_URL:''},stdio:'pipe'});
    const s=f.store.read();assert.equal(s.paper.buckets.normal,'1320000000');assert.equal(s.paper.buckets.copy,'440000000');assert.equal(s.paper.buckets.reserve,'440000000');
    assert.equal(s.paper.cashLamports,'2200000000');assertPortfolio(s,'paper');
  }finally{f.cleanup();}
});
test('corrupted native paper amounts and unsupported old state formats are refused',async()=>{
  const f=await realtimeFixture();try{
    f.engine.s.version=3;f.store.save(f.engine.s);assert.throws(()=>f.store.read(),/version 4/);
    f.engine.s.version=4;f.engine.s.paper.cashLamports='NaN';f.store.save(f.engine.s);assert.throws(()=>f.store.read(),/integer/);
  }finally{f.cleanup();}
});

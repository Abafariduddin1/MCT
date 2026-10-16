import test from 'node:test';import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';import {realtimeFixture,turn} from './realtime-fixture.mjs';import {mint,transaction} from './helpers.mjs';
import {assertPortfolio} from '../src/portfolio.mjs';
test('a synthetic WebSocket notification reaches an automatic SOL paper copy fill without fallback polling',async()=>{
  const f=await realtimeFixture();try{
    f.buy();const at=performance.now();f.notify();await f.engine.step();const elapsed=performance.now()-at;
    assert.equal(f.engine.s.positions.length,1);assert.equal(f.engine.s.positions[0].base,'SOL');assert.equal(f.engine.s.positions[0].bucket,'copy');
    assert.equal(f.engine.s.paper.buckets.normal,'1100000000');assert.equal(f.engine.s.paper.buckets.reserve,'440000000');
    assert.ok(elapsed<1000,`controlled notification-to-fill took ${elapsed}ms`);assertPortfolio(f.engine.s,'paper');
    assert.equal(f.engine.s.latency.validatedCopyHandling.count,1);
  }finally{f.cleanup();}
});
test('live notifications queue proportional exits which are executed before discovery',async()=>{
  const f=await realtimeFixture();try{
    f.buy();f.notify();await f.engine.step();const whole=BigInt(f.engine.s.positions[0].amount);
    f.trim();f.notify(102);f.engine.lastCopyFetch=0;await f.engine.step();await f.engine.step();
    assert.equal(BigInt(f.engine.s.positions[0].amount),whole-whole/5n);assert.equal(f.engine.s.trades[0].reason,'Leader proportional sale');
    assert.equal(f.engine.s.paper.buckets.normal,'1100000000');assert.equal(f.engine.s.paper.buckets.reserve,'440000000');
  }finally{f.cleanup();}
});
test('overlapping coverage recovers a late-indexed transaction and does not duplicate its fill',async()=>{
  const f=await realtimeFixture();try{
    f.slot=101;f.rows=[];f.notify();await f.engine.step();assert.equal(f.engine.s.positions.length,0);
    f.buy();f.engine.lastCopyFetch=0;await f.engine.step();assert.equal(f.engine.s.positions.length,1);const cash=f.engine.s.paper.cashLamports;
    f.engine.lastCopyFetch=0;await f.engine.step();assert.equal(f.engine.s.paper.cashLamports,cash);assert.equal(f.engine.s.positions.length,1);
  }finally{f.cleanup();}
});
test('a pending buy still records leader sells atomically for its eventual holding',async()=>{
  const f=await realtimeFixture();try{
    f.engine.s.pending={side:'buy',bucket:'copy',mint,copyLeader:f.c.copyLeader,signature:'own-pending',amount:'1000000'};
    f.trim(101);await f.engine.copy.poll(f.engine);
    assert.equal(f.engine.s.pending.copySells.length,1);assert.deepEqual(f.store.read().copy.seen,['leader-trim']);
    await f.engine.copy.poll(f.engine);assert.equal(f.engine.s.pending.copySells.length,1);
  }finally{f.cleanup();}
});
test('metadata discovery can remain in flight while a copy notification is handled',async()=>{
  const f=await realtimeFixture();let release;
  try{
    f.api.candidates=()=>new Promise(r=>{release=r;});f.engine.launchDiscovery();f.buy();f.notify();await f.engine.step();
    assert.equal(f.engine.s.positions.length,1);assert.ok(f.engine.discoveryJob);release([]);await f.engine.discoveryJob;
  }finally{release?.([]);f.cleanup();}
});
test('malformed persisted SOL and stream bookkeeping cannot silently reset capital or quotas',async()=>{
  const f=await realtimeFixture();try{
    f.engine.s.paper.buckets.copy='-1';f.store.save(f.engine.s);assert.throws(()=>f.store.read());
    f.engine.s.paper.buckets.copy='660000000';f.engine.s.streamUsage={day:'today',bytes:-1,connections:0};f.store.save(f.engine.s);assert.throws(()=>f.store.read(),/stream usage/);
  }finally{f.cleanup();}
});

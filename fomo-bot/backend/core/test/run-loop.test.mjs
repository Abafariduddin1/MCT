import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import {realtimeFixture,turn} from './realtime-fixture.mjs';
async function until(predicate,timeout=1200){const deadline=Date.now()+timeout;while(!predicate()){if(Date.now()>deadline)throw Error('Running engine did not reach the expected state');await turn();}}
test('the running engine wakes on a notification, buys, and saves its holding on stop',async()=>{
  const f=await realtimeFixture({SCHEDULER_MAX_WAIT_MS:'1000'});let running;
  try{
    f.engine.stream.stop();f.store.release();running=f.engine.run();
    await until(()=>f.engine.stream?.health.ready&&f.engine.wake.waiter&&f.engine.nextCopy>Date.now());
    f.engine.lastCopyFetch=0;f.buy();const started=performance.now();f.notify();await until(()=>f.engine.s.positions.length===1);
    assert.ok(performance.now()-started<500,'notification must wake the one-second scheduler wait');
    f.engine.stopping=true;f.engine.wake.wake();await running;
    assert.equal(f.store.read().positions.length,1);assert.equal(f.store.lock,null);assert.equal(f.engine.stream.stopped,true);
  }finally{f.engine.stopping=true;f.engine.wake.wake();if(running)await running;f.cleanup();}
});
test('a coalesced copy hint runs at its deadline instead of waiting an additional scheduler second',async()=>{
  const f=await realtimeFixture({SCHEDULER_MAX_WAIT_MS:'1000'});let running;
  try{
    f.engine.stream.stop();f.store.release();running=f.engine.run();
    await until(()=>f.engine.stream?.health.ready&&f.engine.wake.waiter&&f.engine.nextCopy>Date.now());
    f.engine.lastCopyFetch=Date.now();f.buy();const started=performance.now();f.notify();await until(()=>f.engine.s.positions.length===1);
    const elapsed=performance.now()-started;assert.ok(elapsed>=650&&elapsed<1000,`bounded fetch cooldown took ${elapsed}ms`);
    f.engine.stopping=true;f.engine.wake.wake();await running;
  }finally{f.engine.stopping=true;f.engine.wake.wake();if(running)await running;f.cleanup();}
});
test('stopping the running engine cancels blocked background reads before releasing the lock',async()=>{
  const f=await realtimeFixture();let running,aborts=0;
  const blocked=signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborts++;reject(Error('cancelled'));},{once:true}));
  try{
    f.engine.stream.stop();f.store.release();running=f.engine.run();
    await until(()=>f.engine.stream?.health.ready&&f.engine.nextCopy>Date.now());
    f.api.candidates=signal=>blocked(signal);f.api.tokens=(_ids,_priority,_fresh,signal)=>blocked(signal);
    f.engine.launchDiscovery();f.engine.launchMarket();f.engine.stopping=true;f.engine.wake.wake();
    const started=performance.now();await running;
    assert.ok(performance.now()-started<500);assert.equal(aborts,2);assert.equal(f.store.lock,null);assert.equal(f.store.read().pending,null);
    assert.ok(fs.existsSync(f.store.file));
  }finally{f.engine.stopping=true;f.engine.wake.wake();if(running)await running;f.cleanup();}
});
test('metadata screens reuse fresh streamed slots while entries still require confirmed RPC data',async()=>{
  const f=await realtimeFixture();let slotReads=0;
  try{
    f.engine.chain.connection.getSlot=async commitment=>{assert.equal(commitment,'confirmed');slotReads++;return 1005;};
    const ws=f.engine.stream.socket,id=ws.requests.find(r=>r.method==='slotSubscribe').id;
    ws.message({method:'slotNotification',params:{subscription:id,result:{slot:1005,parent:1004,root:990}}});
    assert.equal(await f.engine.screeningSlot(),1005);assert.equal(slotReads,0);
    f.buy();f.notify();await f.engine.step();assert.equal(f.engine.s.positions.length,1);assert.ok(slotReads>0);
    f.engine.stream.health.lastSlotAt=Date.now()-3000;await f.engine.screeningSlot();assert.ok(slotReads>=2);
  }finally{f.cleanup();}
});

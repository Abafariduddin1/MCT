import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {config,USDC} from '../src/config.mjs';import {Engine} from '../src/engine.mjs';import {Store} from '../src/store.mjs';
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'finality-engine-')),c=config({MODE:'live',DATA_DIR:root,LIVE_SETTLEMENT_COMMITMENT:'confirmed'}),store=new Store(c);
  const result={kind:'success',nativeSpent:56000,usdcDelta:'-1000000',tokenDelta:'1000000',confirmation:'confirmed'};
  const chain={address:'wallet',connection:{getBlockHeight:async()=>100},settlement:async(_p,commitment)=>commitment==='finalized'?{kind:'pending'}:{...result},
    balances:async()=>({usdc:19,native:9944000,tokens:{[USDC]:19000000n,mint:1000000n}})};
  const e=new Engine(c,{},chain,store);e.s=store.create(20,'wallet');e.s.pending={side:'buy',bucket:'copy',copyLeader:'leader',mint:'mint',symbol:'T',decimals:6,
    amount:'1000000',minimum:'995000',signature:'buy',lastValidBlockHeight:1000,beforeNative:10000000,solPrice:100};
  return{root,c,store,e,chain,result,cleanup(){store.release();fs.rmSync(root,{recursive:true,force:true});}};
}
test('confirmed operation commits one holding while retaining a durable finality verification record',async()=>{
  const f=fixture();try{await f.e.settle();assert.equal(f.e.s.positions.length,1);assert.equal(f.e.s.pending,null);assert.equal(f.e.s.finality.length,1);
    assert.equal(f.store.read().finality[0].intent.signature,'buy');await f.e.settle();assert.equal(f.e.s.positions.length,1);
    await f.e.verifyFinality();assert.equal(f.e.s.finality.length,1);
    f.chain.settlement=async()=>({...f.result,confirmation:'finalized'});await f.e.verifyFinality();assert.equal(f.e.s.finality.length,0);assert.equal(f.e.s.positions.length,1);assert.equal(f.e.s.cash,19);
  }finally{f.cleanup();}
});
test('a finality mismatch pauses entries and preserves the accounting for reconciliation',async()=>{
  const f=fixture();try{await f.e.settle();f.chain.settlement=async()=>({...f.result,usdcDelta:'-2000000',confirmation:'finalized'});
    await assert.rejects(f.e.verifyFinality(),/differs/);assert.equal(f.e.s.paused,true);assert.equal(f.e.s.cash,19);assert.equal(f.e.s.finality.length,1);assert.ok(f.store.read().halt);
  }finally{f.cleanup();}
});
test('a missing confirmed fill beyond finalized expiry cannot be resubmitted or erased',async()=>{
  const f=fixture();try{await f.e.settle();f.chain.connection.getBlockHeight=async()=>2000;await f.e.verifyFinality();
    assert.equal(f.e.s.finality.length,1);assert.match(f.e.s.halt,/lost finality/);assert.equal(f.e.s.paused,true);
  }finally{f.cleanup();}
});
test('leader trims observed during pending confirmation apply once when its holding is committed',async()=>{
  const f=fixture();try{f.e.s.pending.copySells=[{event:{leaderBefore:'100',tokenAmount:'20'},signature:'trim'}];await f.e.settle();
    assert.equal(f.e.s.positions[0].pendingCopySell,'200000');await f.e.settle();assert.equal(f.e.s.positions[0].pendingCopySell,'200000');
  }finally{f.cleanup();}
});

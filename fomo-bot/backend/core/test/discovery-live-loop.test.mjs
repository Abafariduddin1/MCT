import test from 'node:test';import assert from 'node:assert/strict';
import {Http,Jupiter} from '../src/api.mjs';import {SOL,USDC} from '../src/config.mjs';
import {realtimeFixture,turn} from './realtime-fixture.mjs';import {token} from './helpers.mjs';
test('an already ready fast refresh cannot postpone overdue discovery launch',async()=>{
  const f=await realtimeFixture({COPY_ALLOCATION_PCT:'0',NORMAL_ALLOCATION_PCT:'80'});let release;
  try{
    f.engine.nextScan=0;f.engine.latestMarket=[];
    f.api.candidates=()=>new Promise(resolve=>{release=resolve;});
    await f.engine.step();assert.ok(f.engine.discoveryJob,'overdue discovery must launch despite a ready market update');
  }finally{release?.([]);await f.engine.discoveryJob;f.cleanup();}
});
test('repeated fast refreshes allow the real discovery pipeline to populate its shortlist',async()=>{
  const f=await realtimeFixture({COPY_ALLOCATION_PCT:'0',NORMAL_ALLOCATION_PCT:'80'});let categories=0;
  try{
    const http=new Http(5,async url=>{
      const u=new URL(url);let data;
      if(u.pathname.includes('/tokens/v2/search'))data=u.searchParams.get('query').split(',').map(id=>id===SOL?{id,usdPrice:100}:id===USDC?{id,usdPrice:1}:token(id,1,1000));
      else{const offset=categories++*100;data=Array.from({length:100},(_,i)=>token('candidate-'+(offset+i),1,1000));}
      return{ok:true,json:async()=>data};
    });
    f.engine.api=new Jupiter(f.c,http);f.engine.nextScan=0;f.engine.nextShortlist=0;f.c.referenceMs=60000;
    const deadline=Date.now()+1500;
    while(!f.engine.s.market&&Date.now()<deadline){f.engine.nextShortlist=0;await f.engine.step();await turn();}
    assert.equal(f.engine.s.market?.candidateCount,200);assert.equal(f.engine.shortlist.length,30);
    assert.equal(f.engine.s.diagnostics.discovery.candidates,200);assert.ok(categories>=2);
  }finally{
    f.engine.stopping=true;f.engine.discoveryAbort?.abort();f.engine.marketAbort?.abort();
    await Promise.allSettled([f.engine.discoveryJob,f.engine.marketJob].filter(Boolean));f.cleanup();
  }
});
test('an empty fast shortlist does not perform a redundant screening RPC or claim a normal scan',async()=>{
  const f=await realtimeFixture({COPY_ALLOCATION_PCT:'0',NORMAL_ALLOCATION_PCT:'80'});let reads=0;
  try{
    f.engine.chain.connection.getSlot=async()=>{reads++;return 1005;};
    f.engine.latestMarket=[{id:SOL,usdPrice:100},{id:USDC,usdPrice:1}];await f.engine.step();
    assert.equal(reads,0);assert.equal(f.engine.s.health.lastScan,null);
  }finally{f.cleanup();}
});

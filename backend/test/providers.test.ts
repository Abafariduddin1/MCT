import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {DexScreener,parseDexPairs} from '../src/dexScreener.js';import {JsonHttp} from '../src/http.js';
import {SafetyAggregator,parseRugSummary} from '../src/rugcheck.js';import {PumpStream,parsePumpEvent} from '../src/pumpStream.js';
import {FeedService} from '../src/feed.js';
import {temp,settings,mint,FakeSocket,turn} from './helpers.js';
import type {MarketToken} from '../src/types.js';import type {SocketPort} from '../src/pumpStream.js';
function market():MarketToken{return{mint,name:'Coin',symbol:'COIN',imageUri:null,mcapUsd:100000,fdvUsd:100000,liquidityUsd:150000,
  change5mPct:2,volume5mUsd:50000,createdAt:Date.now()-72*3600000,observedAt:Date.now(),source:'dexscreener',estimated:false};}
test('Dex parsing chooses liquid exact-base Solana pairs and does not disguise FDV as market cap',()=>{
  const pair={chainId:'solana',baseToken:{address:mint,name:'Coin',symbol:'COIN'},marketCap:500000,fdv:900000,liquidity:{usd:100000}};
  const result=parseDexPairs([pair,{...pair,liquidity:{usd:200000},marketCap:null},{...pair,chainId:'ethereum'}],new Set([mint]));
  assert.equal(result.length,1);assert.equal(result[0]!.liquidityUsd,200000);assert.equal(result[0]!.mcapUsd,null);assert.equal(result[0]!.fdvUsd,900000);
});
test('Dex batching uses at most thirty mints per request and caching avoids duplicate reads',async()=>{
  const requests:string[][]=[];const ids=Array.from({length:31},(_,i)=>{const bytes=Buffer.alloc(32);bytes[0]=i+1;return new PublicKey(bytes).toBase58();});
  const dex=new DexScreener(new JsonHttp(async input=>{
    const batch=String(input).split('/').at(-1)!.split(',');requests.push(batch);
    return new Response(JSON.stringify(batch.map(address=>({chainId:'solana',baseToken:{address,name:'Coin',symbol:'COIN'},marketCap:100000,liquidity:{usd:100000}}))));
  },0));
  assert.equal((await dex.tokens(ids)).length,31);assert.deepEqual(requests.map(x=>x.length),[30,1]);await dex.tokens(ids.slice(0,2));assert.equal(requests.length,2);
});
test('new or stale discovery tokens remain ineligible without spending safety RPC/report quota',async()=>{
  const t=temp();try{
    const c=await settings(t.root);let calls=0;
    const safety=new SafetyAggregator(c,{inspectMint:async()=>{calls++;throw Error('unexpected');},top10AccountPct:async()=>{calls++;return 10;}},{summary:async()=>{calls++;throw Error('unexpected');}});
    const report=await safety.inspect(mint,{...market(),createdAt:Date.now()});assert.equal(report.isSafe,false);assert.equal(calls,0);
    const missing=await safety.inspect(mint,{...market(),observedAt:Date.now()-20000});assert.equal(missing.isSafe,false);assert.equal(calls,0);
  }finally{t.cleanup();}
});
test('a safety badge requires all checks and a fresh liquidity drop invalidates a cached pass',async()=>{
  const t=temp();try{
    const c=await settings(t.root);const safety=new SafetyAggregator(c,{inspectMint:async()=>({mint,classic:true,initialized:true,mintAuthorityRevoked:true,freezeAuthorityRevoked:true,decimals:6,supply:1000000n,checkedAt:Date.now()}),top10AccountPct:async()=>20},
      {summary:async()=>({score:5,lpLockedPct:100,risks:[],observedAt:Date.now()})});
    assert.equal((await safety.inspect(mint,market())).isSafe,true);
    const drop=await safety.inspect(mint,{...market(),liquidityUsd:1000});assert.equal(drop.isSafe,false);assert.match(drop.riskReason,/Liquidity/);
  }finally{t.cleanup();}
});
test('missing LP evidence and unknown risk levels never produce a passing badge',async()=>{
  const t=temp();try{
    const c=await settings(t.root);const facts={inspectMint:async()=>({mint,classic:true,initialized:true,mintAuthorityRevoked:true,freezeAuthorityRevoked:true,decimals:6,supply:1000000n,checkedAt:Date.now()}),top10AccountPct:async()=>20};
    const a=new SafetyAggregator(c,facts,{summary:async()=>({score:0,lpLockedPct:null,risks:[],observedAt:Date.now()})});assert.equal((await a.inspect(mint,market())).isSafe,false);
    const b=new SafetyAggregator(c,facts,{summary:async()=>({score:0,lpLockedPct:100,risks:[{name:'Unclassified risk',level:'new-level'}],observedAt:Date.now()})});assert.equal((await b.inspect(mint,market())).isSafe,false);
    assert.throws(()=>parseRugSummary({score_normalised:0,lpLockedPct:101,risks:[]}));assert.throws(()=>parseRugSummary({score_normalised:0}));
  }finally{t.cleanup();}
});
test('free Pump subscriptions use one socket, reconnect correctly, and never request metered trades',async()=>{
  const t=temp();let pump:PumpStream|undefined;
  try{
    const c=await settings(t.root);pump=new PumpStream(c,()=>new FakeSocket() as unknown as SocketPort);pump.start();await turn();
    let socket=FakeSocket.all.at(-1)!;assert.deepEqual(socket.sent.map(value=>JSON.parse(value).method),['subscribeNewToken','subscribeMigration']);
    assert.throws(()=>pump!.watchTokenTrades([mint]),/disabled/);const before=FakeSocket.all.length;socket.close();await new Promise(resolve=>setTimeout(resolve,550));
    socket=FakeSocket.all.at(-1)!;assert.equal(FakeSocket.all.length,before+1);assert.equal(socket.sent.length,2);
    const another=new PumpStream(c,()=>new FakeSocket() as unknown as SocketPort);assert.throws(()=>another.start(),/one PumpPortal/);
  }finally{pump?.stop();t.cleanup();}
});
test('Pump notifications are bounded, deduplicated, and bonding progress is unknown unless reported',async()=>{
  const t=temp();let pump:PumpStream|undefined;
  try{
    const c=await settings(t.root);pump=new PumpStream(c,()=>new FakeSocket() as unknown as SocketPort);let events=0;pump.on('token',()=>events++);pump.start();await turn();
    const socket=FakeSocket.all.at(-1)!;socket.message({txType:'create',mint,signature:'one',marketCapSol:100});socket.message({txType:'create',mint,signature:'one'});
    assert.equal(events,1);assert.equal(parsePumpEvent({txType:'create',mint})!.bondingPct,null);assert.equal(parsePumpEvent({txType:'migration',mint})!.bondingPct,100);
    socket.message({txType:'buy',mint,signature:'paid'});assert.equal(pump.health.running,false);assert.match(pump.health.error!,/metered/);
  }finally{pump?.stop();t.cleanup();}
});
test('opted-in trade events consume persisted budget including duplicates and stop at the limit',async()=>{
  const t=temp();let pump:PumpStream|undefined;
  try{
    const c=await settings(t.root,{ALLOW_METERED_PUMP_DATA:'true',PUMPPORTAL_API_KEY:'test-only',PUMP_MAX_METERED_EVENTS_PER_DAY:'10'});
    pump=new PumpStream(c,()=>new FakeSocket() as unknown as SocketPort);pump.watchTokenTrades([mint]);pump.start();await turn();const socket=FakeSocket.all.at(-1)!;
    for(let i=0;i<10;i++)socket.message({txType:'buy',mint,signature:'duplicate'});
    assert.equal(pump.quota.snapshot().spent,10);assert.equal(pump.health.running,false);assert.throws(()=>pump!.start(),/budget/);
  }finally{pump?.stop();t.cleanup();}
});
test('metered caps also stop on the final malformed or untracked event',async()=>{
  for(const finalMint of ['not-a-public-key',new PublicKey(Buffer.alloc(32,7)).toBase58()]){
    const t=temp();let pump:PumpStream|undefined;
    try{
      const c=await settings(t.root,{ALLOW_METERED_PUMP_DATA:'true',PUMPPORTAL_API_KEY:'test-only',PUMP_MAX_METERED_EVENTS_PER_DAY:'10'});
      pump=new PumpStream(c,()=>new FakeSocket() as unknown as SocketPort);pump.watchTokenTrades([mint]);pump.start();await turn();const socket=FakeSocket.all.at(-1)!;
      for(let i=0;i<9;i++)socket.message({txType:'buy',mint,signature:'duplicate'});
      socket.message({txType:'buy',mint:finalMint,signature:'last'});
      assert.equal(pump.quota.snapshot().spent,10);assert.equal(pump.health.running,false);assert.match(pump.health.error!,/budget/);
    }finally{pump?.stop();t.cleanup();}
  }
});
test('feed charts contain only observed points and missing bonding data is kept unknown',async()=>{
  const t=temp();let pump:PumpStream|undefined;
  try{
    const c=await settings(t.root);pump=new PumpStream(c,()=>new FakeSocket() as unknown as SocketPort);
    const safety={inspect:async()=>{throw Error('not called');}} as unknown as SafetyAggregator;
    const feed=new FeedService(c,pump,new DexScreener(),safety,()=>100);
    feed.ingest({kind:'create',mint,signature:null,name:'Coin',symbol:'COIN',marketCapSol:2,bondingPct:null,receivedAt:Date.now()});
    const row=feed.snapshot()[0]!;assert.equal(row.mcapUsd,200);assert.equal(row.points.length,1);assert.equal(row.bondingPct,null);assert.equal(row.isSafe,false);
    await feed.stop();
  }finally{pump?.stop();t.cleanup();}
});

test('market refresh keeps running while a safety report is still pending',async()=>{
  const t=temp();let pump:PumpStream|undefined,feed:FeedService|undefined,release:()=>void=()=>{};
  try{
    const c=await settings(t.root,{DEX_REFRESH_MS:'1000'});let marketReads=0,inspections=0;
    const pending=new Promise<void>(resolve=>{release=resolve;});
    const safety={inspect:async()=>{inspections++;await pending;return{mint,isSafe:false,status:'unknown',riskReason:'Not verified',checkedAt:Date.now(),expiresAt:Date.now()+60000,
      checks:[],top10Pct:null,lpLockedPct:null,rugScore:null};}} as unknown as SafetyAggregator;
    const dex=new DexScreener(new JsonHttp(async input=>{
      if(String(input).includes('token-boosts'))return new Response(JSON.stringify([{chainId:'solana',tokenAddress:mint}]));
      marketReads++;return new Response(JSON.stringify([{chainId:'solana',baseToken:{address:mint,name:'Coin',symbol:'COIN'},marketCap:100000+marketReads,
        liquidity:{usd:150000},pairCreatedAt:Date.now()-72*3600000}]));
    },0),1);
    pump=new PumpStream(c,()=>new FakeSocket() as unknown as SocketPort);feed=new FeedService(c,pump,dex,safety,()=>100);feed.start();
    const deadline=Date.now()+1800;
    while(marketReads<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(marketReads>=2,'Safety I/O must not block the next price refresh');assert.equal(inspections,1);
    assert.equal(feed.snapshot()[0]!.isSafe,false);release();await feed.stop();
  }finally{release();await feed?.stop();pump?.stop();t.cleanup();}
});

test('a metadata-only Pump event cannot renew the timestamp of an old market-cap observation',async()=>{
  const t=temp();let pump:PumpStream|undefined;
  try{
    const c=await settings(t.root);pump=new PumpStream(c,()=>new FakeSocket() as unknown as SocketPort);
    const safety={inspect:async()=>{throw Error('not called');}} as unknown as SafetyAggregator;
    const feed=new FeedService(c,pump,new DexScreener(),safety,()=>100),old=Date.now()-30000;
    feed.ingest({kind:'create',mint,signature:null,name:'Coin',symbol:'COIN',marketCapSol:1,bondingPct:null,receivedAt:old});
    feed.ingest({kind:'migration',mint,signature:null,name:null,symbol:null,marketCapSol:null,bondingPct:100,receivedAt:Date.now()});
    assert.equal(feed.snapshot()[0]!.observedAt,old);assert.equal(feed.snapshot()[0]!.points.length,1);assert.equal(feed.snapshot()[0]!.isSafe,false);
    await feed.stop();
  }finally{pump?.stop();t.cleanup();}
});

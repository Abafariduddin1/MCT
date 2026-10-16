import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {config,USDC,SOL} from '../src/config.mjs';
import {Keypair} from '@solana/web3.js';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {parseLeaderSwap} from '../src/copy.mjs';
import {HistorySource} from '../src/history.mjs';
import {Http} from '../src/api.mjs';
import {PUMPSWAP_PROGRAM} from '../src/venues.mjs';
import {mint,leader,token,quote,transaction} from './helpers.mjs';

test('decoder supports version 1 observations, Jupiter and direct PumpSwap swap instructions',()=>{
  for(const side of ['buy','sell']){
    const event=parseLeaderSwap(transaction(side),leader);assert.equal(event.side,side);assert.equal(event.baseMint,USDC);
    const native=parseLeaderSwap(transaction(side,'sol'),leader);assert.equal(native.baseAmount,'100000000');assert.equal(native.baseMint,SOL);
    const direct=parseLeaderSwap(transaction(side,'usdc',{program:PUMPSWAP_PROGRAM,instruction:side}),leader);assert.equal(direct.side,side);
  }
});
test('decoder ignores address mentions, non-swap instructions, LP deposits, failed transactions and missing ownership',()=>{
  const mention=transaction();mention.transaction.message.accountKeys[0].signer=false;
  const deposit=transaction('buy','usdc',{program:PUMPSWAP_PROGRAM,instruction:'deposit'});
  const failed=transaction();failed.meta.err='failed';
  const missing=transaction();delete missing.meta.postTokenBalances[0].owner;
  const transfer=transaction();transfer.transaction.message.instructions=[];
  for(const tx of [mention,deposit,failed,missing,transfer])assert.equal(parseLeaderSwap(tx,leader),null);
});
test('decoder records the actual leader before balance for proportional exits and neutralises account rent',()=>{
  const sale=parseLeaderSwap(transaction('sell','usdc',{amount:2000000}),leader);
  assert.equal(sale.tokenAmount,'2000000');assert.equal(sale.leaderBefore,'10000000');
  const tx=transaction('buy','sol');tx.meta.preBalances[2]=0;tx.meta.postBalances[0]-=2039280;
  tx.meta.preTokenBalances=tx.meta.preTokenBalances.filter(r=>r.mint!==mint);
  assert.equal(parseLeaderSwap(tx,leader).baseAmount,'100000000');
});
test('filtered history uses mint-independent own transfers accepted by the amount-filter contract and parsed v1',async()=>{
  let request;
  const source=new HistorySource(config({}),new Http(0,async(_url,options)=>{
    request=JSON.parse(options.body);
    const filter=request.params[1].filters.tokenTransfer;
    const result=filter?.amount&&!filter.mint
      ?{error:{code:-32602,message:'Invalid params: tokenTransfer amount filter requires mint'}}
      :filter&&request.params[1].commitment!=='finalized'
        ?{error:{code:-32602,message:'Invalid params: tokenTransfer filter requires finalized commitment'}}
        :{result:{data:[transaction()],paginationToken:null}};
    return{ok:true,json:async()=>result};
  }));
  const result=await source.page(leader,100,200,'cursor');
  assert.equal(parseLeaderSwap(result.data[0],leader).side,'buy');
  assert.equal(request.method,'getTransactionsForAddress');
  const p=request.params[1];assert.equal(p.maxSupportedTransactionVersion,1);assert.equal(p.encoding,'jsonParsed');
  assert.equal(p.filters.tokenAccounts,'balanceChanged');assert.deepEqual(p.filters.tokenTransfer,{direction:'any'});
  assert.deepEqual(p.filters.slot,{gte:100,lte:200});
  assert.equal(p.commitment,'finalized');
  assert.equal(p.filters.status,'succeeded');assert.equal(p.sortOrder,'asc');assert.equal(p.paginationToken,'cursor');
});
async function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v3-copy-'));
  const c=config({COPY_LEADER:leader,DATA_DIR:root});const store=new Store(c);
  let currentSlot=100,rows=[],pagination=null,pageCalls=0;
  const source={slot:async()=>currentSlot,page:async()=>{pageCalls++;return{data:rows,paginationToken:pagination};}};
  const api={tokens:async ids=>ids.includes(SOL)?[{id:SOL,usdPrice:100},{id:USDC,usdPrice:1}]:[token()],
    quote:async(i,o,a,taker)=>quote(i,o,a,1,taker),execute:async()=>{throw new Error('No real submission allowed in paper tests');}};
  const chain={history:source,connection:{getSlot:async()=>1005},verifyMint:async()=>{}};
  const engine=new Engine(c,api,chain,store);await engine.init();
  return{c,store,engine,source,api,get pageCalls(){return pageCalls;},set rows(value){rows=value;},set currentSlot(value){currentSlot=value;},
    set pagination(value){pagination=value;},cleanup(){store.release();fs.rmSync(root,{recursive:true,force:true});}};
}
test('first start follows only future slots, with no historical entry',async()=>{
  const f=await fixture();try{assert.equal(f.engine.s.copy.nextSlot,101);assert.equal(f.engine.s.positions.length,0);assert.equal(f.pageCalls,0);}finally{f.cleanup();}
});
test('paper copy buys with its own budget, then proportionally exits a leader trim',async()=>{
  const f=await fixture();try{
    f.currentSlot=101;f.rows=[transaction()];await f.engine.copy.poll(f.engine);
    const p=f.engine.s.positions[0];assert.equal(p.bucket,'copy');assert.equal(p.copyLeader,leader);
    assert.ok(f.engine.s.buckets.copy.cash<60);assert.equal(f.engine.s.buckets.normal.cash,100);assert.equal(f.engine.s.buckets.reserve.cash,40);
    const whole=BigInt(p.amount),cost=p.cost;
    f.currentSlot=102;f.rows=[transaction('sell','usdc',{slot:102,signature:'trim',amount:2000000})];
    await f.engine.copy.poll(f.engine);await f.engine.monitor();
    assert.equal(BigInt(f.engine.s.positions[0].amount),whole-whole/5n);
    assert.ok(Math.abs(f.engine.s.positions[0].cost-cost*0.8)<0.000002);
    assert.equal(f.engine.s.trades[0].positionClosed,false);assert.equal(f.engine.s.trades[0].bucket,'copy');
    assert.equal(f.engine.s.buckets.reserve.cash,40);assert.equal(f.store.read().positions.length,1);
  }finally{f.cleanup();}
});
test('a claimed leader signature cannot buy again, including replayed later-slot history',async()=>{
  const f=await fixture();try{
    f.currentSlot=101;f.rows=[transaction()];await f.engine.copy.poll(f.engine);
    const initial=f.engine.s.cash;f.currentSlot=102;f.rows=[transaction('buy','usdc',{slot:102})];await f.engine.copy.poll(f.engine);
    assert.equal(f.engine.s.positions.length,1);assert.equal(f.engine.s.cash,initial);
  }finally{f.cleanup();}
});
test('pause skips leader buys but keeps observed sale requests',async()=>{
  const f=await fixture();try{
    f.currentSlot=101;f.rows=[transaction()];await f.engine.copy.poll(f.engine);
    f.engine.s.paused=true;f.currentSlot=102;f.rows=[transaction('sell','usdc',{slot:102,signature:'sale'})];
    await f.engine.copy.poll(f.engine);await f.engine.monitor();assert.equal(f.engine.s.positions.length,0);
  }finally{f.cleanup();}
});
test('stale leader entries do not buy; stream failures block only the copy sleeve',async()=>{
  const f=await fixture();try{
    f.currentSlot=101;f.rows=[transaction('buy','usdc',{blockTime:Math.floor(Date.now()/1000)-200})];await f.engine.copy.poll(f.engine);
    assert.equal(f.engine.s.positions.length,0);
    f.currentSlot=102;f.source.page=async()=>{throw new Error('History unavailable');};await f.engine.copy.poll(f.engine);
    assert.match(f.engine.s.copy.blocked,/unavailable/);assert.equal(f.engine.s.halt,null);assert.equal(f.engine.s.buckets.normal.halt,null);
  }finally{f.cleanup();}
});
test('history credit budget prevents calls and paginated intervals do not advance prematurely',async()=>{
  const f=await fixture();try{
    f.currentSlot=101;f.pagination='more';f.rows=[];await f.engine.copy.poll(f.engine);
    assert.ok(f.engine.s.copy.scan);assert.equal(f.engine.s.copy.nextSlot,101);assert.ok(f.engine.s.copy.estimatedCredits<=f.c.copyPages*10);
    f.engine.s.copy.estimatedCredits=f.c.copyCreditBudget;const calls=f.pageCalls;
    await f.engine.copy.poll(f.engine);assert.equal(f.pageCalls,calls);assert.match(f.engine.s.copy.blocked,/credit budget|advance/);
  }finally{f.cleanup();}
});

test('immediate finalized live fills retain copy claims, queued trims and history coverage',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'live-copy-'));
  const c=config({MODE:'live',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES',COPY_LEADER:leader,DATA_DIR:root});
  const store=new Store(c);let slot=100,rows=[],executions=0,prepared;
  let balances={usdc:30,native:20000000,tokens:{[USDC]:30000000n}};
  const history={slot:async()=>slot,page:async()=>({data:rows,paginationToken:null})};
  const api={tokens:async ids=>ids.includes(SOL)?[{id:SOL,usdPrice:100},{id:USDC,usdPrice:1}]:[token()],
    quote:async(i,o,a,taker)=>quote(i,o,a,1,taker),execute:async()=>{executions++;return{signature:prepared.signature};}};
  const chain={address:Keypair.generate().publicKey.toBase58(),history,connection:{getSlot:async()=>1005},verifyMint:async()=>{},
    balances:async()=>balances,prepare:async(q,side)=>{
      prepared={signature:`${side}-${executions}`,signedTransaction:'mock-bytes',requestId:'request',lastValidBlockHeight:99999,minimum:q.otherAmountThreshold};return prepared;
    },settlement:async p=>{
      const amount=BigInt(p.amount),stable=p.side==='buy'?-amount:amount,tokens=-stable;
      balances={usdc:balances.usdc+Number(stable)/1e6,native:balances.native-56000,
        tokens:{[USDC]:balances.tokens[USDC]+stable,[mint]:(balances.tokens[mint]||0n)+tokens}};
      return{kind:'success',nativeSpent:56000,usdcDelta:String(stable),tokenDelta:String(tokens)};
    }};
  const e=new Engine(c,api,chain,store);
  try{
    await e.init();const copyState=e.s.copy;
    slot=101;rows=[transaction('buy','usdc',{signature:'copied-buy'}),transaction('sell','usdc',{signature:'copied-trim',amount:2000000})];
    rows[1].transactionIndex=1;await e.copy.poll(e);
    assert.equal(executions,1);assert.equal(e.s.copy,copyState);
    assert.equal(e.s.copy.signals,2);assert.equal(e.s.copy.coveredThroughSlot,101);assert.equal(e.s.copy.scan,null);
    assert.deepEqual(e.s.copy.seen,['copied-buy','copied-trim']);
    const holding=BigInt(e.s.positions[0].amount);assert.equal(BigInt(e.s.positions[0].pendingCopySell),holding/5n);
    await e.monitor();assert.equal(executions,2);assert.equal(BigInt(e.s.positions[0].amount),holding-holding/5n);
    assert.equal(e.s.buckets.normal.cash,15);assert.equal(e.s.buckets.reserve.cash,6);
    slot=102;rows=rows.map(tx=>({...tx,slot:102}));await e.copy.poll(e);
    assert.equal(executions,2);assert.equal(e.s.copy.signals,2);assert.equal(e.s.copy.coveredThroughSlot,102);
    assert.deepEqual(store.read().copy.seen,['copied-buy','copied-trim']);
  }finally{store.release();fs.rmSync(root,{recursive:true,force:true});}
});

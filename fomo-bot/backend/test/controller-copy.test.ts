import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {CopyController} from '../src/copyController.js';
import {SolanaService} from '../src/solana.js';
import {JsonHttp} from '../src/http.js';
import {fixture,token,leader} from './controller-fixture.js';
import type {HistoryPort,HistoryTransaction} from '../src/controllerCore.js';
import type {CopyEvent} from '../src/controllerTypes.js';

const sig=(n:number)=>bs58.encode(new Uint8Array(64).fill(n));
const tx=(slot:number,n:number):HistoryTransaction=>({slot,transaction:{signatures:[sig(n)]}});
const ev=(side:'buy'|'sell',at=Date.now()):CopyEvent=>({side,mint:token,decimals:6,baseMint:'So11111111111111111111111111111111111111112',leaderBefore:'10000000',baseAmount:'50000000',tokenAmount:'5000000',at});
test('copy baseline is future-only, claims deduplicate overlap and stale buys never execute',async()=>{
  const f=await fixture();try{
    let slot=100;const calls:Array<[number,number]>=[];let rows:HistoryTransaction[]=[];
    const source:HistoryPort={slot:async()=>slot,page:async(_leader,from,to)=>{calls.push([from,to]);return {data:rows};}};
    const copy=new CopyController(f.c,f.engine,source,()=>ev('buy',Date.now()-70000),f.port);
    f.ledger.transact(s=>{s.settings.autoPilot=true;});await copy.poll();assert.equal(f.ledger.read().copy.baselineSlot,101);assert.equal(calls.length,0);
    slot=105;rows=[tx(103,3)];await copy.poll();await copy.poll();await f.engine.idle();assert.deepEqual(calls,[[101,105],[101,105]]);assert.equal(Object.keys(f.ledger.read().copy.claims).length,1);assert.equal(f.ledger.read().positions.length,0);
  }finally{await f.cleanup();}
});
test('later sale in the same history scan suppresses its older buy',async()=>{
  const f=await fixture();try{
    f.ledger.transact(s=>{s.settings.autoPilot=true;s.copy.baselineSlot=100;s.copy.nextSlot=100;});const now=Date.now();
    const source:HistoryPort={slot:async()=>105,page:async()=>({data:[tx(101,3),tx(103,4)]})};
    const copy=new CopyController(f.c,f.engine,source,t=>ev(t.slot===101?'buy':'sell',now-(t.slot===101?1000:0)),f.port);
    await copy.poll();await f.engine.idle();assert.equal(f.port.calls.prepare,0);assert.equal(f.ledger.read().orders.length,0);assert.equal(Object.keys(f.ledger.read().copy.claims).length,2);
  }finally{await f.cleanup();}
});
test('history failure blocks the copy sleeve without disabling independent normal trading',async()=>{
  const f=await fixture();try{
    const copy=new CopyController(f.c,f.engine,{slot:async()=>{throw Error('History unavailable');},page:async()=>({data:[]})},()=>null,f.port);
    await copy.tick();const s=f.ledger.read();assert.match(s.copy.blocked!,/unavailable/);assert.equal(s.risk.halt,null);assert.equal(s.settings.normalEnabled,true);
  }finally{await f.cleanup();}
});
test('history adapter uses shared RPC quota and retains finalized own-transfer filters',async()=>{
  const f=await fixture();try{
    let payload:Record<string,unknown>|null=null;
    const solana=await SolanaService.create(f.c,f.engine,{fetcher:async(_url,init)=>{payload=JSON.parse(String(init?.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{data:[],paginationToken:null}}),{status:200});}});
    const http=new JsonHttp(solana.rpcFetch,0),history=new f.core.HistorySource(f.c.core,{request:(url,init,attempts)=>http.request(url,init,attempts)});
    await history.page(leader,100,110,null);assert.ok(payload);const params=(payload as Record<string,unknown>).params as [string,Record<string,unknown>];
    assert.equal(params[1].commitment,'finalized');assert.equal(params[1].maxSupportedTransactionVersion,1);assert.deepEqual((params[1].filters as Record<string,unknown>).tokenTransfer,{direction:'any'});
    assert.ok(JSON.stringify(solana.quota.snapshot()).includes('10'));
  }finally{await f.cleanup();}
});

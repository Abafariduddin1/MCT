import test from 'node:test';import assert from 'node:assert/strict';
import {Http,Jupiter} from '../src/api.mjs';import {config,USDC,SOL} from '../src/config.mjs';import {HistorySource} from '../src/history.mjs';
import {token,quote,mint,leader} from './helpers.mjs';
test('an urgent exit overtakes queued discovery without exceeding the shared rate interval',async()=>{
  const order=[],starts=[];const http=new Http(30,async url=>{order.push(url);starts.push(performance.now());return{ok:true,json:async()=>[]};});
  await http.request('first');const discovery=http.request('discovery',{},1,{priority:20});const urgent=http.request('exit',{},1,{priority:0});
  await Promise.all([discovery,urgent]);assert.deepEqual(order,['first','exit','discovery']);assert.ok(starts[1]-starts[0]>=25);assert.ok(starts[2]-starts[1]>=25);
});
test('discovery gets bandwidth under continuous fast refreshes while an urgent exit stays first',async()=>{
  const order=[],http=new Http(5,async url=>{order.push(url);return{ok:true,json:async()=>[]};});
  await http.request('first');
  const pending=[http.request('discovery',{},1,{priority:20})];
  for(let i=0;i<20;i++)pending.push(http.request('market-'+i,{},1,{priority:10}));
  pending.push(http.request('exit',{},1,{priority:0}));await Promise.all(pending);
  assert.equal(order[1],'exit');assert.ok(order.indexOf('discovery')<=4,'discovery must receive bandwidth before the refresh queue drains');
});
test('token metadata resolves 205 mints in three bounded batches and serves short-lived cache hits',async()=>{
  const c=config({}),requests=[];const http=new Http(0,async url=>{const ids=new URL(url).searchParams.get('query').split(',');requests.push(ids);return{ok:true,json:async()=>ids.map(id=>token(id))};});
  const api=new Jupiter(c,http),ids=Array.from({length:205},(_,i)=>`mint-${i}`);
  assert.equal((await api.tokens(ids)).length,205);assert.deepEqual(requests.map(x=>x.length),[100,100,5]);await api.tokens([ids[0]]);assert.equal(requests.length,3);
  await api.tokens([ids[0]],10,true);assert.equal(requests.length,4);
});
test('broad discovery exceeds the old cap and deduplicates category lists',async()=>{
  let call=0;const c=config({MAX_CANDIDATES:'200'});const api=new Jupiter(c,new Http(0,async()=>{call++;return{ok:true,json:async()=>Array.from({length:100},(_,i)=>token(`mint-${(call-1)*80+i}`))};}));
  const result=await api.candidates();assert.equal(result.length,200);assert.equal(new Set(result.map(t=>t.id)).size,200);assert.equal(call,3);
});
test('SOL exits receive exit fee/slippage caps rather than entry caps',async()=>{
  const c=config({PAPER_BASE:'SOL'});let url;
  const api=new Jupiter(c,new Http(0,async value=>{url=new URL(value);return{ok:true,json:async()=>({...quote(mint,SOL,'1000000',1),slippageBps:100})};}));
  await api.quote(mint,SOL,'1000000',undefined,{side:'sell'});assert.equal(url.searchParams.get('slippageBps'),'100');
});
test('filtered history requires finalized source data while processed hints remain wake notifications',async()=>{
  let request;const c=config({});const source=new HistorySource(c,new Http(0,async(_url,args)=>{request=JSON.parse(args.body);return{ok:true,json:async()=>({result:{data:[],paginationToken:null}})};}));
  await source.page(leader,100,200);assert.equal(request.params[1].commitment,'finalized');assert.equal(request.params[1].maxSupportedTransactionVersion,1);
  assert.throws(()=>config({COPY_COMMITMENT:'processed'}),/COMMITMENT/);
  assert.throws(()=>config({COPY_COMMITMENT:'confirmed'}),/COMMITMENT/);
});
test('cancelling queued discovery removes its rate-limit timer and makes no request',async()=>{
  let calls=0;const http=new Http(60000,async()=>{calls++;return{ok:true,json:async()=>[]};});
  http.next=Date.now()+60000;const controller=new AbortController();
  const pending=http.request('cancelled-discovery',{signal:controller.signal});const rejected=assert.rejects(pending,/cancelled/);
  controller.abort();await rejected;await new Promise(r=>setTimeout(r,0));
  assert.equal(calls,0);assert.equal(http.queue.length,0);assert.equal(http.running,false);assert.equal(http.rateWake.waiter,null);
});
test('cancelling an in-flight read aborts the fetch without a retry',async()=>{
  let calls=0,started;const start=new Promise(r=>{started=r;});
  const http=new Http(0,async(_url,{signal})=>{calls++;started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));});
  const controller=new AbortController(),pending=http.request('inflight',{signal:controller.signal});const rejected=assert.rejects(pending,/cancelled/);
  await start;controller.abort();await rejected;await new Promise(r=>setTimeout(r,0));
  assert.equal(calls,1);assert.equal(http.running,false);
});

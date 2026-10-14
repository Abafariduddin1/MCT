import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {config,TOKEN_PROGRAM} from '../src/config.mjs';import {WalletStream} from '../src/stream.mjs';import {WakeSignal} from '../src/wake.mjs';
import {leader,mint} from './helpers.mjs';
import {FakeSocket} from './fake-socket.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function tokenFrame(subscription,amount=1,owner=leader){
  const data=Buffer.alloc(165);new PublicKey(mint).toBuffer().copy(data);new PublicKey(owner).toBuffer().copy(data,32);data.writeBigUInt64LE(BigInt(amount),64);data[108]=1;
  return{method:'programNotification',params:{subscription,result:{context:{slot:101},value:{pubkey:mint,account:{owner:TOKEN_PROGRAM,data:[data.toString('base64'),'base64']}}}}};
}
test('standard stream uses processed native and owner-filtered classic token subscriptions without address logs',async()=>{
  const c=config({RPC_HTTP_URL:'https://rpc.invalid/?api-key=hidden'}),events=[];const s=new WalletStream(c,leader,e=>events.push(e),()=>{},FakeSocket);
  try{s.start();await delay(5);const ws=s.socket;assert.equal(s.health.ready,true);assert.equal(ws.requests[0].method,'accountSubscribe');
    const request=ws.requests.find(r=>r.method==='programSubscribe');assert.equal(request.params[1].commitment,'processed');assert.equal(request.params[1].filters[1].memcmp.bytes,leader);
    assert.equal(ws.requests.some(r=>r.method==='logsSubscribe'||r.method==='transactionSubscribe'),false);
    ws.message(tokenFrame(request.id,100));ws.message(tokenFrame(request.id,100));ws.message(tokenFrame(request.id,90));assert.equal(events.length,2);
  }finally{s.stop();}
});
test('unowned/malformed account notifications cannot wake copy trading',async()=>{
  const c=config({RPC_HTTP_URL:'https://rpc.invalid'}),events=[];const s=new WalletStream(c,leader,e=>events.push(e),()=>{},FakeSocket);
  try{s.start();await delay(5);const ws=s.socket,id=ws.requests.find(r=>r.method==='programSubscribe').id;
    ws.message(tokenFrame(id,100,mint));ws.message({method:'programNotification',params:{subscription:id,result:{context:{slot:101},value:{}}}});assert.equal(events.length,0);
  }finally{s.stop();}
});
test('a disconnected socket reconnects and restores subscriptions while keeping usage counts',async()=>{
  const c=config({RPC_HTTP_URL:'https://rpc.invalid'});const s=new WalletStream(c,leader,()=>{},()=>{},FakeSocket);
  try{s.start();await delay(5);const first=s.socket;first.close();assert.equal(s.health.ready,false);await delay(280);
    assert.notEqual(s.socket,first);assert.equal(s.health.ready,true);assert.equal(s.usage.connections,2);
  }finally{s.stop();}
});
test('stream byte/credit budgets stop the connection without reconnecting around the cap',async()=>{
  const c=config({RPC_HTTP_URL:'https://rpc.invalid',STREAM_MAX_BYTES_PER_DAY:'10000'});const s=new WalletStream(c,leader,()=>{},()=>{},FakeSocket);
  try{s.start();await delay(5);s.usage.bytes=9999;s.socket.message({method:'unused',data:'large'});assert.equal(s.stopped,true);assert.equal(s.health.ready,false);assert.match(s.health.error,/budget/);
  }finally{s.stop();}
});
test('the read-only feed probe stops all timers and sockets after subscriptions are acknowledged',async()=>{
  const c=config({RPC_HTTP_URL:'https://rpc.invalid'});const r=await WalletStream.probe(c,leader,100,FakeSocket);assert.equal(r.ready,true);assert.equal(FakeSocket.all.at(-1).closed,true);
});
test('a wake notification removes the scheduler timer delay',async()=>{
  const wake=new WakeSignal(),at=performance.now();const waiting=wake.wait(1000);wake.wake();await waiting;assert.ok(performance.now()-at<100);
  wake.wake();await wake.wait(1000);
});

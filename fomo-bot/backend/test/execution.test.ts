import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {JitoExecutor} from '../src/jitoExecutor.js';import {JsonHttp} from '../src/http.js';
import {temp,preparedFixture,mint} from './helpers.js';import type {ValidatedSwap} from '../src/types.js';
test('Jito accepts only a guarded swap with durable intent and reports submitted rather than filled',async()=>{
  const t=temp();try{
    const f=await preparedFixture(t.root);let sends=0;
    const executor=new JitoExecutor(f.c,new JsonHttp(async(_url,init)=>{sends++;const body=JSON.parse(String(init?.body));assert.equal(body.method,'sendBundle');assert.equal(body.params[0].length,1);return new Response(JSON.stringify({result:'ab'.repeat(32)}));},0));
    const receipt=await executor.send(f.swap!);assert.equal(receipt.stage,'submitted');assert.equal(receipt.signature,f.swap!.signature);assert.equal(sends,1);
    assert.equal(f.validations,2);assert.equal(f.gates,2);await assert.rejects(()=>executor.send(f.swap!),/already attempted/);assert.equal(sends,1);
  }finally{t.cleanup();}
});
test('a missing durable ledger intent prevents any submission',async()=>{
  const t=temp();try{
    const f=await preparedFixture(t.root,{persisted:false});let sends=0;const executor=new JitoExecutor(f.c,new JsonHttp(async()=>{sends++;throw Error('should not call');},0));
    await assert.rejects(()=>executor.send(f.swap!),/durable/);assert.equal(sends,0);
  }finally{t.cleanup();}
});
test('unknown execution outcomes are attempted once and remain blocked after a restart',async()=>{
  const t=temp();try{
    const f=await preparedFixture(t.root);let calls=0;const http=new JsonHttp(async()=>{calls++;throw Error('network timeout');},0);
    await assert.rejects(()=>new JitoExecutor(f.c,http).send(f.swap!));assert.equal(calls,1);
    await assert.rejects(()=>new JitoExecutor(f.c,http).send(f.swap!),/already attempted/);assert.equal(calls,1);
  }finally{t.cleanup();}
});
test('untrusted serialized swap objects and wrong tip destinations cannot authorize a bundle',async()=>{
  const t=temp();try{
    const f=await preparedFixture(t.root);const executor=new JitoExecutor(f.c,new JsonHttp(async()=>{throw Error('unexpected request');},0));
    await assert.rejects(()=>executor.send({...f.swap!} as ValidatedSwap),/guarded preparation/);
    const wrong=temp();try{const other=await preparedFixture(wrong.root,{recipient:Keypair.generate().publicKey.toBase58()});await assert.rejects(()=>new JitoExecutor(other.c).send(other.swap!),/Unexpected top-level/);}finally{wrong.cleanup();}
  }finally{t.cleanup();}
});
test('tip caps and expiry are enforced before a network send',async()=>{
  for(const options of [{tip:2000},{expiry:50}]){
    const t=temp();try{const f=await preparedFixture(t.root,options);let sends=0;const executor=new JitoExecutor(f.c,new JsonHttp(async()=>{sends++;throw Error('unexpected');},0));
      await assert.rejects(()=>executor.send(f.swap!));assert.equal(sends,0);
    }finally{t.cleanup();}
  }
});
test('the paper preparation path cannot read keys or generate a signed live trade',async()=>{
  const t=temp();try{const f=await preparedFixture(t.root,{mode:'paper'});
    await assert.rejects(()=>f.service.prepare({side:'buy',mint,decimals:6,amountRaw:'1000000',quote:f.quote,expiresAt:null}),/Paper mode/);
    assert.equal(f.validations,0);
  }finally{t.cleanup();}
});

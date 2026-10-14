import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {Keypair} from '@solana/web3.js';
import {createVault,openVault} from '../src/walletVault.js';import {QuotaTracker} from '../src/quota.js';
import {solToLamports,imageUri} from '../src/util.js';import {feePlan} from '../src/feePolicy.js';
import {SolanaService,mintFacts} from '../src/solana.js';import {loadConfig} from '../src/config.js';
import {temp,settings,mintAccount,mint} from './helpers.js';
test('encrypted vault round-trips a wallet, refuses overwrite, and rejects the wrong key or altered data',()=>{
  const t=temp();try{
    const file=path.join(t.root,'wallet.vault.json'),key='ab'.repeat(32),wallet=Keypair.generate();
    createVault(file,key,wallet);assert.equal(openVault(file,key).publicKey.toBase58(),wallet.publicKey.toBase58());
    assert.ok(!fs.readFileSync(file,'utf8').includes(JSON.stringify([...wallet.secretKey])));assert.throws(()=>createVault(file,key));
    assert.throws(()=>openVault(file,'cd'.repeat(32)),/authentication/);
    const data=JSON.parse(fs.readFileSync(file,'utf8'));data.ciphertext=Buffer.alloc(64).toString('base64');fs.writeFileSync(file,JSON.stringify(data));
    assert.throws(()=>openVault(file,key),/authentication/);
  }finally{t.cleanup();}
});
test('quota reservations persist across instances and keep an exit reserve available',()=>{
  const t=temp();try{
    const file=path.join(t.root,'quota.json'),a=new QuotaTracker(file,10,2),b=new QuotaTracker(file,10,2);
    a.consume(4);b.consume(4);assert.equal(b.snapshot().spent,8);assert.throws(()=>a.consume(1),/budget/);
    a.consume(2,true);assert.equal(new QuotaTracker(file,10,2).snapshot().spent,10);assert.throws(()=>b.consume(1,true),/budget/);
  }finally{t.cleanup();}
});
test('quota budgets reset on a new UTC day and corrupt records cannot erase usage',()=>{
  const t=temp();try{
    let at=Date.UTC(2026,9,14);const file=path.join(t.root,'quota.json'),q=new QuotaTracker(file,2,0,()=>at);q.consume(2);at+=86400000;
    assert.equal(q.snapshot().remaining,2);q.consume(1);assert.equal(q.snapshot().spent,1);
    fs.writeFileSync(file,'{"day":"2026-10-15","spent":-1}');assert.throws(()=>new QuotaTracker(file,2),/Invalid quota/);
  }finally{t.cleanup();}
});
test('money parsing remains exact and token image URLs cannot point to local services',()=>{
  assert.equal(solToLamports('0.000000001'),1n);assert.equal(solToLamports('1.234567891'),1234567891n);
  for(const value of ['1e-3','-1','0.0000000001','NaN'])assert.throws(()=>solToLamports(value));
  assert.equal(imageUri('http://127.0.0.1/private'),null);assert.equal(imageUri('https://localhost/private'),null);
  assert.ok(imageUri('https://cdn.dexscreener.com/icon.png'));
});
test('dynamic fees convert micro-lamports per CU and cannot raise network/slippage caps',async()=>{
  const t=temp();try{
    const c=await settings(t.root),fees=feePlan(c,[10000,20000,30000,40000],0.01,'buy',400000);
    assert.equal(fees.priorityLamports,12000);assert.equal(fees.jitoTipLamports,1000);assert.equal(fees.capped,true);
    assert.ok(fees.networkCeilingLamports<=c.core.networkCap);assert.equal(feePlan(c,[],null,'sell').slippageBps,c.core.exitSlippage);
  }finally{t.cleanup();}
});
test('new backend config retains finalized copy history and rejects unsupported execution endpoints',async()=>{
  const t=temp();try{
    const c=await settings(t.root);assert.equal(c.core.copyCommitment,'finalized');assert.equal(c.allowMeteredPump,false);assert.equal(c.executionTransport,'jito');
    assert.equal(c.liveBase,'SOL');assert.equal(c.maxBuyLamports,100000000n);assert.equal(c.core.paperBase,'SOL');
    await assert.rejects(()=>loadConfig({JITO_ORIGIN:'https://example.com'}),/Unsupported/);
    await assert.rejects(()=>loadConfig({COPY_COMMITMENT:'confirmed'}),/COMMITMENT/);
  }finally{t.cleanup();}
});
test('on-chain mint parsing refuses extended or authority-bearing mints',()=>{
  const account=mintAccount();assert.equal(mintFacts(mint,account).mintAuthorityRevoked,true);
  account.data.writeUInt32LE(1,0);assert.equal(mintFacts(mint,account).mintAuthorityRevoked,false);
  account.data=Buffer.alloc(200);assert.equal(mintFacts(mint,account).classic,false);
});
test('read-only Solana services use the real SDK, meter RPC, and never open a wallet',async()=>{
  const t=temp();try{
    const c=await settings(t.root);let calls=0,opened=0;
    const service=await SolanaService.create(c,{assertAllowed:async()=>{throw Error('read-only');},assertPersisted:async()=>{throw Error('read-only');}},{
      fetcher:async(_input,init)=>{calls++;const request=JSON.parse(String(init?.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:12345}),{headers:{'content-type':'application/json'}});},
      walletLoader:()=>{opened++;return Keypair.generate();}
    });
    assert.equal(await service.connection.getSlot('confirmed'),12345);assert.equal(calls,1);assert.equal(opened,0);assert.equal(service.quota.snapshot().spent,1);
    await assert.rejects(()=>service.prepare({side:'buy',mint,decimals:6,amountRaw:'1000000',quote:{},expiresAt:null}),/Paper mode/);
  }finally{t.cleanup();}
});

test('the actual SDK can use reserved RPC credits for an exit path while background reads stay blocked',async()=>{
  const t=temp();try{
    const c=await settings(t.root,{RPC_CREDIT_BUDGET_PER_DAY:'100',RPC_EXIT_RESERVE_CREDITS:'10'});let calls=0;
    const service=await SolanaService.create(c,{assertAllowed:async()=>{throw Error('read-only');},assertPersisted:async()=>{throw Error('read-only');}},{
      fetcher:async(_input,init)=>{calls++;const request=JSON.parse(String(init?.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:1000}));}
    });
    service.quota.consume(90);await assert.rejects(()=>service.connection.getSlot('confirmed'),/budget/);assert.equal(calls,0);
    assert.equal(await service.withExitBudget(()=>service.connection.getSlot('confirmed')),1000);assert.equal(calls,1);
    await assert.rejects(()=>service.connection.getSlot('confirmed'),/budget/);assert.equal(service.quota.snapshot().spent,91);
  }finally{t.cleanup();}
});

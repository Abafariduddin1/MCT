import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {PriceReference,solCostMicroUsdc} from '../src/priceReference.js';
import {parseBuildQuote,JupiterBuild} from '../src/jupiterBuild.js';
import {TipFloor} from '../src/tipFloor.js';
import {JsonHttp} from '../src/http.js';
import {dynamicSlippage,nativeFeePlan} from '../src/feePolicy.js';
import {RpcExecutor} from '../src/rpcExecutor.js';
import {JitoExecutor} from '../src/jitoExecutor.js';
import {validatedPayload} from '../src/solana.js';
import {verifyNativeRoute,strengthenNativeMinimum} from '../src/nativeRoute.js';
import {loadCore} from '../src/core.js';
import {SOL,USDC} from '../src/constants.js';
import {temp,settings,mint} from './helpers.js';
import {nativeFixture,rawBuild,tokenInfo,RENT} from './native-fixture.js';

test('native build requests use zero platform fee, controlled wrapping and the chosen bundle mode',async()=>{
  const owner=Keypair.generate().publicKey.toBase58();let url='';
  const router=new JupiterBuild('test-only',new JsonHttp(async input=>{url=String(input);return new Response(JSON.stringify(rawBuild(owner)));},0));
  const quote=await router.quote({side:'buy',mint,amountRaw:'10000000',taker:owner,slippageBps:50,jito:true});
  const params=new URL(url).searchParams;assert.equal(params.get('platformFeeBps'),'0');assert.equal(params.get('wrapAndUnwrapSol'),'false');
  assert.equal(params.get('forJitoBundle'),'true');assert.equal(params.get('transactionVersion'),'0');assert.ok(params.get('destinationTokenAccount'));
  assert.equal(quote.inputMint,SOL);assert.equal(quote.outAmount,'1000000');
});

test('build parser rejects wrong assets, weaker minimum output, provider tips and duplicate fee instructions',()=>{
  const owner=Keypair.generate().publicKey.toBase58(),expected={side:'buy' as const,mint,amountRaw:'10000000',taker:owner,slippageBps:50};
  for(const changes of [{inputMint:USDC},{otherAmountThreshold:'1'},{transactionVersion:1},{tipInstruction:{}},{inAmount:'9999999'}])
    assert.throws(()=>parseBuildQuote({...rawBuild(owner),...changes},expected));
  const raw=rawBuild(owner);raw.computeBudgetInstructions=[...(raw.computeBudgetInstructions as unknown[]),...(raw.computeBudgetInstructions as unknown[])];
  assert.throws(()=>parseBuildQuote(raw,expected),/Duplicate/);
});

test('price reference caches concurrent requests and sizes SOL with conservative integer rounding',async()=>{
  let calls=0;const prices={[SOL]:{usdPrice:100.000000001,decimals:9,blockId:1000},[USDC]:{usdPrice:1,decimals:6,blockId:1000}};
  const oracle=new PriceReference('test-only',async()=>1000,new JsonHttp(async()=>{calls++;return new Response(JSON.stringify(prices));},0));
  const refs=await Promise.all([oracle.get(),oracle.get(),oracle.get()]);assert.equal(calls,1);assert.equal(refs[0]!.solUsd,100.000000001);
  assert.ok(solCostMicroUsdc(10000000n,refs[0]!)>=1000000n);assert.ok(oracle.peek());
  assert.throws(()=>solCostMicroUsdc(1n,{...refs[0]!,at:Date.now()-20000}),/fresh/);
});

test('missing, stale, future or depegged reference data blocks SOL sizing',async()=>{
  const good={[SOL]:{usdPrice:100,decimals:9,blockId:1000},[USDC]:{usdPrice:1,decimals:6,blockId:1000}};
  for(const value of [{[SOL]:good[SOL]},{...good,[SOL]:{...good[SOL],blockId:1}},{...good,[SOL]:{...good[SOL],blockId:1100}},
    {...good,[USDC]:{...good[USDC],usdPrice:0.7}}]) {
    const oracle=new PriceReference('test-only',async()=>1000,new JsonHttp(async()=>new Response(JSON.stringify(value)),0));
    await assert.rejects(()=>oracle.get());assert.equal(oracle.peek(),null);
  }
});

test('native fee caps bound even uint64 suggestions and RPC omits the Jito tip',async()=>{
  const t=temp();try {
    const c=await settings(t.root),plan=nativeFeePlan(c,2n**64n-1n,480000,0.1);
    assert.ok(plan.networkCeilingLamports<=c.core.networkCap);assert.ok(plan.priorityLamports<=c.core.priority);assert.equal(plan.jitoTipLamports,1000);assert.equal(plan.capped,true);
    const rpc=await settings(t.root,{EXECUTION_TRANSPORT:'rpc'});assert.equal(nativeFeePlan(rpc,10000n,480000).jitoTipLamports,0);
    assert.equal(dynamicSlippage(c,'buy',0),10);assert.equal(dynamicSlippage(c,'buy',100),c.core.slippage);
    assert.equal(dynamicSlippage(c,'sell',100),c.core.exitSlippage);assert.throws(()=>dynamicSlippage(c,'buy',-1));
  }finally {t.cleanup();}
});

test('stale or unavailable optional tip floor never raises the configured minimum/cap',async()=>{
  const stale=new TipFloor(new JsonHttp(async()=>new Response(JSON.stringify([{time:'2024-01-01T00:00:00Z',landed_tips_50th_percentile:1}])),0));
  assert.equal(await stale.get(),null);
  const current=new TipFloor(new JsonHttp(async()=>new Response(JSON.stringify([{time:new Date().toISOString(),landed_tips_50th_percentile:0.001}])),0));
  assert.equal(await current.get(),0.001);
});

test('native SOL buy is decoded, simulated twice and signed before guarded Jito submission',async()=>{
  const t=temp();try {
    const f=await nativeFixture(t.root),swap=await f.prepare();assert.equal(swap.base,'SOL');assert.equal(f.simulations,2);assert.equal(f.assertions,2);
    const payload=validatedPayload(swap);assert.equal(payload.prepared.nativeAudit!.rentDeltaLamports,RENT);
    const tx=VersionedTransaction.deserialize(Buffer.from(payload.prepared.signedTransaction,'base64'));assert.equal(tx.message.header.numRequiredSignatures,1);
    let sends=0;const jito=new JitoExecutor(f.c,new JsonHttp(async()=>{sends++;return new Response(JSON.stringify({result:'ab'.repeat(32)}));},0));
    const receipt=await jito.send(swap);assert.equal(receipt.stage,'submitted');assert.equal(sends,1);
  }finally {t.cleanup();}
});

test('native buy receipt separates SOL input, rent and fees from its token credit',async()=>{
  const t=temp();try {
    const f=await nativeFixture(t.root),swap=await f.prepare(),payload=validatedPayload(swap);
    const receipt=await f.service.chain.settlement({...payload.prepared},'finalized');
    assert.equal(receipt.kind,'success');assert.equal(receipt.baseDelta,'-10000000');assert.equal(receipt.tokenDelta,'1000000');
    assert.equal(receipt.rentDeltaLamports,RENT);assert.equal(receipt.tipLamports,1000);
  }finally {t.cleanup();}
});

test('native token sale unwraps proceeds and reports the gross SOL receipt separately from fees',async()=>{
  const t=temp();try {
    const f=await nativeFixture(t.root,{side:'sell'}),swap=await f.prepare(),payload=validatedPayload(swap);
    const receipt=await f.service.chain.settlement({...payload.prepared},'finalized');
    assert.equal(receipt.kind,'success');assert.equal(receipt.baseDelta,'15000000');assert.equal(receipt.tokenDelta,'-1000000');assert.equal(receipt.rentDeltaLamports,0);
  }finally {t.cleanup();}
});

test('an unexpected SOL debit, unrelated token debit or frozen output is rejected before submission',async()=>{
  for(const corruption of ['one-lamport','unrelated-token','freeze'] as const) {
    const t=temp();try {const f=await nativeFixture(t.root,{corruptSimulation:corruption});await assert.rejects(()=>f.prepare());assert.equal(f.sends,0);}finally {t.cleanup();}
  }
});

test('native sizing enforces both the SOL cap and an independently priced all-in position ceiling',async()=>{
  const t=temp();try {
    const overSol=await nativeFixture(t.root,{amount:110000000n});await assert.rejects(()=>overSol.prepare(),/MAX_BUY_SOL/);assert.equal(overSol.simulations,0);
    const overValue=await nativeFixture(t.root,{amount:40000000n,solPrice:500});await assert.rejects(()=>overValue.prepare(),/position cap/);assert.equal(overValue.simulations,0);
  }finally {t.cleanup();}
});

test('funded wrapped SOL, excessive actual fee and an expired blockhash refuse native execution',async()=>{
  for(const options of [{fundedWsol:true},{actualFeeExtra:200000},{expired:true}]) {
    const t=temp();try {const f=await nativeFixture(t.root,options);await assert.rejects(()=>f.prepare());assert.equal(f.sends,0);}finally {t.cleanup();}
  }
});

test('native RPC transport submits once without tip and does not retry an ambiguous send',async()=>{
  const t=temp();try {
    const f=await nativeFixture(t.root,{transport:'rpc'}),swap=await f.prepare(),rpc=new RpcExecutor(f.c);
    const receipt=await rpc.send(swap);assert.equal(receipt.stage,'submitted');assert.equal(f.sends,1);
    await assert.rejects(()=>new RpcExecutor(f.c).send(swap),/already attempted/);assert.equal(f.sends,1);
  }finally {t.cleanup();}
  const u=temp();try {
    const f=await nativeFixture(u.root,{transport:'rpc'}),swap=await f.prepare();let attempts=0;
    f.connection.sendRawTransaction=async()=>{attempts++;throw Error('network timeout');};
    await assert.rejects(()=>new RpcExecutor(f.c).send(swap),/unknown/);await assert.rejects(()=>new RpcExecutor(f.c).send(swap),/already attempted/);assert.equal(attempts,1);
  }finally {u.cleanup();}
});

test('two Jito executor instances sharing state cannot race into duplicate submission',async()=>{
  const t=temp();try {
    const f=await nativeFixture(t.root),swap=await f.prepare();let sends=0;
    const http=new JsonHttp(async()=>{sends++;return new Response(JSON.stringify({result:'ab'.repeat(32)}));},0);
    const results=await Promise.allSettled([new JitoExecutor(f.c,http).send(swap),new JitoExecutor(f.c,http).send(swap)]);
    assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(sends,1);
  }finally {t.cleanup();}
});

test('an absent durable native intent blocks both transport paths',async()=>{
  for(const transport of ['jito','rpc'] as const) {
    const t=temp();try {
      const f=await nativeFixture(t.root,{transport,persisted:false}),swap=await f.prepare();let sends=0;
      const executor=transport==='rpc'?new RpcExecutor(f.c):new JitoExecutor(f.c,new JsonHttp(async()=>{sends++;throw Error('unexpected');},0));
      await assert.rejects(()=>executor.send(swap),/durable/);assert.equal(f.sends+sends,0);
    }finally {t.cleanup();}
  }
});

test('changed encoded route fees and unapproved auxiliary instructions refuse signing',async()=>{
  for(const problem of ['route-fee','auxiliary-program','bad-timestamp','impact'] as const) {
    const t=temp();try {
      const f=await nativeFixture(t.root);
      if(problem==='route-fee')f.quote.instructions[0]!.data[f.quote.instructions[0]!.data.length-1]=1;
      if(problem==='auxiliary-program')f.quote.instructions[0]!.programId=Keypair.generate().publicKey;
      if(problem==='bad-timestamp')f.quote.receivedAt=NaN;
      if(problem==='impact')f.quote.priceImpact=2;
      await assert.rejects(()=>f.prepare());assert.equal(f.sends,0);assert.equal(f.simulations,0);
    }finally {t.cleanup();}
  }
});

test('native confirmation waits for requested finality and never trusts a transport acknowledgement',async()=>{
  const t=temp();try {
    const f=await nativeFixture(t.root),swap=await f.prepare(),payload=validatedPayload(swap);
    f.connection.getSignatureStatuses=async()=>({context:{slot:1000},value:[{slot:1000,confirmations:1,err:null,confirmationStatus:'confirmed'}]});
    assert.equal((await f.service.chain.settlement({...payload.prepared},'finalized')).kind,'pending');
  }finally {t.cleanup();}
});

test('native sell preparation remains available when the SOL valuation source is unavailable',async()=>{
  const t=temp();try {
    const f=await nativeFixture(t.root,{side:'sell'});f.service.reference.get=async()=>{throw Error('valuation unavailable');};
    const swap=await f.prepare();assert.equal(swap.side,'sell');assert.equal(f.simulations,2);
  }finally {t.cleanup();}
});

test('a receipt whose signed message is changed cannot become a confirmed fill',async()=>{
  const t=temp();try {
    const f=await nativeFixture(t.root),swap=await f.prepare(),payload=validatedPayload(swap),read=f.connection.getTransaction.bind(f.connection);
    f.connection.getTransaction=async(signature,options)=>{
      const receipt=await read(signature,options);if(receipt)receipt.transaction.message.recentBlockhash=Keypair.generate().publicKey.toBase58();return receipt;
    };
    await assert.rejects(()=>f.service.chain.settlement({...payload.prepared},'finalized'),/signature does not verify/);
  }finally {t.cleanup();}
});

test('a captured real unsigned V2 build validates all limits after conservative one-unit rounding',async()=>{
  const raw=JSON.parse(fs.readFileSync(new URL('../../test/fixtures/jupiter-build-v2-readonly.json',import.meta.url),'utf8'));
  const quote=parseBuildQuote(raw,{side:'buy',mint:raw.outputMint,amountRaw:raw.inAmount,taker:'96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',slippageBps:50});
  const modules=await loadCore(),data=strengthenNativeMinimum(quote.swapData,BigInt(quote.otherAmountThreshold));
  assert.doesNotThrow(()=>verifyNativeRoute(data,BigInt(quote.inAmount),BigInt(quote.otherAmountThreshold),50,modules.verifyRouteInstruction));
  const changed=Buffer.from(data);changed.writeBigUInt64LE(1n,9);
  assert.throws(()=>verifyNativeRoute(changed,BigInt(quote.inAmount),BigInt(quote.otherAmountThreshold),50,modules.verifyRouteInstruction),/input/);
  const fee=Buffer.from(data);fee[27]=1;
  assert.throws(()=>verifyNativeRoute(fee,BigInt(quote.inAmount),BigInt(quote.otherAmountThreshold),50,modules.verifyRouteInstruction),/controls/);
  assert.throws(()=>verifyNativeRoute(Buffer.concat([data,Buffer.from([0])]),BigInt(quote.inAmount),BigInt(quote.otherAmountThreshold),50,modules.verifyRouteInstruction),/trailing/);
});

test('current V2 routing executes both native preparation flows with guarded simulation and receipts',async()=>{
  for(const side of ['buy','sell'] as const){
    const t=temp();try{
      const f=await nativeFixture(t.root,{side,layout:'v2'}),swap=await f.prepare(),payload=validatedPayload(swap);
      const receipt=await f.service.chain.settlement({...payload.prepared},'finalized');
      assert.equal(receipt.kind,'success');assert.equal(receipt.base,'SOL');assert.equal(f.simulations,2);
    }finally{t.cleanup();}
  }
});

test('an unrelated frozen airdrop cannot block a native exit',async()=>{
  const t=temp();try{
    const f=await nativeFixture(t.root,{side:'sell'}),read=f.connection.getTokenAccountsByOwner.bind(f.connection);
    const asset=Keypair.generate().publicKey.toBase58(),info=tokenInfo(f.owner,asset,1n);info.data[108]=2;
    f.connection.getTokenAccountsByOwner=async(owner,filter,config)=>{
      const result=await read(owner,filter,config);return{...result,value:[...result.value,{pubkey:Keypair.generate().publicKey,account:info}]};
    };
    const swap=await f.prepare();assert.equal(swap.side,'sell');assert.equal(f.simulations,2);
  }finally{t.cleanup();}
});

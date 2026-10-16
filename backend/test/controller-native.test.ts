import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {nativeFixture,RENT} from './native-fixture.js';
import {temp,mint} from './helpers.js';
import {evidence,reference,buy} from './controller-fixture.js';
import {BotEngine} from '../src/botEngine.js';
import {Ledger,initialLedger} from '../src/ledger.js';
import {loadControllerCore} from '../src/controllerCore.js';
import {ControllerProviders} from '../src/controllerProviders.js';
import {RpcExecutor} from '../src/rpcExecutor.js';
import {validatedPayload} from '../src/solana.js';
import {SOL} from '../src/constants.js';
import type {PortfolioGate} from '../src/types.js';
import type {RuntimePort,Quote,Settlement} from '../src/controllerTypes.js';

test('controller persists and books an actual guarded native SDK transaction through the RPC executor',async()=>{
  const t=temp();let ledger:Ledger|null=null;let engine:BotEngine|null=null;
  try{
    const gate:PortfolioGate={assertAllowed:async intent=>{assert.ok(engine);await engine.assertAllowed(intent);},assertPersisted:async sig=>{assert.ok(engine);await engine.assertPersisted(sig);}};
    const f=await nativeFixture(t.root,{transport:'rpc',amount:74000000n,out:7400000n,gate});
    const file=path.join(t.root,'native-ledger.json'),core=await loadControllerCore();
    ledger=new Ledger(file,()=>initialLedger({mode:'live',wallet:f.owner,cash:2000000000n,reference:reference(),normalPct:50,copyPct:30,leader:null,orderLamports:74000000n}),{mode:'live',wallet:f.owner});
    engine=new BotEngine(f.c,ledger);
    const walletCheck=ControllerProviders.prototype.checkWallet.bind({solana:f.service});
    const port:RuntimePort={
      reference:()=>f.service.reference.get(),candidate:async()=>evidence(mint),
      quote:async(side,asset,raw)=>side==='buy'?f.quote as unknown as Quote:{inputMint:asset,outputMint:SOL,inAmount:raw,outAmount:(BigInt(raw)*10n).toString(),otherAmountThreshold:(BigInt(raw)*990n/100n).toString(),priceImpact:0,receivedAt:Date.now()},
      checkWallet:walletCheck,prepare:intent=>f.service.prepare(intent),
      audit:swap=>structuredClone(validatedPayload(swap).prepared.nativeAudit!),
      send:async swap=>{
        const saved=JSON.parse(fs.readFileSync(file,'utf8'));
        assert.equal(saved.orders[0].stage,'prepared');assert.equal(saved.orders[0].signature,swap.signature);
        return new RpcExecutor(f.c).send(swap);
      },
      settlement:async(order,commitment)=>f.service.chain.settlement({signature:order.signature,nativeAudit:order.nativeAudit},commitment) as Promise<Settlement>
    };
    engine.attach(port,e=>core.screen(e.token,f.c.core,Date.now(),e.slot));
    engine.submitCommand(buy('real_native_fixture01',mint,'0.074'));await engine.idle();
    const pending=ledger.read();assert.equal(pending.orders[0]?.stage,'submitted',pending.commands[0]?.reason??'Expected guarded submission');
    assert.equal(f.simulations,2);assert.equal(f.sends,1);assert.equal(pending.positions.length,0);
    await engine.reconcile();const s=ledger.read(),receipt=s.orders[0]?.receipt;
    assert.ok(receipt&&receipt.kind==='success');assert.equal(s.positions[0]?.quantityRaw,'7400000');
    assert.equal(s.positions[0]?.costLamports,String(74000000+RENT+receipt.feeLamports));
    assert.equal(s.cashLamports,String(2000000000-74000000-RENT-receipt.feeLamports));
    assert.equal(s.orders[0]?.stage,'finalized');assert.equal(JSON.stringify(s).includes('signedTransaction'),false);
    await engine.reconcile();assert.equal(f.sends,1);assert.equal(ledger.read().positions.length,1);
  }finally{await engine?.stop();ledger?.close();t.cleanup();}
});

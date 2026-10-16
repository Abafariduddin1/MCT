import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Ledger,amount,equity,validateLedger,recoverControllerLock} from '../src/ledger.js';
import {BotEngine} from '../src/botEngine.js';
import {parseCommand} from '../src/protocol.js';
import {fixture,buy,sell,token,token2,FakePort,reference} from './controller-fixture.js';

test('paper entry, partial sale and full sale conserve exact cash and original cost',async()=>{
  const f=await fixture();try{
    f.engine.submitCommand(buy());await f.engine.idle();let s=f.ledger.read();assert.equal(s.orders[0]?.stage,'finalized');
    // 0.05 SOL plus 56,000 network + 1,000 rent; token fill includes 30 bps adversity.
    assert.equal(s.cashLamports,'1949943000');assert.equal(s.positions[0]?.quantityRaw,'4985000');assert.equal(s.positions[0]?.costLamports,'50057000');
    assert.equal(s.buckets.reserve.cashLamports,'400000000');assert.equal(f.port.calls.prepare,0);assert.equal(f.port.calls.send,0);
    f.engine.submitCommand(sell('partial_sell_00000001',token,5000));await f.engine.idle();s=f.ledger.read();
    assert.equal(s.positions[0]?.quantityRaw,'2492500');assert.equal(s.positions[0]?.costLamports,'25028500');
    f.engine.submitCommand(sell());await f.engine.idle();s=f.ledger.read();assert.equal(s.positions.length,0);
    assert.equal(BigInt(s.cashLamports)-2000000000n,BigInt(s.realizedLamports));assert.equal(s.feesLamports,'168000');assert.equal(s.rentLamports,'1000');
    assert.equal(BigInt(s.cashLamports),Object.values(s.buckets).reduce((a,b)=>a+BigInt(b.cashLamports),0n));
  }finally{await f.cleanup();}
});
test('replayed ids return the original action and changed payloads cannot spend again',async()=>{
  const f=await fixture();try{f.engine.submitCommand(buy());f.engine.submitCommand(buy());await f.engine.idle();assert.equal(f.engine.submitCommand(buy()).stage,'finalized');assert.equal(f.ledger.read().positions.length,1);assert.equal(f.ledger.read().orders.length,1);assert.throws(()=>f.engine.submitCommand(buy('buy_command_00000001',token,'0.04')),/different content/);}finally{await f.cleanup();}
});
test('all-in cap rejects an amount whose principal alone equals the limit',async()=>{
  const f=await fixture({MAX_POSITION_USDC:'5'});try{f.engine.submitCommand(buy());await f.engine.idle();assert.equal(f.ledger.read().commands[0]?.stage,'rejected');assert.equal(f.ledger.read().cashLamports,'2000000000');}finally{await f.cleanup();}
});
test('a manual trade cannot bypass a stale, incomplete or failed safety audit',async()=>{
  for(const mutation of [(e:ReturnType<typeof import('./controller-fixture.js').evidence>)=>{e.safety.checks[0]!.status='unknown';},(e:ReturnType<typeof import('./controller-fixture.js').evidence>)=>{e.at-=16000;},(e:ReturnType<typeof import('./controller-fixture.js').evidence>)=>{e.token.isVerified=false;}]){
    const f=await fixture();try{f.port.badEvidence=mutation;f.engine.submitCommand(buy());await f.engine.idle();assert.equal(f.ledger.read().commands[0]?.stage,'rejected');assert.equal(f.ledger.read().positions.length,0);}finally{await f.cleanup();}
  }
});
test('new launches remain blocked under every preset',async()=>{
  for(const preset of ['Safe','Fast','Degen']){const f=await fixture();try{
    f.engine.submitCommand({v:1,id:'preset_command_00001',type:'SET_BOT_PRESET',preset,autoPilot:false,normalEnabled:true,copyEnabled:false,amountSol:'0.05'});
    f.port.badEvidence=e=>{e.token.firstPool.createdAt=new Date().toISOString();};f.engine.submitCommand(buy());await f.engine.idle();assert.equal(f.ledger.read().positions.length,0);assert.match(f.ledger.read().commands[1]!.reason!,/young/);
  }finally{await f.cleanup();}}
});
test('unowned tokens and invalid amounts never become financial requests',async()=>{
  const f=await fixture();try{
    for(const amountSol of ['-1','NaN','1e-3','0','0.0000000001',1])assert.throws(()=>f.engine.submitCommand({...buy(),amountSol}));
    for(const percentBps of [0,10001,0.5,'5000'])assert.throws(()=>f.engine.submitCommand({...sell(),percentBps}));
    f.engine.submitCommand(sell());await f.engine.idle();assert.equal(f.ledger.read().commands[0]?.stage,'rejected');assert.equal(f.port.calls.quote,0);
    assert.throws(()=>parseCommand({...buy(),extra:true}));assert.throws(()=>parseCommand({...buy(),v:2}));
  }finally{await f.cleanup();}
});
test('ledger lock and schema errors never reset saved capital',async()=>{
  const f=await fixture();try{
    assert.throws(()=>new Ledger(f.file,()=>{throw Error('Must not initialize');},{mode:'paper',wallet:'paper'}),/lock|running/);
    assert.throws(()=>recoverControllerLock(f.file),/still running/);
    const before=fs.readFileSync(f.file,'utf8');assert.throws(()=>f.ledger.transact(s=>{s.cashLamports='1';}),/conserve/);assert.equal(fs.readFileSync(f.file,'utf8'),before);
    const bad=f.ledger.read();bad.version=2 as 1;assert.throws(()=>validateLedger(bad),/Unsupported/);
  }finally{await f.cleanup();}
});
test('signed intent and exact audit are durable before a live transport is called',async()=>{
  const f=await fixture({MODE:'live',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES'});try{
    f.port.beforeSend=()=>{const saved=JSON.parse(fs.readFileSync(f.file,'utf8'));assert.equal(saved.orders[0].stage,'prepared');assert.ok(saved.orders[0].signature);assert.ok(saved.orders[0].nativeAudit);assert.equal(JSON.stringify(saved).includes('signedTransaction'),false);};
    f.engine.submitCommand(buy());await f.engine.idle();assert.equal(f.port.calls.send,1);assert.equal(f.ledger.read().positions.length,0);assert.equal(f.ledger.read().orders[0]?.stage,'submitted');
    await f.engine.reconcile();const cash=f.ledger.read().cashLamports;await f.engine.reconcile();assert.equal(f.ledger.read().cashLamports,cash);assert.equal(f.ledger.read().positions.length,1);
  }finally{await f.cleanup();}
});
test('unknown submission survives restart, is never resent and settles only once',async()=>{
  const f=await fixture({MODE:'live',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES'});try{
    f.port.sendError=true;f.engine.submitCommand(buy());await f.engine.idle();const pending=f.ledger.read().orders[0]!;assert.equal(pending.stage,'unknown');
    const restarted=new BotEngine(f.c,f.ledger),port=new FakePort(restarted);restarted.attach(port,e=>f.core.screen(e.token,f.c.core,Date.now(),e.slot));restarted.recover();
    port.receipt=()=>({kind:'pending'});await restarted.reconcile();restarted.submitCommand(buy());assert.equal(port.calls.send,0);assert.equal(f.ledger.read().orders[0]?.signature,pending.signature);
    port.receipt=null;await restarted.reconcile();assert.equal(f.ledger.read().positions.length,1);await restarted.reconcile();assert.equal(f.ledger.read().positions.length,1);assert.equal(port.calls.send,0);
  }finally{await f.cleanup();}
});
test('confirmed effects stay blocked until matching finalized receipt',async()=>{
  const f=await fixture({MODE:'live',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES',LIVE_SETTLEMENT_COMMITMENT:'confirmed'});try{
    f.engine.submitCommand(buy());await f.engine.idle();await f.engine.reconcile();const cash=f.ledger.read().cashLamports;assert.equal(f.ledger.read().orders[0]?.stage,'confirmed');
    f.engine.submitCommand(buy('second_buy_000000001',token2));assert.equal(f.ledger.read().commands[1]?.stage,'rejected');
    await f.engine.reconcile();assert.equal(f.ledger.read().orders[0]?.stage,'finalized');assert.equal(f.ledger.read().cashLamports,cash);
  }finally{await f.cleanup();}
});
test('failed transactions debit their fee without creating a position or double debit',async()=>{
  const f=await fixture({MODE:'live',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES',LIVE_SETTLEMENT_COMMITMENT:'confirmed'});try{
    f.port.receipt=(_o,commitment)=>({kind:'failed',nativeSpent:5000,feeLamports:5000,confirmation:commitment});f.engine.submitCommand(buy());await f.engine.idle();await f.engine.reconcile();await f.engine.reconcile();
    assert.equal(f.ledger.read().cashLamports,'1999995000');assert.equal(f.ledger.read().realizedLamports,'-5000');assert.equal(f.ledger.read().positions.length,0);assert.equal(f.ledger.read().orders[0]?.stage,'failed');
  }finally{await f.cleanup();}
});
test('finality disagreement halts entries and keeps the unresolved record',async()=>{
  const f=await fixture({MODE:'live',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES',LIVE_SETTLEMENT_COMMITMENT:'confirmed'});try{
    f.engine.submitCommand(buy());await f.engine.idle();await f.engine.reconcile();f.port.receipt=()=>({kind:'failed',nativeSpent:5000,feeLamports:5000,confirmation:'finalized'});
    await assert.rejects(()=>f.engine.reconcile(),/disagrees/);assert.match(f.ledger.read().risk.halt!,/Settlement/);assert.equal(f.ledger.read().orders[0]?.stage,'confirmed');
  }finally{await f.cleanup();}
});
test('panic cancels an in-flight buy before preparation and blocks manual entry',async()=>{
  const f=await fixture();try{
    let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});f.port.beforeQuote=()=>barrier;
    f.engine.submitCommand(buy());await new Promise(resolve=>setTimeout(resolve,10));f.engine.submitCommand({v:1,id:'panic_command_000001',type:'PANIC_CASH_OUT_ALL'});release();await f.engine.idle();
    assert.equal(f.ledger.read().settings.panic,true);assert.equal(f.ledger.read().positions.length,0);assert.equal(f.port.calls.send,0);
  }finally{await f.cleanup();}
});
test('panic sells only managed holdings and failed routes leave visible positions',async()=>{
  const f=await fixture();try{
    f.engine.submitCommand(buy());await f.engine.idle();f.engine.submitCommand({v:1,id:'panic_command_000001',type:'PANIC_CASH_OUT_ALL'});
    f.port.beforeQuote=async()=>{throw Error('No sell route');};await f.engine.tick();await f.engine.idle();assert.equal(f.ledger.read().positions.length,1);assert.equal(f.ledger.read().settings.autoPilot,false);assert.match(f.engine.health.lastError!,/route/);
  }finally{await f.cleanup();}
});
test('auto-pilot off retains protective stop exits',async()=>{
  const f=await fixture();try{
    f.engine.submitCommand(buy());await f.engine.idle();f.ledger.transact(s=>{s.positions[0]!.markLamports='1000000';s.positions[0]!.markAt=Date.now();});
    assert.equal(f.ledger.read().settings.autoPilot,false);await f.engine.tick();await f.engine.idle();assert.equal(f.ledger.read().positions.length,0);
  }finally{await f.cleanup();}
});
test('partial take profit is persisted once and a later target crossing does not repeat it',async()=>{
  const f=await fixture();try{
    f.engine.submitCommand({v:1,id:'preset_command_00001',type:'SET_BOT_PRESET',preset:'Fast',autoPilot:false,normalEnabled:true,copyEnabled:false,amountSol:'0.05'});
    f.engine.submitCommand(buy());await f.engine.idle();f.ledger.transact(s=>{const p=s.positions[0]!;p.markLamports='65000000';p.markAt=Date.now();});f.port.sellMultiplier=1.3;
    await f.engine.tick();await f.engine.idle();const p=f.ledger.read().positions[0]!;assert.equal(p.partialTaken,true);assert.equal(p.quantityRaw,'2492500');
    f.ledger.transact(s=>{const p=s.positions[0]!;p.markLamports='35000000';p.markAt=Date.now();});await f.engine.tick();await f.engine.idle();assert.equal(f.ledger.read().positions[0]!.quantityRaw,'2492500');
  }finally{await f.cleanup();}
});
test('a change in SOL reference does not become realized trading profit',async()=>{
  const f=await fixture();try{const before=f.engine.snapshot();f.ledger.transact(s=>{s.reference=reference(150);});const after=f.engine.snapshot();assert.equal(after.realizedTradingLamports,'0');assert.equal(after.capitalChangeLamports,'0');assert.equal(after.equityUsd,300);assert.equal(after.referenceOnlyChangeUsd,100);assert.equal(before.equityUsd,200);}finally{await f.cleanup();}
});
test('flat reallocation preserves drawdown history and reserve conservation',async()=>{
  const f=await fixture();try{
    f.ledger.transact(s=>{s.buckets.normal.highWaterLamports='1100000000';s.buckets.normal.halt='Existing loss halt';});
    f.engine.submitCommand({v:1,id:'allocation_command01',type:'SET_ALLOCATIONS',normalPct:40,copyPct:30,reservePct:30});const s=f.ledger.read();
    assert.equal(s.buckets.normal.highWaterLamports,'900000000');assert.equal(s.buckets.normal.halt,'Existing loss halt');assert.equal(s.buckets.reserve.cashLamports,'600000000');assert.equal(equity(s),2000000000n);
  }finally{await f.cleanup();}
});
test('a queued leader sale during a pending follower buy exits only the copied fraction',async()=>{
  const f=await fixture({MODE:'live',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES'});try{
    const bs58=(await import('bs58')).default,source=bs58.encode(new Uint8Array(64).fill(3)),saleSig=bs58.encode(new Uint8Array(64).fill(4));
    f.ledger.transact(s=>{s.settings.autoPilot=true;s.copy.lastPollAt=Date.now();s.copy.claims[source]=1001;});
    await f.engine.autoBuy(token,{bucket:'copy',strategy:'copy',at:Date.now(),expiresAt:Date.now()+30000,maxUnitUsdc:1.02,sourceSignature:source});
    assert.equal(f.ledger.read().orders[0]?.stage,'submitted');f.engine.claimCopy({side:'sell',mint:token,decimals:6,baseMint:'So11111111111111111111111111111111111111112',leaderBefore:'100',baseAmount:'1',tokenAmount:'50',at:Date.now()},saleSig,1002);
    await f.engine.reconcile();assert.equal(f.ledger.read().positions[0]?.queuedSellRaw,'2487500');assert.equal(f.ledger.read().positions[0]?.bucket,'copy');
    assert.equal(f.engine.claimCopy(null,saleSig,1002),false);
  }finally{await f.cleanup();}
});
test('gate refuses calls outside the engine authorization context',async()=>{
  const f=await fixture();try{await assert.rejects(()=>f.engine.assertAllowed({side:'buy',mint:token,decimals:6,amountRaw:'50000000',quote:{},expiresAt:null}),/authorization/);await assert.rejects(()=>f.engine.assertPersisted('missing'),/durably/);}finally{await f.cleanup();}
});
test('an interrupted unsigned order is rejected on recovery without a send',async()=>{
  const f=await fixture();try{
    f.engine.submitCommand(buy());await f.engine.idle();f.ledger.transact(s=>{s.orders[0]!.stage='preparing';s.orders[0]!.applied=false;s.orders[0]!.receipt=null;s.cashLamports=(amount(s.cashLamports)+amount(s.positions[0]!.costLamports)).toString();s.buckets.normal.cashLamports=(amount(s.buckets.normal.cashLamports)+amount(s.positions[0]!.costLamports)).toString();s.positions=[];s.commands[0]!.stage='preparing';});
    f.engine.recover();assert.equal(f.ledger.read().orders[0]?.stage,'rejected');assert.equal(f.port.calls.send,0);
  }finally{await f.cleanup();}
});
test('cash/cost-basis corruption is refused even when allocation cash still adds up',async()=>{
  const f=await fixture();try{assert.throws(()=>f.ledger.transact(s=>{s.cashLamports='1999999999';s.buckets.normal.cashLamports='999999999';}),/conserve funding/);assert.throws(()=>f.ledger.transact(s=>{s.cashLamports=2000000000 as unknown as string;}),/raw amount/);}finally{await f.cleanup();}
});
test('slow mark refresh does not hold the protection scheduler or block a panic exit',async()=>{
  const f=await fixture();let release!:()=>void;try{
    f.engine.submitCommand(buy());await f.engine.idle();const barrier=new Promise<void>(resolve=>{release=resolve;});let first=true;
    f.port.beforeQuote=async()=>{if(first){first=false;await barrier;}};
    await Promise.race([f.engine.tick(),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Monitor blocked on a mark request')),500))]);
    f.engine.submitCommand({v:1,id:'panic_command_000001',type:'PANIC_CASH_OUT_ALL'});await f.engine.tick();await f.engine.idle();assert.equal(f.ledger.read().positions.length,0);release();
  }finally{release?.();await f.cleanup();}
});
test('an unresolved buy reservation cannot be borrowed by a second command or reallocation',async()=>{
  const f=await fixture({MODE:'live',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES'});try{
    f.port.sendError=true;f.engine.submitCommand(buy());await f.engine.idle();assert.equal(f.engine.snapshot().reservedLamports,'50100000');
    f.engine.submitCommand(buy('second_buy_00000001',token2));f.engine.submitCommand({v:1,id:'allocation_command01',type:'SET_ALLOCATIONS',normalPct:80,copyPct:0,reservePct:20});
    assert.equal(f.ledger.read().commands[1]?.stage,'rejected');assert.equal(f.ledger.read().commands[2]?.stage,'rejected');assert.equal(f.ledger.read().orders.length,1);assert.equal(f.ledger.read().buckets.reserve.cashLamports,'400000000');
  }finally{await f.cleanup();}
});
test('halted loss budgets block new entries but retain exits',async()=>{
  const f=await fixture();try{f.engine.submitCommand(buy());await f.engine.idle();f.ledger.transact(s=>{s.risk.halt='Daily loss limit reached';});f.engine.submitCommand(buy('blocked_buy_00000001',token2));await f.engine.idle();assert.equal(f.ledger.read().commands[1]?.stage,'rejected');await f.engine.tick();await f.engine.idle();assert.equal(f.ledger.read().positions.length,0);}finally{await f.cleanup();}
});

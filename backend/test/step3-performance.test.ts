import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,buy,sell,token} from './controller-fixture.js';
import {strategyPerformance} from '../src/performance.js';
import {amount} from '../src/ledger.js';

function sleeve(f:Awaited<ReturnType<typeof fixture>>,value:bigint):void{
 f.ledger.transact(s=>{const old=amount(s.buckets.normal.cashLamports);s.buckets.normal.cashLamports=value.toString();s.buckets.normal.dayStartLamports=value.toString();s.buckets.normal.highWaterLamports=value.toString();s.buckets.copy.cashLamports=(amount(s.buckets.copy.cashLamports)+old-value).toString();});
}
test('entry cannot consume the cash required for its protective exit',async()=>{
 const f=await fixture();try{sleeve(f,10057000n);f.engine.submitCommand(buy('gas_reserve_test_0001',token,'0.01'));await f.engine.idle();assert.equal(f.ledger.read().positions.length,0);assert.equal(f.ledger.read().commands[0]?.stage,'rejected');assert.equal(f.port.calls.send,0);}finally{await f.cleanup();}
});
test('an exactly funded entry keeps its own exit fee and can sell without borrowing reserve',async()=>{
 const f=await fixture();try{sleeve(f,10113000n);f.engine.submitCommand(buy('gas_reserve_test_0001',token,'0.01'));await f.engine.idle();assert.equal(f.ledger.read().positions.length,1);assert.equal(f.ledger.read().buckets.normal.cashLamports,'56000');assert.equal(f.ledger.read().buckets.reserve.cashLamports,'400000000');f.engine.submitCommand(sell('dust_partial_test_0001',token,1));await f.engine.idle();assert.equal(f.ledger.read().commands[1]?.stage,'rejected');assert.equal(f.ledger.read().buckets.normal.cashLamports,'56000');f.engine.submitCommand(sell());await f.engine.idle();assert.equal(f.ledger.read().positions.length,0);assert.equal(f.ledger.read().buckets.reserve.cashLamports,'400000000');}finally{await f.cleanup();}
});
test('performance attributes partial exits to the entry strategy without counting multiple wins',async()=>{
 const f=await fixture();try{
  f.engine.submitCommand(buy());await f.engine.idle();f.port.sellMultiplier=1.5;f.engine.submitCommand(sell('strategy_partial_0001',token,5000));await f.engine.idle();
  let report=strategyPerformance(f.ledger.read()) as {strategies:Array<{strategy:string;closedTrades:number;wins:number;realizedLamports:string;feesLamports:string}>;realizedTradingLamports:string};
  assert.equal(report.strategies[0]?.strategy,'manual');assert.equal(report.strategies[0]?.closedTrades,0);assert.equal(report.strategies[0]?.wins,0);
  f.engine.submitCommand(sell());await f.engine.idle();report=strategyPerformance(f.ledger.read()) as typeof report;
  assert.equal(report.strategies[0]?.closedTrades,1);assert.equal(report.strategies[0]?.wins,1);assert.equal(report.strategies[0]?.feesLamports,'168000');assert.equal(report.realizedTradingLamports,f.ledger.read().realizedLamports);assert.equal(report.strategies.length,1);
 }finally{await f.cleanup();}
});
test('performance includes failed transaction fees and distinguishes unfinalized effects',async()=>{
 const f=await fixture({MODE:'live',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES',LIVE_SETTLEMENT_COMMITMENT:'confirmed'});try{
  f.port.receipt=(_o,commitment)=>({kind:'failed',nativeSpent:5000,feeLamports:5000,confirmation:commitment});f.engine.submitCommand(buy());await f.engine.idle();await f.engine.reconcile();
  let report=strategyPerformance(f.ledger.read()) as {containsUnfinalizedEffects:boolean;realizedTradingLamports:string;strategies:Array<{failedTransactions:number;closedTrades:number}>};
  assert.equal(report.realizedTradingLamports,'-5000');assert.equal(report.containsUnfinalizedEffects,true);assert.equal(report.strategies[0]?.failedTransactions,1);assert.equal(report.strategies[0]?.closedTrades,0);
  await f.engine.reconcile();report=strategyPerformance(f.ledger.read()) as typeof report;assert.equal(report.containsUnfinalizedEffects,false);assert.equal(report.realizedTradingLamports,'-5000');
 }finally{await f.cleanup();}
});

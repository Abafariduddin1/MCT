import test from 'node:test';
import assert from 'node:assert/strict';
import {JsonHttp} from '../src/http.js';
import {Notifications} from '../src/notifications.js';
import {startController} from '../src/controller.js';
import {fixture,buy} from './controller-fixture.js';

test('shared provider queue prioritizes exits and still gives old discovery a turn',async()=>{
  const calls:string[]=[];const client=new JsonHttp(async input=>{calls.push(String(input));return new Response('{}');},10);
  const jobs=[client.request('first',{},1),client.request('discovery',{},1,undefined,{priority:20}),client.request('mark1',{},1,undefined,{priority:10}),client.request('mark2',{},1,undefined,{priority:10}),client.request('mark3',{},1,undefined,{priority:10}),client.request('exit',{},1,undefined,{priority:0})];
  await Promise.all(jobs);assert.equal(calls[0],'exit');assert.ok(calls.indexOf('discovery')<calls.indexOf('mark3'));
});
test('notification failure never changes the ledger fill or submits another transaction',async()=>{
  const f=await fixture();try{
    f.engine.submitCommand(buy());await f.engine.idle();const cash=f.ledger.read().cashLamports;let calls=0;
    const alerts=new Notifications(f.ledger,'123456:'+'A'.repeat(25),'123456',async()=>{calls++;throw Error('offline');});
    alerts.tick();await alerts.stop();assert.equal(calls,1);assert.equal(f.ledger.read().cashLamports,cash);assert.equal(f.ledger.read().orders.length,1);assert.equal(f.ledger.read().notificationCursor,0);
    const disabled=new Notifications(f.ledger,'','',async()=>{throw Error('Must not contact any destination');});disabled.tick();await disabled.stop();
  }finally{await f.cleanup();}
});
test('default controller refuses missing provider setup before attempting wallet access',async()=>{
  const f=await fixture();try{await assert.rejects(()=>startController({...f.c,core:{...f.c.core,rpc:'https://example.invalid/YOUR_KEY',apiKey:''},walletVault:'/does-not-exist'}),/Configure/);assert.equal(f.ledger.read().mode,'paper');}finally{await f.cleanup();}
});

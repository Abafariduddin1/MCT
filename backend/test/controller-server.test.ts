import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {ControllerServer,validateServerSettings} from '../src/server.js';
import {fixture,buy} from './controller-fixture.js';

test('HTTP state requires header authentication; query credentials and browser origins are refused',async()=>{
  const f=await fixture(),server=new ControllerServer({...f.c,port:0},f.engine);try{
    const port=await server.listen(),url='http://127.0.0.1:'+port,headers={authorization:'Bearer '+f.c.appAccessToken};
    assert.equal((await fetch(url+'/v1/state')).status,401);
    assert.equal((await fetch(url+'/v1/state?token='+f.c.appAccessToken)).status,401);
    assert.equal((await fetch(url+'/v1/state',{headers:{...headers,origin:'https://untrusted.invalid'}})).status,401);
    assert.equal((await fetch(url+'/v1/state?token=anything',{headers})).status,400);
    const response=await fetch(url+'/v1/state',{headers});assert.equal(response.status,200);const text=await response.text();assert.equal(text.includes(f.c.appAccessToken),false);assert.equal(text.includes(f.c.core.rpc),false);assert.equal(JSON.parse(text).data.mode,'paper');
  }finally{await server.close();await f.cleanup();}
});
test('HTTP command ACK is not a fill, replay is durable, and reconnect reads the result',async()=>{
  const f=await fixture(),server=new ControllerServer({...f.c,port:0},f.engine);try{
    const port=await server.listen(),url='http://127.0.0.1:'+port,headers={authorization:'Bearer '+f.c.appAccessToken,'content-type':'application/json'};
    const post=()=>fetch(url+'/v1/command',{method:'POST',headers,body:JSON.stringify(buy())});
    const first=await post();assert.equal(first.status,202);const ack=await first.json() as {type:string;data:{stage:string}};assert.equal(ack.type,'COMMAND_ACK');assert.notEqual(ack.data.stage,'Filled');
    await f.engine.idle();await post();await f.engine.idle();assert.equal(f.ledger.read().orders.length,1);
    const status=await fetch(url+'/v1/commands/buy_command_00000001',{headers});const saved=await status.json() as {data:{stage:string}};assert.equal(saved.data.stage,'finalized');
    const invalid=await fetch(url+'/v1/command',{method:'POST',headers,body:JSON.stringify({...buy(),amountSol:'-2'})});assert.equal(invalid.status,400);
    const huge=await fetch(url+'/v1/command',{method:'POST',headers,body:' '.repeat(17000)});assert.equal(huge.status,413);
  }finally{await server.close();await f.cleanup();}
});
test('WebSocket authenticates at upgrade and supplies authoritative snapshots',async()=>{
  const f=await fixture(),server=new ControllerServer({...f.c,port:0},f.engine);let client:WebSocket|null=null;try{
    const port=await server.listen(),url='ws://127.0.0.1:'+port+'/stream';
    await new Promise<void>((resolve,reject)=>{const unauth=new WebSocket(url);unauth.on('open',()=>{unauth.terminate();reject(Error('Unauthorized connection opened'));});unauth.on('unexpected-response',(_req,response)=>{assert.equal(response.statusCode,401);response.resume();unauth.terminate();resolve();});unauth.on('error',()=>{});});
    const frames:Array<{type:string;data:Record<string,unknown>}>=[];
    client=new WebSocket(url,{headers:{authorization:'Bearer '+f.c.appAccessToken}});client.on('message',data=>frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve,reject)=>{client!.on('open',resolve);client!.on('error',reject);});
    client.send(JSON.stringify(buy()));await new Promise(resolve=>setTimeout(resolve,100));await f.engine.idle();
    assert.equal(frames[0]?.type,'PORTFOLIO_UPDATE');assert.ok(frames.some(row=>row.type==='COMMAND_ACK'));assert.equal(f.ledger.read().positions.length,1);
    client.send(JSON.stringify({v:1,type:'GET_SNAPSHOT'}));await new Promise(resolve=>setTimeout(resolve,50));assert.equal(frames.filter(r=>r.type==='PORTFOLIO_UPDATE').at(-1)?.data.mode,'paper');
    client.send('x'.repeat(17000));await new Promise<void>(resolve=>client!.once('close',()=>resolve()));
  }finally{client?.terminate();await server.close();await f.cleanup();}
});
test('external bindings require TLS and predictable controller credentials are refused',async()=>{
  const f=await fixture();try{assert.throws(()=>validateServerSettings({...f.c,host:'0.0.0.0'}),/TLS/);assert.throws(()=>validateServerSettings({...f.c,appAccessToken:'a'.repeat(64)}),/random/);assert.throws(()=>validateServerSettings(f.c,{tlsCert:'cert'}),/Both/);}finally{await f.cleanup();}
});

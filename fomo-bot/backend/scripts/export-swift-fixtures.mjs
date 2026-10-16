// Generates labelled protocol fixtures from the real local controller/server.
// No provider calls or funded trading occur. Run after npm run build.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocket} from 'ws';
import {ControllerServer} from '../dist/src/server.js';
import {fixture,buy,sell,token} from '../dist/test/controller-fixture.js';
import {FeedService} from '../dist/src/feed.js';
import {PumpStream} from '../dist/src/pumpStream.js';
import {DexScreener} from '../dist/src/dexScreener.js';
const f=await fixture();let server,client;
try{
 const feed=new FeedService(f.c,new PumpStream(f.c),new DexScreener(),{},()=>100);
 feed.ingest({kind:'create',mint:token,signature:null,name:'PROTOCOL FIXTURE',symbol:'TEST',marketCapSol:null,bondingPct:null,receivedAt:Date.now()});
 server=new ControllerServer({...f.c,port:0},f.engine,()=>feed.snapshot());
 const port=await server.listen(),frames=[];
 client=new WebSocket('ws://127.0.0.1:'+port+'/stream',{headers:{authorization:'Bearer '+f.c.appAccessToken}});
 client.on('message',data=>frames.push(JSON.parse(data.toString())));
 await new Promise((resolve,reject)=>{client.on('open',resolve);client.on('error',reject);});
 const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture frame timed out');};
 await until(()=>frames.some(r=>r.type==='FEED_UPDATE'));
 const selected={initial:frames.find(r=>r.type==='PORTFOLIO_UPDATE'),feed:frames.find(r=>r.type==='FEED_UPDATE')};
 client.send(JSON.stringify(buy()));await until(()=>frames.some(r=>r.type==='COMMAND_ACK'));await f.engine.idle();
 client.send(JSON.stringify({v:1,type:'GET_SNAPSHOT'}));await until(()=>frames.some(r=>r.type==='PORTFOLIO_UPDATE'&&r.data.positions.length===1));
 selected.position=frames.find(r=>r.type==='PORTFOLIO_UPDATE'&&r.data.positions.length===1);
 selected.ack=frames.find(r=>r.type==='COMMAND_ACK');
 client.send(JSON.stringify({v:1,type:'GET_CHART',mint:token}));await until(()=>frames.some(r=>r.type==='CHART_HISTORY'));selected.chart=frames.find(r=>r.type==='CHART_HISTORY');
 f.engine.submitCommand(sell());await f.engine.idle();
 client.send(JSON.stringify({v:1,type:'GET_PERFORMANCE'}));await until(()=>frames.some(r=>r.type==='STRATEGY_REPORT'));selected.performance=frames.find(r=>r.type==='STRATEGY_REPORT');
 await until(()=>frames.some(r=>r.type==='TRADE_ALERT'&&r.data.type==='TRADE_FILLED'));selected.alert=frames.find(r=>r.type==='TRADE_ALERT'&&r.data.type==='TRADE_FILLED');
 const completed=await fetch('http://127.0.0.1:'+port+'/v1/commands/buy_command_00000001',{headers:{authorization:'Bearer '+f.c.appAccessToken}}).then(r=>r.json());selected.completed=completed;
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../ios/Tests/FomoBotCoreTests/Fixtures');fs.mkdirSync(root,{recursive:true});
 fs.writeFileSync(path.join(root,'protocol-v1.json'),JSON.stringify({description:'Synthetic paper fixture from the actual local server. Not investment or market-performance data.',frames:selected},null,2)+'\n');
 console.log('Wrote '+Object.keys(selected).length+' real-server paper protocol fixtures.');
}finally{client?.terminate();await server?.close();await f.cleanup();}

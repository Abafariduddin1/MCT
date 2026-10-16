import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {config,SOL,USDC} from '../src/config.mjs';import {Store} from '../src/store.mjs';import {Engine} from '../src/engine.mjs';
import {mint,leader,token,transaction} from './helpers.mjs';import {FakeSocket} from './fake-socket.mjs';
export const turn=()=>new Promise(r=>setTimeout(r,0));
export async function realtimeFixture(extra={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'realtime-engine-'));
  const c=config({MODE:'paper',PAPER_BASE:'SOL',EUR_USD_REFERENCE:'1.1',DATA_DIR:root,COPY_LEADER:leader,RPC_HTTP_URL:'https://rpc.invalid',...extra});
  let slot=100,rows=[],price=1,pageCalls=0;const cache=new Map();
  const history={slot:async()=>slot,page:async(_leader,from,to)=>{pageCalls++;return{data:rows.filter(tx=>tx.slot>=from&&tx.slot<=to),paginationToken:null};}};
  const api={cachedToken:id=>cache.get(id),tokens:async ids=>{
    const result=ids.map(id=>id===SOL?{id,usdPrice:100}:id===USDC?{id,usdPrice:1}:token(id,price,1000));for(const row of result)cache.set(row.id,row);return result;
  },candidates:async()=>[token()],quote:async(i,o,a)=>{
    const input=Number(a),out=i===SOL?BigInt(Math.floor(input/1e9*100/price*1e6)):o===SOL?BigInt(Math.floor(input/1e6*price/100*1e9))
      :i===USDC?BigInt(Math.floor(input/price)):BigInt(Math.floor(input*price));
    return{inAmount:String(a),outAmount:String(out),otherAmountThreshold:String(out*9950n/10000n),priceImpact:0.1,receivedAt:Date.now()};
  },execute:async()=>{throw Error('Synthetic fixture must not submit');}};
  const chain={history,connection:{getSlot:async()=>1005},verifyMint:async()=>{}};
  const store=new Store(c),engine=new Engine(c,api,chain,store,async()=>{},{WebSocketClass:FakeSocket});await engine.init();engine.startStream();await turn();
  engine.nextScan=Date.now()+60000;engine.nextShortlist=Date.now()+60000;engine.nextMonitor=Date.now()+10000;engine.copyHint=null;engine.nextCopy=Date.now()+60000;
  return{root,c,store,engine,api,history,get pageCalls(){return pageCalls;},set slot(v){slot=v;},set rows(v){rows=v;},set price(v){price=v;},
    notify(atSlot=101){const ws=engine.stream.socket,id=ws.requests.find(r=>r.method==='accountSubscribe').id;
      ws.message({method:'accountNotification',params:{subscription:id,result:{context:{slot:atSlot},value:{lamports:atSlot*10000}}}});},
    buy(atSlot=101,signature='leader-buy'){slot=atSlot;rows=[transaction('buy','usdc',{slot:atSlot,signature})];},
    trim(atSlot=102,signature='leader-trim'){slot=atSlot;rows=[transaction('sell','usdc',{slot:atSlot,signature,amount:2000000})];},
    cleanup(){engine.stream?.stop();store.release();fs.rmSync(root,{recursive:true,force:true});}};
}

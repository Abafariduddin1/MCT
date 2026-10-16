import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {config,SOL,USDC} from '../src/config.mjs';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {assertPortfolio} from '../src/portfolio.mjs';
import {summary} from '../src/util.mjs';
import {mint,token,quote} from '../test/helpers.mjs';
console.log('SYNTHETIC DEMO: made-up prices, virtual money, no API connection or real wallet. This checks execution and accounting; it is not a backtest or profit forecast.');
async function demo(base){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bot-demo-'));
  const c=config({MODE:'paper',PAPER_BASE:base,EUR_USD_REFERENCE:'1.1',DATA_DIR:root,NORMAL_STRATEGIES:'momentum'});
  let price=1,block=1000,now=Date.now();const actualNow=Date.now;
  const api={candidates:async()=>[token(mint,price,block)],tokens:async ids=>ids.map(id=>id===SOL?{id,usdPrice:100}:id===USDC?{id,usdPrice:1}:token(id,price,block)),
    quote:async(i,o,a)=>{
      if(i!==SOL&&o!==SOL)return quote(i,o,a,price);
      const output=i===SOL?BigInt(Math.floor(Number(a)/1e9*100/price*1e6)):BigInt(Math.floor(Number(a)/1e6*price/100*1e9));
      return{inputMint:i,outputMint:o,inAmount:String(a),outAmount:String(output),otherAmountThreshold:String(output*9950n/10000n),priceImpact:0.1,receivedAt:Date.now()};
    },execute:async()=>{throw new Error('Demo never submits');}};
  const chain={connection:{getSlot:async()=>block+5},verifyMint:async()=>{}};
  const store=new Store(c),engine=new Engine(c,api,chain,store);
  try{
    Date.now=()=>now;await engine.init();
    for(let i=0;i<4;i++){now+=i?60000:0;price=1+i*0.003;block++;await engine.scan();}
    if(engine.s.positions.length!==1)throw new Error(`${base} demo failed to buy`);
    console.log(`${base} BUY CHECK PASSED: scanner created a costed paper position.`);
    now+=60000;price=1.4;block++;await engine.monitor();
    if(engine.s.positions.length||engine.s.trades.length!==1)throw new Error(`${base} demo failed to sell`);
    assertPortfolio(engine.s,'paper');store.read();
    console.log(`${base} SELL CHECK PASSED: position closed and fees/budgets reconciled.`);
    const result=summary(engine.s);console.log(JSON.stringify({paperBase:base,positions:result.openPositions.length,cashUsdc:engine.s.cash,
      ...(base==='SOL'?{cashSol:result.cashSol,estimatedEquityEur:result.estimatedEquityEur}:{}),completedPositions:engine.s.trades.length},null,2));
  }finally{Date.now=actualNow;store.release();fs.rmSync(root,{recursive:true,force:true});}
}
await demo('SOL');await demo('USDC');

import {performance} from 'node:perf_hooks';
import {realtimeFixture} from '../test/realtime-fixture.mjs';
const originalLog=console.log,times=[];const samples=30;
console.log=()=>{};
try{
  for(let i=0;i<samples;i++){
    const f=await realtimeFixture();
    try{
      f.buy();const at=performance.now();f.notify();await f.engine.step();
      if(f.engine.s.positions.length!==1)throw Error('Synthetic copy entry did not fill');times.push(performance.now()-at);
      f.trim();f.notify(102);f.engine.lastCopyFetch=0;await f.engine.step();await f.engine.step();
      if(f.engine.s.trades.length!==1||f.engine.s.trades[0].positionClosed!==false)throw Error('Synthetic proportional exit failed');
    }finally{f.cleanup();}
  }
}finally{console.log=originalLog;}
const sorted=[...times].sort((a,b)=>a-b),p=n=>sorted[Math.floor((sorted.length-1)*n)];
console.log(JSON.stringify({scope:'Synthetic protocol notification → SOL paper fill. Mock providers; real engine and disk accounting. Not mainnet or internet latency.',samples,
  targetMs:1000,p50Ms:p(0.5),p95Ms:p(0.95),maxMs:p(1),underTarget:samples-times.filter(t=>t>=1000).length,
  buyAndProportionalExitChecks:'passed',networkExecution:'NOT TESTED'},null,2));

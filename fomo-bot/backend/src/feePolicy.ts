import type {BackendConfig} from './config.js';
export interface FeePlan {priorityLamports:number;jitoTipLamports:number;slippageBps:number;networkCeilingLamports:number;capped:boolean}
export function feePlan(c:BackendConfig,prioritySamplesMicroLamports:number[]=[],tipFloorSol:number|null=null,side:'buy'|'sell'='buy',computeUnitLimit=400000):FeePlan{
  if(!Number.isSafeInteger(computeUnitLimit)||computeUnitLimit<1||computeUnitLimit>1400000)throw Error('Invalid compute unit limit');
  const valid=prioritySamplesMicroLamports.filter(x=>Number.isSafeInteger(x)&&x>=0).sort((a,b)=>a-b);
  const micro=valid[Math.floor((valid.length-1)*0.75)];
  const requestedRaw=micro!==undefined?(BigInt(micro)*BigInt(computeUnitLimit)+999999n)/1000000n:BigInt(c.core.priority);
  const requested=Number(requestedRaw>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(Number.MAX_SAFE_INTEGER):requestedRaw);
  const floor=tipFloorSol!==null&&Number.isFinite(tipFloorSol)&&tipFloorSol>=0?Math.ceil(tipFloorSol*1e9):1000;
  const tip=c.executionTransport==='rpc'?0:Math.min(Math.max(1000,floor),c.jitoMaxTip,c.core.jitoTip);
  if((c.executionTransport!=='rpc'&&tip<1000)||c.core.networkCap<5000+tip)throw Error('Fee budget cannot cover signature fee and minimum Jito tip');
  const priority=Math.min(requested,c.core.priority,c.core.networkCap-5000-tip);
  return{priorityLamports:priority,jitoTipLamports:tip,slippageBps:side==='buy'?c.core.slippage:c.core.exitSlippage,
    networkCeilingLamports:5000+priority+tip,capped:priority<requested||tip<floor};
}

export function dynamicSlippage(c:BackendConfig,side:'buy'|'sell',recentMovePct:number|null=null):number {
  const cap=side==='buy'?c.core.slippage:c.core.exitSlippage;
  if(recentMovePct===null)return cap;
  if(!Number.isFinite(recentMovePct)||recentMovePct<0)throw Error('Invalid recent price movement');
  return Math.min(cap,Math.max(10,Math.ceil(recentMovePct*100)+10));
}

export interface NativeFeePlan extends FeePlan {computePriceMicroLamports:bigint}
export function nativeFeePlan(c:BackendConfig,requestedMicro:bigint,units:number,tipFloorSol:number|null=null):NativeFeePlan {
  if(requestedMicro<0n||!Number.isSafeInteger(units)||units<1||units>1400000)throw Error('Invalid native compute budget');
  const tip=c.executionTransport==='jito'?Math.min(c.jitoMaxTip,c.core.jitoTip,
    Math.max(1000,tipFloorSol!==null&&Number.isFinite(tipFloorSol)&&tipFloorSol>=0?Math.ceil(tipFloorSol*1e9):1000)):0;
  const cap=Math.min(c.core.priority,c.core.networkCap-5000-tip);
  if(cap<0)throw Error('Network budget is below the signature fee and tip');
  const maxMicro=BigInt(cap)*1000000n/BigInt(units);
  const micro=requestedMicro<maxMicro?requestedMicro:maxMicro;
  const total=Number((micro*BigInt(units)+999999n)/1000000n);
  return {computePriceMicroLamports:micro,priorityLamports:total,jitoTipLamports:tip,slippageBps:c.core.slippage,
    networkCeilingLamports:5000+total+tip,capped:micro<requestedMicro||Boolean(tipFloorSol!==null&&tip<Math.ceil(tipFloorSol*1e9))};
}

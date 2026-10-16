import {amount,signed} from './ledger.js';
import type {LedgerState} from './controllerTypes.js';

/** A read-only reconstruction of recorded receipts, not a backtest. Entry fees
 * and rent are already in basis; sale fees are already in net proceeds. */
export function strategyPerformance(s:LedgerState):Record<string,unknown>{
  interface Group {strategy:string;bucket:string;entries:number;closed:number;wins:number;losses:number;flat:number;failed:number;realized:bigint;fees:bigint;rent:bigint;gains:bigint;loss:bigint;gross:bigint}
  interface Held {group:Group;quantity:bigint;cost:bigint;result:bigint}
  const groups=new Map<string,Group>(),held=new Map<string,Held>();let provisional=false;
  const group=(strategy:string,bucket:string)=>{const key=bucket+':'+strategy;let g=groups.get(key);if(!g){g={strategy,bucket,entries:0,closed:0,wins:0,losses:0,flat:0,failed:0,realized:0n,fees:0n,rent:0n,gains:0n,loss:0n,gross:0n};groups.set(key,g);}return g;};
  for(const o of s.orders){
    const receipt=o.receipt;if(!o.applied||!receipt||receipt.kind==='pending')continue;
    provisional ||= receipt.confirmation!=='finalized';
    const current=held.get(o.mint),g=o.side==='sell'&&current?current.group:group(o.strategy,o.bucket);
    const fees=BigInt(receipt.feeLamports+(receipt.kind==='success'?receipt.tipLamports:0));g.fees+=fees;
    if(receipt.kind==='failed'){g.failed++;g.realized-=fees;if(current&&o.side==='sell')current.result-=fees;continue;}
    g.rent+=BigInt(receipt.rentDeltaLamports);
    if(o.side==='buy'){
      if(current)throw Error('Performance history has overlapping entries');
      g.entries++;g.gross+=BigInt(receipt.nativeSpent);
      held.set(o.mint,{group:g,quantity:signed(receipt.tokenDelta),cost:BigInt(receipt.nativeSpent),result:0n});
    }else{
      if(!current)throw Error('Performance history has no matching entry');
      const sold=amount(o.amountRaw);if(sold>current.quantity)throw Error('Performance sale exceeds recorded holding');
      const basis=sold===current.quantity?current.cost:current.cost*sold/current.quantity;
      const pnl=-BigInt(receipt.nativeSpent)-basis;g.realized+=pnl;current.result+=pnl;current.cost-=basis;current.quantity-=sold;
      if(current.quantity===0n){g.closed++;if(current.result>0n){g.wins++;g.gains+=current.result;}else if(current.result<0n){g.losses++;g.loss-=current.result;}else g.flat++;held.delete(o.mint);}
    }
  }
  const total=[...groups.values()].reduce((sum,g)=>sum+g.realized,0n);
  if(total!==signed(s.realizedLamports))throw Error('Strategy results disagree with the financial ledger');
  return {mode:s.mode,base:'SOL',at:Date.now(),source:'recorded receipts',containsUnfinalizedEffects:provisional,realizedTradingLamports:total.toString(),
    note:'Observed results after costs. Partial sales count toward realized PnL, but a position counts as a closed trade once. Open holdings and small samples do not establish an edge.',
    strategies:[...groups.values()].map(g=>({strategy:g.strategy,bucket:g.bucket,entries:g.entries,closedTrades:g.closed,wins:g.wins,losses:g.losses,flat:g.flat,failedTransactions:g.failed,realizedLamports:g.realized.toString(),feesLamports:g.fees.toString(),rentLamports:g.rent.toString(),entryCostLamports:g.gross.toString(),
      winRatePct:g.closed?g.wins/g.closed*100:null,profitFactor:g.loss>0n?Number(g.gains)/Number(g.loss):null,openPositions:[...held.values()].filter(p=>p.group===g).length}))};
}

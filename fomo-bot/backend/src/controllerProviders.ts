import {SolanaService,validatedPayload} from './solana.js';
import {SafetyAggregator} from './rugcheck.js';
import {JitoExecutor} from './jitoExecutor.js';
import {RpcExecutor} from './rpcExecutor.js';
import {mintAddress} from './util.js';
import {SOL,USDC} from './constants.js';
import {amount} from './ledger.js';
import type {BackendConfig} from './config.js';
import type {RuntimePort,CandidateEvidence,Quote,LedgerState,Order,Settlement,Candidate} from './controllerTypes.js';
import type {SwapIntent,ValidatedSwap,MarketToken} from './types.js';
import type {ApiPort} from './controllerCore.js';

export function tokenMarket(t:Candidate):MarketToken {
  return {mint:t.id,name:typeof t.name==='string'?t.name:t.symbol,symbol:t.symbol,imageUri:null,mcapUsd:typeof t.mcap==='number'&&Number.isFinite(t.mcap)?t.mcap:null,fdvUsd:null,
    change5mPct:null,liquidityUsd:typeof t.liquidity==='number'?t.liquidity:null,volume5mUsd:null,createdAt:Number.isFinite(Date.parse(t.firstPool?.createdAt))?Date.parse(t.firstPool.createdAt):null,observedAt:Date.now(),source:'jupiter',estimated:false};
}
export class ControllerProviders implements RuntimePort {
  constructor(private c:BackendConfig,readonly solana:SolanaService,readonly api:ApiPort,private safety:SafetyAggregator){}
  reference(){return this.solana.reference.get();}
  async candidate(mint:string):Promise<CandidateEvidence>{
    mintAddress(mint);const t=(await this.api.tokens([mint],3,true)).find(row=>row.id===mint);if(!t)throw Error('Entry-policy token metadata unavailable');
    const market=tokenMarket(t),at=Date.now(),safety=await this.safety.inspect(mint,market),slot=await this.solana.connection.getSlot('confirmed');
    const facts=await this.solana.inspectMint(mint,true);
    if(!facts.classic||!facts.initialized||!facts.mintAuthorityRevoked||!facts.freezeAuthorityRevoked||facts.decimals!==t.decimals)throw Error('Current on-chain mint audit failed');
    return {token:t,safety,market,at,slot};
  }
  async quote(side:'buy'|'sell',mint:string,amountRaw:string,fast=false):Promise<Quote>{
    const work=async()=>{
      if(this.c.core.mode==='paper')return this.api.quote(side==='buy'?SOL:mint,side==='buy'?mint:SOL,amount(amountRaw),undefined,{side});
      const q=await this.solana.quoteSol(side,mint,amountRaw,null,fast);return q as unknown as Quote;
    };
    return side==='sell'?this.solana.withExitBudget(work):work();
  }
  async checkWallet(s:LedgerState):Promise<void>{
    if(s.mode==='paper')return;
    if(this.solana.chain.address!==s.wallet)throw Error('Dedicated wallet identity changed');
    const balances=await this.solana.withExitBudget(()=>this.solana.chain.balances());
    if(!Number.isSafeInteger(balances.native)||BigInt(balances.native)!==amount(s.cashLamports))throw Error('Wallet cash differs from the ledger; external funding/spending requires explicit reconciliation');
    if((balances.tokens[SOL]??0n)>0n)throw Error('Pre-funded WSOL is outside the native controller path');
    for(const p of s.positions)if((balances.tokens[p.mint]??0n)!==amount(p.quantityRaw))throw Error('Managed token quantity differs from the wallet');
    // Unrelated token holdings (including USDC) are never adopted or swept.
    void USDC;
  }
  prepare(intent:SwapIntent){return this.solana.prepare(intent);}
  audit(swap:ValidatedSwap){const audit=validatedPayload(swap).prepared.nativeAudit;if(!audit)throw Error('Missing native audit');return structuredClone(audit);}
  async send(swap:ValidatedSwap):Promise<{transportLatencyMs:number}>{
    return this.c.executionTransport==='rpc'?new RpcExecutor(this.c).send(swap):new JitoExecutor(this.c).send(swap);
  }
  async settlement(order:Order,commitment:'confirmed'|'finalized'):Promise<Settlement>{
    return this.solana.withExitBudget(()=>this.solana.chain.settlement({signature:order.signature,nativeAudit:order.nativeAudit},commitment)) as Promise<Settlement>;
  }
}

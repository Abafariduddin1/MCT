import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Connection,PublicKey} from '@solana/web3.js';
import type {AccountInfo,Keypair} from '@solana/web3.js';
import {loadCore} from './core.js';
import {openVault} from './walletVault.js';
import {QuotaTracker} from './quota.js';
import {mintAddress,object,rawAmount} from './util.js';
import {NativeSolChain,associated} from './nativeSol.js';
import {PriceReference,solCostMicroUsdc} from './priceReference.js';
import {JupiterBuild} from './jupiterBuild.js';
import {TipFloor} from './tipFloor.js';
import {dynamicSlippage} from './feePolicy.js';
import {JsonHttp} from './http.js';
import {CLASSIC_TOKEN,SOL,USDC} from './constants.js';
export {CLASSIC_TOKEN,SOL,USDC} from './constants.js';
import type {BuildQuote} from './jupiterBuild.js';
import type {BackendConfig} from './config.js';
import type {CoreChainPort,CoreModules,FetchLike,PortfolioGate,PreparedCoreSwap,SwapIntent,ValidatedSwap} from './types.js';
export interface MintFacts {mint:string;classic:boolean;initialized:boolean;mintAuthorityRevoked:boolean;freezeAuthorityRevoked:boolean;decimals:number|null;supply:bigint;checkedAt:number}
interface SealedSwap {prepared:PreparedCoreSwap;chain:CoreChainPort;gate:PortfolioGate;payer:string;tipCap:number;mode:'live';base:'SOL'|'USDC';wrapAddress:string;withExitBudget:<T>(work:()=>Promise<T>)=>Promise<T>}
const preparedSwaps=new WeakMap<ValidatedSwap,SealedSwap>();
export function validatedPayload(swap:ValidatedSwap):Readonly<SealedSwap>{const entry=preparedSwaps.get(swap);if(!entry)throw Error('Swap did not pass the guarded preparation path');return entry;}
export function mintFacts(mint:string,account:AccountInfo<Buffer>|null,now=Date.now()):MintFacts{
  const base={mint,classic:false,initialized:false,mintAuthorityRevoked:false,freezeAuthorityRevoked:false,decimals:null,supply:0n,checkedAt:now};
  if(!account||account.executable||account.owner.toBase58()!==CLASSIC_TOKEN||account.data.length!==82)return base;
  return{...base,classic:true,initialized:account.data[45]===1,mintAuthorityRevoked:account.data.readUInt32LE(0)===0,
    freezeAuthorityRevoked:account.data.readUInt32LE(46)===0,decimals:account.data[44]??null,supply:account.data.readBigUInt64LE(36)};
}
export class SolanaService {
  jupiterHttp!:JsonHttp;
  readonly connection:Connection;readonly chain:CoreChainPort;readonly quota:QuotaTracker;readonly rpcFetch:FetchLike;
  readonly reference:PriceReference;readonly router:JupiterBuild;
  private urgency:AsyncLocalStorage<boolean>;
  private mintCache=new Map<string,MintFacts>();
  private constructor(readonly config:BackendConfig,private modules:CoreModules,connection:Connection,chain:CoreChainPort,private gate:PortfolioGate,quota:QuotaTracker,rpcFetch:FetchLike,urgency:AsyncLocalStorage<boolean>,reference:PriceReference,router:JupiterBuild){
    this.connection=connection;this.chain=chain;this.quota=quota;this.rpcFetch=rpcFetch;this.urgency=urgency;
    this.reference=reference;this.router=router;
  }
  static async create(c:BackendConfig,gate:PortfolioGate,options:{modules?:CoreModules;connection?:Connection;fetcher?:FetchLike;walletLoader?:(file:string,key:string)=>Keypair;reference?:PriceReference;router?:JupiterBuild;tipFloor?:()=>Promise<number|null>}={}):Promise<SolanaService>{
    if(!c.core.rpc)throw Error('Set RPC_HTTP_URL before using Solana services');
    const rpc=new URL(c.core.rpc);if(rpc.protocol!=='https:')throw Error('RPC_HTTP_URL must use HTTPS');
    if(c.core.mode==='live'&&(!c.core.liveReady||c.core.liveAck!=='I_ACCEPT_REAL_TRADES'))throw Error('Live execution requires explicit local opt-in and acknowledgement');
    const modules=options.modules??await loadCore();
    const quota=new QuotaTracker(path.join(c.stateDir,'rpc-quota.json'),c.rpcCreditsPerDay,c.rpcExitReserve);
    const urgency=new AsyncLocalStorage<boolean>();
    const underlying=options.fetcher??fetch;
    const rpcFetch:FetchLike=async(input,init)=>{
      let cost=1;
      if(typeof init?.body==='string'){
        const body=object(JSON.parse(init.body));
        if(body.method==='getTransactionsForAddress'){
          const params=Array.isArray(body.params)?body.params:[];const options=object(params[1]??{});
          const limit=Number(options.limit??100);if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('Invalid history query limit');
          cost=10*Math.ceil(limit/100);
        }
        if(body.method==='getProgramAccounts')cost=10;
      }
      quota.consume(cost,urgency.getStore()===true);
      return underlying(input,{...init,redirect:'error',signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    };
    const connection=options.connection??new Connection(c.core.rpc,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:rpcFetch});
    // Construct without reading the old plaintext key file. Live mode receives
    // only an authenticated, decrypted in-memory key from the local vault.
    const tip=new TipFloor();
    const chain=c.liveBase==='SOL'?new NativeSolChain(c,connection,modules,options.tipFloor??(()=>tip.get())):new modules.Chain({...c.core,mode:'paper'},connection);
    chain.c=c.core;
    if(c.core.mode==='live')chain.wallet=(options.walletLoader??openVault)(c.walletVault,c.walletEncryptionKey);
    const sharedJupiter=new JsonHttp(underlying,Number(c.core.apiMs??1100));
    const reference=options.reference??new PriceReference(c.core.apiKey,()=>connection.getSlot('confirmed'),sharedJupiter);
    const service=new SolanaService(c,modules,connection,chain,gate,quota,rpcFetch,urgency,reference,options.router??new JupiterBuild(c.core.apiKey,sharedJupiter));
    service.jupiterHttp=sharedJupiter;return service;
  }
  withExitBudget<T>(work:()=>Promise<T>):Promise<T>{return this.urgency.run(true,work);}
  async quoteSol(side:'buy'|'sell',mint:string,amountRaw:string,recentMovePct:number|null=null,fast=false):Promise<BuildQuote>{
    if(this.config.liveBase!=='SOL'||!this.chain.address)throw Error('Native build quotes require an unlocked dedicated SOL wallet');
    if(side==='buy')await this.checkSolSize(rawAmount(amountRaw));
    return this.router.quote({side,mint,amountRaw,taker:this.chain.address,slippageBps:dynamicSlippage(this.config,side,recentMovePct),jito:this.config.executionTransport==='jito',fast});
  }
  private async checkSolSize(amount:bigint):Promise<void>{
    if(amount<=0n||amount>this.config.maxBuyLamports)throw Error('Buy exceeds MAX_BUY_SOL or is not positive');
    const reference=await this.reference.get();
    const upper=amount+BigInt(this.config.core.networkCap+this.config.core.rentCap);
    if(solCostMicroUsdc(upper,reference)>BigInt(Math.floor(this.config.core.maxPosition*1e6)))throw Error('SOL buy including fee/rent allowance exceeds the USDC-equivalent position cap');
  }
  async inspectMint(mint:string,fresh=false):Promise<MintFacts>{
    mint=mintAddress(mint);const cached=this.mintCache.get(mint);
    if(!fresh&&cached&&cached.classic&&cached.mintAuthorityRevoked&&cached.freezeAuthorityRevoked&&Date.now()-cached.checkedAt<60000)return cached;
    const facts=mintFacts(mint,await this.connection.getAccountInfo(new PublicKey(mint),'finalized'));
    this.mintCache.set(mint,facts);if(this.mintCache.size>500)this.mintCache.delete(this.mintCache.keys().next().value!);return facts;
  }
  async top10AccountPct(mint:string,supply:bigint):Promise<number|null>{
    if(supply<=0n)return null;
    const rows=await this.connection.getTokenLargestAccounts(new PublicKey(mintAddress(mint)),'finalized');
    const top=rows.value.slice(0,10).reduce((sum,row)=>sum+rawAmount(row.amount),0n);
    if(top>supply)return null;return Number((top*1000000n+supply-1n)/supply)/10000;
  }
  async prioritySamples():Promise<number[]>{
    const samples=await this.connection.getRecentPrioritizationFees();return samples.slice(-50).map(row=>row.prioritizationFee).filter(n=>Number.isSafeInteger(n)&&n>=0);
  }
  async prepare(intent:SwapIntent):Promise<ValidatedSwap>{
    if(!['buy','sell'].includes(intent.side))throw Error('Unsupported swap side');
    return this.urgency.run(intent.side==='sell',()=>this.prepareGuarded(intent));
  }
  private async prepareGuarded(intent:SwapIntent):Promise<ValidatedSwap>{
    const c=this.config.core;
    if(c.mode!=='live'||!c.liveReady||c.liveAck!=='I_ACCEPT_REAL_TRADES')throw Error('Paper mode cannot prepare a real swap');
    mintAddress(intent.mint);const amount=rawAmount(intent.amountRaw);if(amount<=0n)throw Error('Swap amount must be positive');
    if([SOL,USDC].includes(intent.mint))throw Error('Base assets are not meme-token trade targets');
    if(!Number.isInteger(intent.decimals)||intent.decimals<0||intent.decimals>18)throw Error('Invalid token decimals');
    if(intent.expiresAt!==null&&(!Number.isFinite(intent.expiresAt)||Date.now()>intent.expiresAt))throw Error('Trade signal expired');
    if(intent.side==='buy'){
      if(this.config.liveBase==='SOL')await this.checkSolSize(amount);
      else if(amount>BigInt(Math.floor(c.maxPosition*1e6)))throw Error('Buy exceeds the configured position cap');
    }
    await this.gate.assertAllowed(intent);
    await this.chain.verifyMint(intent.mint,intent.decimals);
    if(this.config.liveBase==='USDC')this.modules.validateQuote(intent.quote,intent.side==='buy'?USDC:intent.mint,intent.side==='buy'?intent.mint:USDC,amount,
      intent.side==='buy'?c:{...c,slippage:c.exitSlippage,swapFee:c.exitSwapFee},true);
    const prepared=await this.chain.prepare(intent.quote,intent.side,intent.mint,amount);
    if(intent.expiresAt!==null&&Date.now()>intent.expiresAt)throw Error('Trade signal expired during validation');
    await this.gate.assertAllowed(intent);
    const payer=this.chain.address;if(!payer)throw Error('No live wallet');
    const result:ValidatedSwap=Object.freeze({signature:prepared.signature,requestId:prepared.requestId,lastValidBlockHeight:prepared.lastValidBlockHeight,
      minimum:prepared.minimum,mint:intent.mint,side:intent.side,preparedAt:Date.now(),base:this.config.liveBase});
    preparedSwaps.set(result,{prepared:{...prepared},chain:this.chain,gate:this.gate,payer,tipCap:Math.min(this.config.jitoMaxTip,c.jitoTip),mode:'live',base:this.config.liveBase,
      wrapAddress:associated(payer,SOL).toBase58(),withExitBudget:work=>this.urgency.run(intent.side==='sell',work)});
    return result;
  }
}

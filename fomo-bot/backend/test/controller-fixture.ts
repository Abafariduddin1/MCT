import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import bs58 from 'bs58';
import {loadConfig} from '../src/config.js';
import {Ledger,initialLedger,amount} from '../src/ledger.js';
import {BotEngine} from '../src/botEngine.js';
import {loadControllerCore} from '../src/controllerCore.js';
import {SOL,CLASSIC_TOKEN} from '../src/constants.js';
import type {RuntimePort,Quote,CandidateEvidence,Settlement,Order} from '../src/controllerTypes.js';
import type {SwapIntent,NativeAudit,ValidatedSwap} from '../src/types.js';

export const token=Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
export const token2=Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBase58();
export const wallet=Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
export const leader=Keypair.fromSeed(new Uint8Array(32).fill(10)).publicKey.toBase58();
export function reference(price=100){return{solUsd:price,usdcUsd:1,solUsdc:price,slot:1000,at:Date.now()};}
export function evidence(mint=token):CandidateEvidence{
  const at=Date.now();return{at,slot:1000,token:{id:mint,symbol:'TEST',decimals:6,tokenProgram:CLASSIC_TOKEN,isVerified:true,firstPool:{createdAt:new Date(at-86400000*3).toISOString()},liquidity:1000000,holderCount:1000,organicScore:90,audit:{mintAuthorityDisabled:true,freezeAuthorityDisabled:true,topHoldersPercentage:10},usdPrice:1,priceBlockId:1000,stats1h:{buyVolume:100000,sellVolume:100000},stats5m:{buyVolume:20000,sellVolume:10000}},
    safety:{mint,isSafe:true,status:'eligible',riskReason:'Checks passed',checkedAt:at,expiresAt:at+60000,top10Pct:10,lpLockedPct:100,rugScore:0,checks:['mintAuthority','freezeAuthority','top10','liquidity','age','lpLocked','rugcheck','tokenProgram'].map(key=>({key:key as 'age',status:'pass',detail:'fixture'}))},
    market:{mint,name:'Test fixture',symbol:'TEST',imageUri:null,mcapUsd:1000000,fdvUsd:null,change5mPct:null,liquidityUsd:1000000,volume5mUsd:30000,createdAt:at-86400000*3,observedAt:at,source:'dexscreener',estimated:false}};
}
export class FakePort implements RuntimePort {
  calls={prepare:0,send:0,quote:0};price=100;sellMultiplier=1;badEvidence:((e:CandidateEvidence)=>void)|null=null;sendError=false;beforeSend:(()=>void)|null=null;
  beforeQuote:(()=>Promise<void>)|null=null;receipt:((o:Order,commitment:'confirmed'|'finalized')=>Settlement)|null=null;
  private audits=new Map<string,NativeAudit>();
  constructor(public engine:BotEngine){}
  async reference(){return reference(this.price);}
  async candidate(mint:string){const e=evidence(mint);this.badEvidence?.(e);return e;}
  async quote(side:'buy'|'sell',mint:string,raw:string):Promise<Quote>{
    this.calls.quote++;await this.beforeQuote?.();const output=side==='buy'?amount(raw)/10n:amount(raw)*BigInt(Math.round(10*this.sellMultiplier*1000000))/1000000n;
    return{inputMint:side==='buy'?SOL:mint,outputMint:side==='buy'?mint:SOL,inAmount:raw,outAmount:output.toString(),otherAmountThreshold:(output*995n/1000n).toString(),receivedAt:Date.now(),priceImpact:0};
  }
  async checkWallet(){}
  async prepare(intent:SwapIntent):Promise<ValidatedSwap>{
    this.calls.prepare++;await this.engine.assertAllowed(intent);const signature=bs58.encode(randomBytes(64)),q=intent.quote as Quote;
    this.audits.set(signature,{base:'SOL',side:intent.side,mint:intent.mint,inputRaw:intent.amountRaw,minimumRaw:q.otherAmountThreshold,feeLamports:5000,tipLamports:0,rentDeltaLamports:0,tokenAccounts:[SOL,intent.mint]});
    return {signature,requestId:signature,lastValidBlockHeight:2000,minimum:q.otherAmountThreshold,mint:intent.mint,side:intent.side,preparedAt:Date.now(),base:'SOL'};
  }
  audit(swap:ValidatedSwap){return this.audits.get(swap.signature)!;}
  async send(swap:ValidatedSwap){await this.engine.assertPersisted(swap.signature);this.beforeSend?.();this.calls.send++;if(this.sendError)throw Error('Transport timeout');return {transportLatencyMs:2};}
  async settlement(o:Order,commitment:'confirmed'|'finalized'):Promise<Settlement>{
    if(this.receipt)return this.receipt(o,commitment);
    const a=o.nativeAudit!,base=o.side==='buy'?-amount(o.amountRaw):amount(a.minimumRaw),tokens=o.side==='buy'?amount(a.minimumRaw):-amount(o.amountRaw);
    return {kind:'success',base:'SOL',baseDelta:base.toString(),tokenDelta:tokens.toString(),nativeSpent:Number(-base+5000n),feeLamports:5000,tipLamports:0,rentDeltaLamports:0,confirmation:commitment};
  }
}
export async function fixture(env:Record<string,string>={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fomobot-controller-'));
  const c=await loadConfig({MODE:'paper',APP_STATE_DIR:path.join(root,'state'),BOT_DATA_DIR:path.join(root,'old'),RPC_HTTP_URL:'https://example.invalid',JUPITER_API_KEY:'test-key',PAPER_INITIAL_SOL:'2',COPY_STREAM_ENABLED:'false',COPY_LEADER:leader,PAPER_ENTRY_RENT_LAMPORTS:'1000',MAX_RENT_LAMPORTS:'0',APP_ACCESS_TOKEN:randomBytes(32).toString('base64url'),...env});
  const file=path.join(root,'ledger.json');
  const ledger=new Ledger(file,()=>initialLedger({mode:c.core.mode,wallet:c.core.mode==='live'?wallet:'paper',cash:2000000000n,reference:reference(),normalPct:50,copyPct:30,leader,orderLamports:50000000n}),{mode:c.core.mode,wallet:c.core.mode==='live'?wallet:'paper'});
  const core=await loadControllerCore(),engine=new BotEngine(c,ledger),port=new FakePort(engine);engine.attach(port,e=>core.screen(e.token,c.core,Date.now(),e.slot));
  return {root,c,file,ledger,engine,port,core,async cleanup(){await engine.stop();ledger.close();fs.rmSync(root,{recursive:true,force:true});}};
}
export const buy=(id='buy_command_00000001',mint=token,sol='0.05')=>({v:1,id,type:'QUICK_TRADE',side:'buy',mint,amountSol:sol});
export const sell=(id='sell_command_0000001',mint=token,bps=10000)=>({v:1,id,type:'QUICK_TRADE',side:'sell',mint,percentBps:bps});

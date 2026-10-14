import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction,Connection} from '@solana/web3.js';
import bs58 from 'bs58';
import {loadConfig} from '../src/config.js';import {loadCore} from '../src/core.js';import {SolanaService,CLASSIC_TOKEN} from '../src/solana.js';
import {JITO_TIP_ACCOUNTS} from '../src/jitoExecutor.js';
import type {CoreChainPort,CoreConfig,CoreModules,PortfolioGate,PreparedCoreSwap} from '../src/types.js';
export const mint=Keypair.generate().publicKey.toBase58();
export const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
export function temp():{root:string;cleanup:()=>void}{const root=fs.mkdtempSync(path.join(os.tmpdir(),'fomo-test-'));return{root,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};}
export async function settings(root:string,extra:Record<string,string>={}){return loadConfig({MODE:'paper',APP_STATE_DIR:root,BOT_DATA_DIR:path.join(root,'bot'),RPC_HTTP_URL:'https://rpc.invalid',...extra});}
export function mintAccount(){const data=Buffer.alloc(82);data[44]=6;data[45]=1;data.writeBigUInt64LE(1000000000n,36);return{data,owner:new PublicKey(CLASSIC_TOKEN),lamports:2000000,executable:false,rentEpoch:0};}
export class FakeSocket extends EventEmitter {
  static all:FakeSocket[]=[];readyState=0;sent:string[]=[];closed=false;
  constructor(){super();FakeSocket.all.push(this);queueMicrotask(()=>{this.readyState=1;this.emit('open');});}
  send(text:string):void{this.sent.push(text);}ping():void{this.emit('pong');}close():void{this.terminate();}
  terminate():void{if(this.closed)return;this.closed=true;this.readyState=3;this.emit('close');}
  message(value:unknown):void{this.emit('message',Buffer.from(JSON.stringify(value)));}
}
export async function preparedFixture(root:string,options:{tip?:number;recipient?:string;persisted?:boolean;expiry?:number;mode?:'paper'|'live'}={}){
  const c=await settings(root,{MODE:options.mode??'live',LIVE_BASE:'USDC',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES',EXECUTION_TRANSPORT:'jito'});
  const wallet=Keypair.generate(),recipient=new PublicKey(options.recipient??[...JITO_TIP_ACCOUNTS][0]!);
  const message=new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[
    SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:recipient,lamports:options.tip??1000})]}).compileToV0Message();
  const tx=new VersionedTransaction(message);tx.sign([wallet]);
  const result:PreparedCoreSwap={signedTransaction:Buffer.from(tx.serialize()).toString('base64'),signature:bs58.encode(tx.signatures[0]!),requestId:'mock-request',lastValidBlockHeight:options.expiry??99999,minimum:'995000'};
  let validations=0,gates=0;
  const gate:PortfolioGate={assertAllowed:async()=>{gates++;},assertPersisted:async()=>{if(options.persisted===false)throw Error('No durable intent');}};
  class MockChain implements CoreChainPort {
    wallet:Keypair|null=null;connection:Connection;constructor(public c:CoreConfig,connection?:Connection){this.connection=connection!;}
    get address(){return this.wallet?.publicKey.toBase58();}
    async verifyMint(){validations++;}async balances(){return{native:20000000,usdc:20,tokens:{}};}
    async prepare(){validations++;return result;}async settlement(){return{kind:'pending'};}
  }
  const real=await loadCore();
  const modules:CoreModules={...real,Chain:MockChain};
  const connection={getBlockHeight:async()=>100,getAddressLookupTable:async()=>({value:null})} as unknown as Connection;
  const service=await SolanaService.create(c,gate,{modules,connection,walletLoader:()=>wallet});
  const quote={inputMint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',outputMint:mint,inAmount:'1000000',outAmount:'1000000',otherAmountThreshold:'995000',
    swapMode:'ExactIn',router:'metis',slippageBps:50,priceImpact:0.1,feeBps:0,transaction:result.signedTransaction,requestId:result.requestId,
    transactionVersion:0,gasless:false,signatureFeeLamports:5000,prioritizationFeeLamports:51000,rentFeeLamports:0,lastValidBlockHeight:99999,receivedAt:Date.now()};
  const swap=options.mode==='paper'?null:await service.prepare({side:'buy',mint,decimals:6,amountRaw:'1000000',quote,expiresAt:null});
  return{c,service,swap,result,quote,get validations(){return validations;},get gates(){return gates;}};
}

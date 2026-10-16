import {createHash} from 'node:crypto';
import {Keypair,PublicKey,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import type {AccountInfo,Connection,MessageV0} from '@solana/web3.js';
import bs58 from 'bs58';
import {SOL,USDC,CLASSIC_TOKEN,JUPITER_PROGRAM} from '../src/constants.js';
import {associated} from '../src/nativeSol.js';
import {parseBuildQuote} from '../src/jupiterBuild.js';
import {PriceReference} from '../src/priceReference.js';
import {JsonHttp} from '../src/http.js';
import {SolanaService} from '../src/solana.js';
import type {BuildQuote} from '../src/jupiterBuild.js';
import type {PortfolioGate} from '../src/types.js';
import {settings,mintAccount,mint} from './helpers.js';

export const RENT=2039280;
export function nativeInfo(lamports:number):AccountInfo<Buffer> {return {data:Buffer.alloc(0),owner:SystemProgram.programId,executable:false,lamports,rentEpoch:0};}
export function tokenInfo(owner:string,asset:string,amount:bigint,lamports=RENT):AccountInfo<Buffer> {
  const data=Buffer.alloc(165);new PublicKey(asset).toBuffer().copy(data);new PublicKey(owner).toBuffer().copy(data,32);
  data.writeBigUInt64LE(amount,64);data[108]=1;
  if(asset===SOL) {data.writeUInt32LE(1,109);data.writeBigUInt64LE(BigInt(RENT),113);}
  return {data,owner:new PublicKey(CLASSIC_TOKEN),executable:false,lamports,rentEpoch:0};
}

export function routeData(amount:bigint,out:bigint,slippage=50):Buffer {
  const data=Buffer.alloc(31);createHash('sha256').update('global:route').digest().subarray(0,8).copy(data);
  data.writeBigUInt64LE(amount,12);data.writeBigUInt64LE(out,20);data.writeUInt16LE(slippage,28);return data;
}

export function rawBuild(owner:string,side:'buy'|'sell'='buy',amount=10000000n,out=1000000n,slippage=50):Record<string,unknown> {
  const ownerKey=new PublicKey(owner),target=associated(owner,mint),wsol=associated(owner,SOL);
  return {inputMint:side==='buy'?SOL:mint,outputMint:side==='buy'?mint:SOL,inAmount:amount.toString(),outAmount:out.toString(),
    otherAmountThreshold:(out*BigInt(10000-slippage)/10000n).toString(),swapMode:'ExactIn',slippageBps:slippage,priceImpactPct:'0.001',transactionVersion:0,
    setupInstructions:[],otherInstructions:[],cleanupInstruction:null,tipInstruction:null,
    computeBudgetInstructions:[{programId:'ComputeBudget111111111111111111111111111111',accounts:[],data:Buffer.concat([Buffer.from([3]),Buffer.alloc(8)]).toString('base64')}],
    swapInstruction:{programId:JUPITER_PROGRAM,data:routeData(amount,out,slippage).toString('base64'),accounts:[
      {pubkey:ownerKey.toBase58(),isSigner:true,isWritable:true},{pubkey:wsol.toBase58(),isSigner:false,isWritable:true},
      {pubkey:target.toBase58(),isSigner:false,isWritable:true}]},
    addressesByLookupTableAddress:{},blockhashWithMetadata:{blockhash:[...Keypair.generate().publicKey.toBuffer()],lastValidBlockHeight:99999}};
}

function fee(message:MessageV0):number {
  let units=0,micro=0n;
  for(const ix of message.compiledInstructions) {
    if(message.staticAccountKeys[ix.programIdIndex]?.toBase58()!=='ComputeBudget111111111111111111111111111111')continue;
    const data=Buffer.from(ix.data);if(data[0]===2)units=data.readUInt32LE(1);if(data[0]===3)micro=data.readBigUInt64LE(1);
  }
  return 5000+Number((micro*BigInt(units)+999999n)/1000000n);
}

export async function nativeFixture(root:string,options:{side?:'buy'|'sell';amount?:bigint;out?:bigint;transport?:'rpc'|'jito';solPrice?:number;persisted?:boolean;
  corruptSimulation?:'one-lamport'|'unrelated-token'|'freeze';fundedWsol?:boolean;computePrice?:bigint;actualFeeExtra?:number;expired?:boolean;layout?:'legacy'|'v2';gate?:PortfolioGate}={}) {
  const side=options.side??'buy',amount=options.amount??(side==='buy'?10000000n:1000000n),out=options.out??(side==='buy'?1000000n:15000000n);
  const c=await settings(root,{MODE:'live',LIVE_BASE:'SOL',ENABLE_LIVE_TRADING:'true',LIVE_ACK:'I_ACCEPT_REAL_TRADES',EXECUTION_TRANSPORT:options.transport??'jito',JUPITER_API_KEY:'test-only'});
  const wallet=Keypair.generate(),owner=wallet.publicKey.toBase58(),target=associated(owner,mint).toBase58(),wsol=associated(owner,SOL).toBase58();
  const unrelated=Keypair.generate().publicKey.toBase58(),unrelatedAccount=associated(owner,unrelated).toBase58();
  const before=new Map<string,AccountInfo<Buffer>|null>([[owner,nativeInfo(2000000000)],[target,side==='sell'?tokenInfo(owner,mint,amount):null],
    [wsol,options.fundedWsol?tokenInfo(owner,SOL,1000000n,RENT+1000000):null],[unrelatedAccount,tokenInfo(owner,unrelated,5000000n)]]);
  const raw=rawBuild(owner,side,amount,out,side==='buy'?50:100);
  (raw.swapInstruction as {accounts:unknown[]}).accounts.push({pubkey:unrelatedAccount,isSigner:false,isWritable:true});
  if(options.layout==='v2'){
    const data=Buffer.alloc(40);createHash('sha256').update('global:shared_accounts_route_v2').digest().subarray(0,8).copy(data);
    data.writeBigUInt64LE(amount,9);data.writeBigUInt64LE(out,17);data.writeUInt16LE(side==='buy'?50:100,25);
    data.writeUInt32LE(1,31);data[35]=38;data.writeUInt16LE(10000,36);data[38]=0;data[39]=1;
    (raw.swapInstruction as {data:string}).data=data.toString('base64');
  }
  const priceIx=(raw.computeBudgetInstructions as Array<{data:string}>)[0]!;
  const priceData=Buffer.from(priceIx.data,'base64');priceData.writeBigUInt64LE(options.computePrice??10000n,1);priceIx.data=priceData.toString('base64');
  const quote=parseBuildQuote(raw,{side,mint,amountRaw:amount.toString(),taker:owner,slippageBps:side==='buy'?50:100});
  let simulations=0,sends=0,assertions=0,lastTx:VersionedTransaction|null=null;
  const rent=side==='buy'?RENT:0,tip=c.executionTransport==='jito'?1000:0;
  const fake={
    getBalance:async()=>2000000000,
    getSlot:async()=>1000,
    getAccountInfo:async()=>mintAccount(),
    getTokenAccountsByOwner:async()=>({context:{slot:1000},value:[...before.entries()].filter(([key,info])=>key!==owner&&info).map(([key,info])=>({pubkey:new PublicKey(key),account:info!}))}),
    getMultipleAccountsInfo:async(keys:PublicKey[])=>keys.map(key=>before.get(key.toBase58())??null),
    getAddressLookupTable:async()=>({value:null}),
    getBlockHeight:async()=>options.expired?99999:100,
    getFeeForMessage:async(message:MessageV0)=>({context:{slot:1000},value:fee(message)+(options.actualFeeExtra??0)}),
    simulateTransaction:async(tx:VersionedTransaction,init:{sigVerify:boolean;accounts:{addresses:string[]}})=>{
      simulations++;lastTx=tx;
      const network=fee(tx.message as MessageV0),spend=side==='buy'?Number(amount)+network+tip+rent:network+tip-Number(out);
      const after=new Map(before);after.set(owner,nativeInfo(2000000000-spend-(options.corruptSimulation==='one-lamport'?1:0)));
      after.set(target,tokenInfo(owner,mint,side==='buy'?out:0n));after.set(wsol,null);
      if(options.corruptSimulation==='unrelated-token')after.set(unrelatedAccount,tokenInfo(owner,unrelated,4999999n));
      if(options.corruptSimulation==='freeze')after.get(target)!.data[108]=2;
      return {context:{slot:1000},value:{err:null,unitsConsumed:400000,accounts:init.accounts.addresses.map(address=>{
        const info=after.get(address);return info?{...info,owner:info.owner.toBase58(),data:[info.data.toString('base64'),'base64']}:null;
      })}};
    },
    sendRawTransaction:async(bytes:Uint8Array,opts:{maxRetries:number;skipPreflight:boolean})=>{
      sends++;if(opts.maxRetries!==0||opts.skipPreflight!==false)throw Error('Unsafe RPC retry settings');
      return bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!);
    },
    getSignatureStatuses:async()=>({value:[{confirmationStatus:'finalized',err:null}]}),
    getTransaction:async(signature:string)=>{
      if(!lastTx)throw Error('Prepare first');
      const message=lastTx.message as MessageV0,keys=message.staticAccountKeys;
      const network=fee(message),pre=keys.map(key=>before.get(key.toBase58())?.lamports??0),post=[...pre];
      post[0]=2000000000-(side==='buy'?Number(amount)+network+tip+rent:network+tip-Number(out));
      const tokenIndex=keys.findIndex(key=>key.toBase58()===target);post[tokenIndex]=RENT;
      return {transaction:{message,signatures:[signature]},meta:{err:null,fee:network,preBalances:pre,postBalances:post,
        preTokenBalances:side==='sell'?[{accountIndex:tokenIndex,mint,owner,uiTokenAmount:{amount:amount.toString()}}]:[],
        postTokenBalances:[{accountIndex:tokenIndex,mint,owner,uiTokenAmount:{amount:side==='buy'?out.toString():'0'}}]}};
    }
  };
  const connection=fake as unknown as Connection;
  const reference=new PriceReference('test-only',()=>connection.getSlot(),new JsonHttp(async()=>new Response(JSON.stringify({
    [SOL]:{usdPrice:options.solPrice??100,decimals:9,blockId:1000},[USDC]:{usdPrice:1,decimals:6,blockId:1000}})),0));
  const gate:PortfolioGate={assertAllowed:async()=>{assertions++;},assertPersisted:async()=>{if(options.persisted===false)throw Error('No durable native intent');}};
  const service=await SolanaService.create(c,options.gate??gate,{connection,walletLoader:()=>wallet,reference,tipFloor:async()=>null});
  const prepare=()=>service.prepare({side,mint,decimals:6,amountRaw:amount.toString(),quote,expiresAt:null});
  return {c,service,quote,prepare,connection,owner,amount,out,get simulations(){return simulations;},get sends(){return sends;},get assertions(){return assertions;},get lastTx(){return lastTx;}};
}

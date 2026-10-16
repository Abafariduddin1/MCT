import {Keypair,PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {USDC,SOL,TOKEN_PROGRAM} from '../src/config.mjs';
import {JUPITER_PROGRAM,anchorDiscriminator} from '../src/venues.mjs';
export const mint=Keypair.generate().publicKey.toBase58();
export const leader=Keypair.generate().publicKey.toBase58();
export function token(id=mint,price=1,slot=1000,now=Date.now()){
  return{id,symbol:'TEST',tokenProgram:TOKEN_PROGRAM,decimals:6,isVerified:true,firstPool:{createdAt:new Date(now-72*3600000).toISOString()},
    holderCount:1000,organicScore:80,liquidity:200000,usdPrice:price,priceBlockId:slot,
    audit:{mintAuthorityDisabled:true,freezeAuthorityDisabled:true,topHoldersPercentage:10},
    stats1h:{buyVolume:60000,sellVolume:40000},stats5m:{buyVolume:6000,sellVolume:4000}};
}
export function quote(input,output,amount,price=1,taker){
  const out=input===USDC?BigInt(Math.floor(Number(amount)/price)):BigInt(Math.floor(Number(amount)*price));
  return{inputMint:input,outputMint:output,inAmount:String(amount),outAmount:String(out),otherAmountThreshold:String(out*9950n/10000n),
    slippageBps:50,priceImpact:0.1,feeBps:10,swapMode:'ExactIn',router:'metis',transactionVersion:0,gasless:false,
    signatureFeeLamports:5000,prioritizationFeeLamports:51000,rentFeeLamports:0,taker,signatureFeePayer:taker,
    receivedAt:Date.now(),requestId:'request',transaction:'fixture',lastValidBlockHeight:'99999999'};
}
export function transaction(side='buy',base='usdc',options={}){
  const amount=BigInt(options.amount||10000000),buy=side==='buy',native=base==='sol';
  const row=(id,amount,index,decimals=6)=>({mint:id,owner:leader,accountIndex:index,programId:TOKEN_PROGRAM,uiTokenAmount:{amount:String(amount),decimals}});
  return{version:options.version??1,slot:options.slot??101,transactionIndex:0,blockTime:options.blockTime??Math.floor(Date.now()/1000),
    transaction:{signatures:[options.signature||'new'],message:{accountKeys:[{pubkey:new PublicKey(leader),signer:true},
      {pubkey:new PublicKey(USDC),signer:false},{pubkey:new PublicKey(mint),signer:false}],
      instructions:[{programId:new PublicKey(options.program||JUPITER_PROGRAM),data:bs58.encode(anchorDiscriminator(options.instruction||'route'))}]}},
    meta:{err:null,fee:5000,preBalances:[2000000000,2039280,2039280],
      postBalances:[2000000000-5000+(native?(buy?-100000000:100000000):0),2039280,2039280],
      preTokenBalances:[row(USDC,20000000,1),row(mint,buy?0:10000000,2)],
      postTokenBalances:[row(USDC,native?20000000:(buy?10000000:20000000n+amount),1),row(mint,buy?amount:10000000n-amount,2)]}};
}

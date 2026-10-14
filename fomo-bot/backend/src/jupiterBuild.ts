import {PublicKey,TransactionInstruction} from '@solana/web3.js';
import {JsonHttp} from './http.js';
import {mintAddress,object,rawAmount} from './util.js';
import {SOL,USDC,JUPITER_PROGRAM} from './constants.js';
import {associated} from './nativeSol.js';

export interface BuildQuote {
  kind:'jupiter-build';inputMint:string;outputMint:string;inAmount:string;outAmount:string;
  otherAmountThreshold:string;slippageBps:number;receivedAt:number;taker:string;
  priceImpact:number;
  instructions:TransactionInstruction[];computePriceMicroLamports:bigint;lookupTables:string[];
  blockhash:string;lastValidBlockHeight:number;swapData:Buffer;
}

function instruction(value:unknown):TransactionInstruction {
  const row=object(value);
  if(!Array.isArray(row.accounts)||row.accounts.length>128||typeof row.data!=='string'||row.data.length>8192||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.data))
    throw Error('Malformed swap instruction');
  const keys=row.accounts.map(input=>{
    const key=object(input);
    if(typeof key.isSigner!=='boolean'||typeof key.isWritable!=='boolean')throw Error('Malformed instruction account flags');
    return {pubkey:new PublicKey(mintAddress(key.pubkey)),isSigner:key.isSigner,isWritable:key.isWritable};
  });
  return new TransactionInstruction({programId:new PublicKey(mintAddress(row.programId)),keys,data:Buffer.from(row.data,'base64')});
}

export function parseBuildQuote(value:unknown,expected:{side:'buy'|'sell';mint:string;amountRaw:string;taker:string;slippageBps:number}):BuildQuote {
  const row=object(value),input=expected.side==='buy'?SOL:expected.mint,output=expected.side==='buy'?expected.mint:SOL;
  if(row.error||row.errorCode||row.inputMint!==input||row.outputMint!==output||row.inAmount!==expected.amountRaw||row.swapMode!=='ExactIn'||row.transactionVersion!==0)
    throw Error('Build quote does not match the requested native SOL swap');
  if(!Number.isInteger(row.slippageBps)||Number(row.slippageBps)<0||Number(row.slippageBps)>expected.slippageBps)
    throw Error('Build quote exceeds the slippage limit');
  const out=rawAmount(String(row.outAmount)),minimum=rawAmount(String(row.otherAmountThreshold));
  const impact=typeof row.priceImpactPct==='number'?row.priceImpactPct:typeof row.priceImpactPct==='string'&&/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(row.priceImpactPct)?Number(row.priceImpactPct):NaN;
  if(!Number.isFinite(impact)||Math.abs(impact)>1)throw Error('Build quote has no usable price impact');
  if(out<=0n||minimum<=0n||minimum>out||minimum<out*BigInt(10000-expected.slippageBps)/10000n)
    throw Error('Invalid build output or minimum output');
  for(const field of ['setupInstructions','otherInstructions','computeBudgetInstructions'])
    if(!Array.isArray(row[field])||(row[field] as unknown[]).length>20)throw Error('Missing or oversized build instruction list');
  if(row.tipInstruction!==null&&row.tipInstruction!==undefined)throw Error('Provider tips are disabled; the backend adds its own bounded tip');
  const swap=instruction(row.swapInstruction);
  if(swap.programId.toBase58()!==JUPITER_PROGRAM)throw Error('Unexpected swap program');
  // Zero integrator fee is also verified in the encoded route by NativeSolChain.
  const instructions=[...(row.setupInstructions as unknown[]).map(instruction),swap,
    ...(row.cleanupInstruction?[instruction(row.cleanupInstruction)]:[]),...(row.otherInstructions as unknown[]).map(instruction)];
  let computePrice=0n,prices=0;
  for(const data of row.computeBudgetInstructions as unknown[]) {
    const ix=instruction(data);
    if(ix.programId.toBase58()!=='ComputeBudget111111111111111111111111111111'||ix.keys.length||ix.data.length!==9||ix.data[0]!==3)
      throw Error('Unexpected provider compute-budget instruction');
    if(++prices>1)throw Error('Duplicate compute-unit price');
    computePrice=ix.data.readBigUInt64LE(1);
  }
  const lookup=object(row.addressesByLookupTableAddress??{}),lookupTables=Object.keys(lookup).map(mintAddress);
  if(lookupTables.length>8)throw Error('Too many address lookup tables');
  const metadata=object(row.blockhashWithMetadata);
  if(!Array.isArray(metadata.blockhash)||metadata.blockhash.length!==32||metadata.blockhash.some(n=>!Number.isInteger(n)||n<0||n>255)||
    !Number.isSafeInteger(metadata.lastValidBlockHeight)||Number(metadata.lastValidBlockHeight)<=0)
    throw Error('Invalid build blockhash or expiry');
  return {kind:'jupiter-build',inputMint:input,outputMint:output,inAmount:expected.amountRaw,outAmount:out.toString(),otherAmountThreshold:minimum.toString(),
    slippageBps:Number(row.slippageBps),priceImpact:Math.abs(impact)*100,receivedAt:Date.now(),taker:mintAddress(expected.taker),instructions,computePriceMicroLamports:computePrice,
    lookupTables,blockhash:new PublicKey(Uint8Array.from(metadata.blockhash)).toBase58(),lastValidBlockHeight:Number(metadata.lastValidBlockHeight),swapData:Buffer.from(swap.data)};
}

export class JupiterBuild {
  constructor(private apiKey:string,private http=new JsonHttp(fetch,1100)) {}
  async quote(input:{side:'buy'|'sell';mint:string;amountRaw:string;taker:string;slippageBps:number;jito:boolean;fast?:boolean}):Promise<BuildQuote> {
    if(!this.apiKey)throw Error('JUPITER_API_KEY is required for a build quote');
    const mint=mintAddress(input.mint);if([SOL,USDC].includes(mint))throw Error('Base assets are not meme-token targets');
    if(!['buy','sell'].includes(input.side)||rawAmount(input.amountRaw)<=0n||!Number.isInteger(input.slippageBps)||input.slippageBps<0||input.slippageBps>1000)
      throw Error('Invalid build request');
    const params=new URLSearchParams({inputMint:input.side==='buy'?SOL:mint,outputMint:input.side==='buy'?mint:SOL,amount:input.amountRaw,
      taker:mintAddress(input.taker),slippageBps:String(input.slippageBps),platformFeeBps:'0',wrapAndUnwrapSol:'false',transactionVersion:'0',maxAccounts:'40',
      forJitoBundle:String(input.jito),computeUnitPricePercentile:'high'});
    params.set('destinationTokenAccount',associated(input.taker,input.side==='buy'?mint:SOL).toBase58());
    if(input.fast)params.set('mode','fast');
    const result=await this.http.request('https://api.jup.ag/swap/v2/build?'+params,{headers:{'x-api-key':this.apiKey}},2);
    return parseBuildQuote(result,{...input,mint});
  }
}

import bs58 from 'bs58';
import {createPublicKey,verify} from 'node:crypto';
import {
  ComputeBudgetProgram,PublicKey,SystemProgram,TransactionInstruction,
  TransactionMessage,VersionedTransaction
} from '@solana/web3.js';
import type {AccountInfo,AddressLookupTableAccount,Connection,Keypair} from '@solana/web3.js';
import {ASSOCIATED_TOKEN,CLASSIC_TOKEN,JITO_TIP_ADDRESSES,JUPITER_PROGRAM,SOL,USDC} from './constants.js';
import {nativeFeePlan} from './feePolicy.js';
import {verifyNativeRoute,strengthenNativeMinimum} from './nativeRoute.js';
import {mintAddress,object,rawAmount} from './util.js';
import type {BackendConfig} from './config.js';
import type {BuildQuote} from './jupiterBuild.js';
import type {CoreChainPort,CoreConfig,CoreModules,NativeAudit,PreparedCoreSwap} from './types.js';

const TOKEN=new PublicKey(CLASSIC_TOKEN),ATA=new PublicKey(ASSOCIATED_TOKEN);
const ALLOWED=new Set([CLASSIC_TOKEN,ASSOCIATED_TOKEN,SystemProgram.programId.toBase58(),JUPITER_PROGRAM]);
type Info=AccountInfo<Buffer>|null;
interface Token {mint:string;owner:string;amount:bigint;reserve:bigint|null}

export function associated(owner:string,mint:string):PublicKey {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(),TOKEN.toBuffer(),new PublicKey(mint).toBuffer()],ATA)[0];
}

export function ownedToken(info:AccountInfo<Buffer>,owner:string,readOnly=false):Token {
  const b=info.data;
  if(info.executable||info.owner.toBase58()!==CLASSIC_TOKEN||b.length!==165||
    (readOnly?![1,2].includes(b[108]??0):b[108]!==1)||
    b.readUInt32LE(72)>1||b.readUInt32LE(129)>1||
    (!readOnly&&(b.readUInt32LE(72)!==0||b.readUInt32LE(129)!==0))||new PublicKey(b.subarray(32,64)).toBase58()!==owner)
    throw Error('Unexpected token-account program, owner, delegate, freeze or close authority');
  const native=b.readUInt32LE(109);
  if(native!==0&&native!==1)throw Error('Invalid native token-account option');
  const mint=new PublicKey(b.subarray(0,32)).toBase58(),reserve=native===1?b.readBigUInt64LE(113):null;
  if((mint===SOL)!==(reserve!==null))throw Error('Inconsistent wrapped SOL token account');
  if(!Number.isSafeInteger(info.lamports)||info.lamports<0)throw Error('Invalid token-account lamports');
  return {mint,owner,amount:b.readBigUInt64LE(64),reserve};
}

function nativeWallet(info:Info):number {
  if(!info||info.owner.toBase58()!==SystemProgram.programId.toBase58()||info.executable||info.data.length!==0||
    !Number.isSafeInteger(info.lamports)||info.lamports<0)throw Error('Unexpected native wallet account');
  return info.lamports;
}

export function validateNativeSimulation(input:{before:Info[];after:Info[];owner:string;side:'buy'|'sell';mint:string;amount:bigint;minimum:bigint;
  feeLamports:number;tipLamports:number;c:BackendConfig}):{rentDeltaLamports:number;outputRaw:string} {
  const {before,after,owner,side,mint,amount,minimum,feeLamports,tipLamports,c}=input;
  if(before.length!==after.length||before.length<2)throw Error('Incomplete native simulation account snapshot');
  const nativeBefore=nativeWallet(before[0]??null),nativeAfter=nativeWallet(after[0]??null);
  if(nativeAfter<Math.ceil(c.core.reserveSol*1e9))throw Error('Simulated SOL reserve is too low');
  const changes=new Map<string,bigint>();let rent=0;
  for(let i=1;i<before.length;i++) {
    const b=before[i],a=after[i],old=b?ownedToken(b,owner):null,current=a?ownedToken(a,owner):null;
    if(old&&current&&old.mint!==current.mint)throw Error('Token-account mint changed during simulation');
    for(const row of [old,current])if(row?.mint===SOL&&row.amount!==0n)
      throw Error('A funded or retained wrapped SOL account is outside this native trading path');
    const asset=current?.mint??old?.mint;
    if(asset)changes.set(asset,(changes.get(asset)??0n)+(current?.amount??0n)-(old?.amount??0n));
    rent+=(a?.lamports??0)-(b?.lamports??0);
  }
  if(!Number.isSafeInteger(rent)||rent>c.core.rentCap)throw Error('Native swap rent exceeds its limit');
  for(const [asset,change] of changes)if(asset!==mint&&change!==0n)
    throw Error('Native swap changes an unrelated token balance');
  if(!Number.isSafeInteger(feeLamports)||feeLamports<5000||!Number.isSafeInteger(tipLamports)||tipLamports<0||feeLamports+tipLamports>c.core.networkCap)
    throw Error('Native swap fees exceed the configured network cap');
  const economicSpend=BigInt(nativeBefore)-BigInt(nativeAfter)-BigInt(rent),cost=BigInt(feeLamports+tipLamports);
  const delta=changes.get(mint)??0n;
  if(side==='buy') {
    if(economicSpend!==amount+cost||delta<minimum)throw Error('Native buy spends an unexpected amount or receives too few tokens');
    return {rentDeltaLamports:rent,outputRaw:delta.toString()};
  }
  const grossOutput=-economicSpend+cost;
  if(delta!==-amount||grossOutput<minimum)throw Error('Native sell input or SOL output differs from the intent');
  return {rentDeltaLamports:rent,outputRaw:grossOutput.toString()};
}

function createNativeAta(owner:PublicKey):TransactionInstruction {
  return new TransactionInstruction({programId:ATA,data:Buffer.from([1]),keys:[
    {pubkey:owner,isSigner:true,isWritable:true},
    {pubkey:associated(owner.toBase58(),SOL),isSigner:false,isWritable:true},
    {pubkey:owner,isSigner:false,isWritable:false},
    {pubkey:new PublicKey(SOL),isSigner:false,isWritable:false},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
    {pubkey:TOKEN,isSigner:false,isWritable:false}
  ]});
}

function validateInstructions(quote:BuildQuote,owner:string,mint:string,amount:bigint,modules:CoreModules):void {
  let swaps=0;
  for(const ix of quote.instructions) {
    const program=ix.programId.toBase58();
    if(!ALLOWED.has(program))throw Error('Unapproved top-level native swap program');
    for(const key of ix.keys)if(key.isSigner&&key.pubkey.toBase58()!==owner)throw Error('Unapproved additional signer');
    if(program===JUPITER_PROGRAM) {
      ix.data=strengthenNativeMinimum(ix.data,rawAmount(quote.otherAmountThreshold));
      swaps++;verifyNativeRoute(ix.data,amount,rawAmount(quote.otherAmountThreshold),quote.slippageBps,modules.verifyRouteInstruction);
    } else if(program===ASSOCIATED_TOKEN) {
      const keys=ix.keys;
      if(ix.data.length>1||(ix.data.length===1&&ix.data[0]!==0&&ix.data[0]!==1)||keys.length!==6||keys[0]?.pubkey.toBase58()!==owner||keys[2]?.pubkey.toBase58()!==owner||
        ![SOL,mint].includes(keys[3]?.pubkey.toBase58()??'')||keys[1]?.pubkey.toBase58()!==associated(owner,keys[3]!.pubkey.toBase58()).toBase58()||
        !keys[4]?.pubkey.equals(SystemProgram.programId)||!keys[5]?.pubkey.equals(TOKEN))throw Error('Unsupported associated-token-account setup');
    } else {
      // Wrapping, unwrapping and tipping are constructed locally, never taken
      // from the untrusted provider's auxiliary instructions.
      throw Error('Provider supplied an unexpected native transfer or token instruction');
    }
  }
  if(swaps!==1)throw Error('Expected exactly one supported native swap instruction');
}

export class NativeSolChain implements CoreChainPort {
  wallet:Keypair|null=null;
  c:CoreConfig;
  private legacy:CoreChainPort;
  constructor(private config:BackendConfig,readonly connection:Connection,private modules:CoreModules,private tipFloor:()=>Promise<number|null>) {
    this.c=config.core;this.legacy=new modules.Chain({...this.c,mode:'paper'},connection);
  }
  get address():string|undefined {return this.wallet?.publicKey.toBase58();}
  async verifyMint(mint:string,decimals:number):Promise<void> {await this.legacy.verifyMint(mint,decimals);}
  async balances():Promise<{native:number;usdc:number;tokens:Record<string,bigint>}> {
    if(!this.wallet)throw Error('A live wallet is required');
    const owner=this.wallet.publicKey;
    const [native,accounts]=await Promise.all([this.connection.getBalance(owner),this.connection.getTokenAccountsByOwner(owner,{programId:TOKEN})]);
    if(!Number.isSafeInteger(native)||native<0)throw Error('Invalid native SOL balance');
    const tokens:Record<string,bigint>={};
    for(const account of accounts.value) {const row=ownedToken(account.account,this.address!,true);tokens[row.mint]=(tokens[row.mint]??0n)+row.amount;}
    if((tokens[SOL]??0n)>0n)throw Error('Use native SOL, rather than a funded wrapped SOL account, in this dedicated wallet');
    return {native,usdc:Number(tokens[USDC]??0n)/1e6,tokens};
  }

  async prepare(value:unknown,side:'buy'|'sell',mint:string,amount:bigint):Promise<PreparedCoreSwap> {
    if(!this.wallet||this.c.mode!=='live'||!this.c.liveReady||this.c.liveAck!=='I_ACCEPT_REAL_TRADES')throw Error('Native SOL signing requires explicit live enablement');
    mint=mintAddress(mint);const quote=value as BuildQuote;
    if(!quote||quote.kind!=='jupiter-build'||quote.taker!==this.address||!Number.isSafeInteger(quote.receivedAt)||Date.now()-quote.receivedAt>15000||quote.receivedAt>Date.now()+1000||
      quote.inputMint!==(side==='buy'?SOL:mint)||quote.outputMint!==(side==='buy'?mint:SOL)||rawAmount(quote.inAmount)!==amount||amount<=0n||
      !Number.isSafeInteger(quote.lastValidBlockHeight)||quote.lastValidBlockHeight<=0||!Number.isInteger(quote.slippageBps)||quote.slippageBps<0||
      quote.slippageBps>(side==='buy'?this.c.slippage:this.c.exitSlippage)||!Number.isFinite(quote.priceImpact)||quote.priceImpact<0||
      (side==='buy'&&quote.priceImpact>this.c.impact))throw Error('Invalid, stale or excessive-impact native SOL quote');
    const minimum=rawAmount(quote.otherAmountThreshold),output=rawAmount(quote.outAmount);
    if(minimum<=0n||minimum>output||minimum<output*BigInt(10000-quote.slippageBps)/10000n)throw Error('Invalid native minimum output');
    validateInstructions(quote,this.address!,mint,amount,this.modules);
    const owner=this.wallet.publicKey,wsol=associated(this.address!,SOL);
    const owned=await this.connection.getTokenAccountsByOwner(owner,{programId:TOKEN});
    const referred=new Set(quote.instructions.flatMap(ix=>ix.keys.map(key=>key.pubkey.toBase58())));
    const watched=owned.value.filter(account=>{
      // The SVM cannot modify accounts absent from the transaction. Unrelated
      // airdrops must not freeze exits or exhaust the simulation watch budget.
      if(!referred.has(account.pubkey.toBase58()))return false;
      const row=ownedToken(account.account,this.address!);
      if(row.mint===SOL&&(row.amount>0n||BigInt(account.account.lamports)!==row.reserve))throw Error('Existing wrapped SOL must be empty with only its rent reserve');
      return true;
    });
    const addresses=[...new Set([this.address!,...watched.map(account=>account.pubkey.toBase58()),wsol.toBase58(),associated(this.address!,mint).toBase58()])];
    if(addresses.length>30)throw Error('Too many funded or referenced token accounts for this dedicated wallet');
    const before=await this.connection.getMultipleAccountsInfo(addresses.map(address=>new PublicKey(address)),'confirmed');
    nativeWallet(before[0]??null);
    const lookupTables:AddressLookupTableAccount[]=[];
    for(const key of quote.lookupTables) {const table=await this.connection.getAddressLookupTable(new PublicKey(mintAddress(key)));if(!table.value)throw Error('Missing native swap lookup table');lookupTables.push(table.value);}
    const bodies=[createNativeAta(owner)];
    if(side==='buy') {
      bodies.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:wsol,lamports:amount}));
      bodies.push(new TransactionInstruction({programId:TOKEN,data:Buffer.from([17]),keys:[{pubkey:wsol,isSigner:false,isWritable:true}]}));
    }
    // Our idempotent ATA creation above replaces a provider WSOL ATA setup.
    bodies.push(...quote.instructions.filter(ix=>!(ix.programId.equals(ATA)&&ix.keys[1]?.pubkey.equals(wsol))));
    bodies.push(new TransactionInstruction({programId:TOKEN,data:Buffer.from([9]),keys:[
      {pubkey:wsol,isSigner:false,isWritable:true},{pubkey:owner,isSigner:false,isWritable:true},{pubkey:owner,isSigner:true,isWritable:false}
    ]}));
    const floor=this.config.executionTransport==='jito'?await this.tipFloor():null;
    const baseFees=nativeFeePlan(this.config,0n,1400000,floor);
    if(baseFees.jitoTipLamports)bodies.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:new PublicKey(JITO_TIP_ADDRESSES[0]!),lamports:baseFees.jitoTipLamports}));
    const make=(units:number,price:bigint)=>new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:quote.blockhash,
      instructions:[ComputeBudgetProgram.setComputeUnitLimit({units}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:price}),...bodies]}).compileToV0Message(lookupTables));
    const estimate=make(1400000,0n);
    if(estimate.message.header.numRequiredSignatures!==1)throw Error('Native swap has an additional signer');
    const estimated=await this.connection.simulateTransaction(estimate,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses}});
    if(estimated.value.err||!estimated.value.accounts||!Number.isSafeInteger(estimated.value.unitsConsumed)||Number(estimated.value.unitsConsumed)<=0)
      throw Error('Native swap compute estimation failed');
    const decode=(accounts:typeof estimated.value.accounts):Info[]=>accounts!.map(account=>account?{...account,owner:new PublicKey(account.owner),data:Buffer.from(account.data[0]!,'base64')}:null);
    validateNativeSimulation({before,after:decode(estimated.value.accounts),owner:this.address!,side,mint,amount,minimum,feeLamports:5000,tipLamports:baseFees.jitoTipLamports,c:this.config});
    const units=Math.min(1400000,Math.ceil(Number(estimated.value.unitsConsumed)*1.2));
    const plan=nativeFeePlan(this.config,quote.computePriceMicroLamports,units,floor),tx=make(units,plan.computePriceMicroLamports);
    const fee=(await this.connection.getFeeForMessage(tx.message,'confirmed')).value;
    if(fee===null||!Number.isSafeInteger(fee)||fee<5000||fee+plan.jitoTipLamports>this.c.networkCap)throw Error('Actual native message fee exceeds its cap');
    tx.sign([this.wallet]);
    const sim=await this.connection.simulateTransaction(tx,{sigVerify:true,commitment:'confirmed',accounts:{encoding:'base64',addresses}});
    if(sim.value.err||!sim.value.accounts)throw Error('Signed native SOL swap simulation failed');
    const effects=validateNativeSimulation({before,after:decode(sim.value.accounts),owner:this.address!,side,mint,amount,minimum,feeLamports:fee,tipLamports:plan.jitoTipLamports,c:this.config});
    if(Date.now()-quote.receivedAt>15000||await this.connection.getBlockHeight('confirmed')>=quote.lastValidBlockHeight)throw Error('Native swap expired during validation');
    const audit:NativeAudit={base:'SOL',side,mint,inputRaw:amount.toString(),minimumRaw:minimum.toString(),tipLamports:plan.jitoTipLamports,feeLamports:fee,
      rentDeltaLamports:effects.rentDeltaLamports,tokenAccounts:addresses.slice(1)};
    return {signedTransaction:Buffer.from(tx.serialize()).toString('base64'),signature:bs58.encode(tx.signatures[0]!),requestId:'native-'+tx.message.recentBlockhash,
      lastValidBlockHeight:quote.lastValidBlockHeight,minimum:minimum.toString(),nativeAudit:audit};
  }

  async settlement(value:Record<string,unknown>,commitment:'confirmed'|'finalized'=this.c.liveCommitment):Promise<Record<string,unknown>> {
    if(!this.wallet||typeof value.signature!=='string')throw Error('Native settlement requires a wallet and recorded signature');
    const audit=object(value.nativeAudit) as unknown as NativeAudit;
    if(audit.base!=='SOL'||!['buy','sell'].includes(audit.side)||typeof audit.mint!=='string'||
      !Array.isArray(audit.tokenAccounts)||audit.tokenAccounts.length>29||!Number.isSafeInteger(audit.tipLamports)||audit.tipLamports<0||audit.tipLamports>this.config.jitoMaxTip)
      throw Error('Invalid recorded native audit');
    const status=(await this.connection.getSignatureStatuses([value.signature],{searchTransactionHistory:true})).value[0];
    if(!status||!['confirmed','finalized'].includes(status.confirmationStatus??'')||(commitment==='finalized'&&status.confirmationStatus!=='finalized'))return {kind:'pending'};
    const tx=await this.connection.getTransaction(value.signature,{commitment,maxSupportedTransactionVersion:0});
    if(!tx?.meta)return {kind:'pending'};
    if(tx.transaction.message.version!==0||tx.transaction.message.header.numRequiredSignatures!==1)throw Error('Unsupported native receipt transaction');
    const keys=tx.transaction.message.getAccountKeys(tx.meta.loadedAddresses?{accountKeysFromLookups:tx.meta.loadedAddresses}:undefined);
    const indices=new Map<string,number>();for(let i=0;i<keys.length;i++)indices.set(keys.get(i)!.toBase58(),i);
    const index=indices.get(this.address!);if(index!==0||tx.transaction.signatures[0]!==value.signature)throw Error('Native receipt does not match its wallet/signature');
    const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),this.wallet.publicKey.toBuffer()]),format:'der',type:'spki'});
    if(!verify(null,tx.transaction.message.serialize(),publicKey,bs58.decode(value.signature)))throw Error('Native receipt signature does not verify against its message');
    if(audit.tokenAccounts.includes(this.address!)||!audit.tokenAccounts.includes(associated(this.address!,SOL).toBase58())||
      !audit.tokenAccounts.includes(associated(this.address!,mintAddress(audit.mint)).toBase58()))throw Error('Native audit lacks its controlled token accounts');
    const before=tx.meta.preBalances[index],after=tx.meta.postBalances[index],fee=tx.meta.fee;
    if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||!Number.isSafeInteger(fee)||fee<0)throw Error('Invalid native receipt balances');
    const nativeSpent=before!-after!;
    if(tx.meta.err)return {kind:'failed',nativeSpent,feeLamports:fee,confirmation:status.confirmationStatus};
    let rent=0;
    for(const address of new Set(audit.tokenAccounts.map(mintAddress))) {
      const i=indices.get(address);if(i!==undefined)rent+=(tx.meta.postBalances[i]??0)-(tx.meta.preBalances[i]??0);
    }
    const amount=rawAmount(audit.inputRaw),minimum=rawAmount(audit.minimumRaw);
    const total=(rows:NonNullable<typeof tx.meta.preTokenBalances>)=>rows.filter(row=>row.mint===audit.mint&&row.owner===this.address)
      .reduce((sum,row)=>sum+rawAmount(row.uiTokenAmount.amount),0n);
    const tokenDelta=total(tx.meta.postTokenBalances??[])-total(tx.meta.preTokenBalances??[]);
    const economic=BigInt(nativeSpent)-BigInt(rent),fees=BigInt(fee+audit.tipLamports);
    const baseDelta=audit.side==='buy'?-amount:-economic+fees;
    if(!Number.isSafeInteger(rent)||rent>this.c.rentCap||fee+audit.tipLamports>this.c.networkCap||
      (audit.side==='buy'&&(economic!==amount+fees||tokenDelta<minimum))||
      (audit.side==='sell'&&(tokenDelta!==-amount||baseDelta<minimum)))throw Error('Native confirmed receipt differs from its recorded intent');
    return {kind:'success',base:'SOL',baseDelta:baseDelta.toString(),nativeSpent,tokenDelta:tokenDelta.toString(),
      feeLamports:fee,tipLamports:audit.tipLamports,rentDeltaLamports:rent,confirmation:status.confirmationStatus};
  }
}

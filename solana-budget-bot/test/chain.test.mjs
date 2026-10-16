import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, Keypair, SystemProgram,TransactionMessage,TransactionInstruction,VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { TOKEN_PROGRAM, USDC, SOL, config } from '../src/config.mjs';
import { Chain, tokenAccount, mintCheck, validateSimulation,verifyRouteInstruction } from '../src/chain.mjs';
import {JUPITER_PROGRAM,anchorDiscriminator} from '../src/venues.mjs';
const owner = Keypair.generate().publicKey.toBase58();
const c = config({});
function account(mint, amount, delegate = 0) {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data,0); new PublicKey(owner).toBuffer().copy(data,32);
  data.writeBigUInt64LE(BigInt(amount),64); data.writeUInt32LE(delegate,72); data[108] = 1;
  return { data, owner: new PublicKey(TOKEN_PROGRAM), lamports: 2039280 };
}
test('large token amounts remain exact and authority-bearing mints fail', () => {
  assert.equal(tokenAccount(account(SOL, 2n ** 63n).data).amount, 2n ** 63n);
  const info = { owner: new PublicKey(TOKEN_PROGRAM), data: Buffer.alloc(82) };
  info.data[45] = 1; info.data[44] = 6; info.data.writeBigUInt64LE(1n,36);
  assert.equal(mintCheck(info), 6);
  info.data.writeUInt32LE(1,0); assert.throws(() => mintCheck(info));
});
test('simulation cannot spend extra USDC, add delegation, drain SOL or undershoot output', () => {
  const native = lamports => ({ owner: SystemProgram.programId, lamports });
  const before = [native(10000000), account(USDC,20000000), account(SOL,0)];
  const good = [native(9945000), account(USDC,19000000), account(SOL,10000000)];
  const args = { before, after: good, owner, side: 'buy', mint: SOL, amount: 1000000n, minimum: 9950000n, c };
  assert.doesNotThrow(() => validateSimulation(args));
  assert.throws(() => validateSimulation({ ...args, after: [good[0],account(USDC,18000000),good[2]] }));
  assert.throws(() => validateSimulation({ ...args, after: [good[0],good[1],account(SOL,10000000,1)] }));
  assert.throws(() => validateSimulation({ ...args, after: [native(1000),good[1],good[2]] }));
  assert.throws(() => validateSimulation({ ...args, after: [good[0],good[1],account(SOL,1)] }));
});
test('live construction is blocked before reading any private key file',()=>{
  const settings=config({MODE:'live',WALLET_FILE:'/does-not-exist',LIVE_ACK:'I_ACCEPT_REAL_TRADES'});
  assert.throws(()=>new Chain(settings,{}),/Live execution requires/);
});
test('the real SDK signs a v0 transaction only after wallet, programs and exact simulated balances pass',async()=>{
  const wallet=Keypair.generate(),target=Keypair.generate().publicKey;
  const owner=wallet.publicKey.toBase58();
  const tokenInfo=(mint,amount)=>{
    const data=Buffer.alloc(165);new PublicKey(mint).toBuffer().copy(data);wallet.publicKey.toBuffer().copy(data,32);
    data.writeBigUInt64LE(BigInt(amount),64);data[108]=1;
    return{owner:new PublicKey(TOKEN_PROGRAM),data,lamports:2039280,executable:false};
  };
  const route=Buffer.alloc(31);anchorDiscriminator('route').copy(route);route.writeBigUInt64LE(1000000n,12);route.writeBigUInt64LE(1000000n,20);route.writeUInt16LE(50,28);
  const ix=new TransactionInstruction({programId:new PublicKey(JUPITER_PROGRAM),keys:[],data:route});
  const message=new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[ix]}).compileToV0Message();
  const tx=new VersionedTransaction(message);
  let simulated=false;
  const native={owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:20000000,executable:false};
  const encode=info=>({...info,owner:info.owner.toBase58(),data:[info.data.toString('base64'),'base64']});
  const emptyAccounts=Array.from({length:37},()=>({pubkey:Keypair.generate().publicKey,account:tokenInfo(SOL,0)}));
  const connection={getTokenAccountsByOwner:async()=>({value:emptyAccounts}),getMultipleAccountsInfo:async addresses=>{
      assert.equal(addresses.length,3,'unreferenced empty token accounts must not exhaust the simulation watch list');
      return[native,tokenInfo(USDC,20000000),null];
    },
    simulateTransaction:async signed=>{
      simulated=true;assert.notDeepEqual([...signed.signatures[0]],Array(64).fill(0));
      return{value:{err:null,accounts:[encode({...native,lamports:20000000-56000-2039280}),encode(tokenInfo(USDC,19000000)),encode(tokenInfo(target,1000000))]}};
    },getBlockHeight:async()=>100};
  const chain=new Chain(c,connection);chain.wallet=wallet;
  const q={taker:owner,signatureFeePayer:owner,transaction:Buffer.from(tx.serialize()).toString('base64'),receivedAt:Date.now(),otherAmountThreshold:'995000',
    requestId:'id',lastValidBlockHeight:'1000'};
  const result=await chain.prepare(q,'buy',target.toBase58(),'1000000');
  assert.equal(simulated,true);assert.equal(result.minimum,'995000');
  assert.equal(bs58.encode(VersionedTransaction.deserialize(Buffer.from(result.signedTransaction,'base64')).signatures[0]),result.signature);
  await assert.rejects(chain.prepare({...q,taker:Keypair.generate().publicKey.toBase58()},'buy',target.toBase58(),'1000000'),/signer/);
});
test('a SOL transfer cannot hide inside the rent allowance',()=>{
  const native=lamports=>({owner:SystemProgram.programId,lamports});
  const before=[native(20000000),account(USDC,20000000),null];
  const after=[native(20000000-2039280-150000),account(USDC,19000000),account(SOL,1000000)];
  assert.throws(()=>validateSimulation({before,after,owner,side:'buy',mint:SOL,amount:1000000n,minimum:995000n,c}),/separate cap/);
});
test('transaction-encoded limits are checked independently of a good simulation or JSON quote',()=>{
  const data=Buffer.alloc(31);anchorDiscriminator('route').copy(data);data.writeBigUInt64LE(1000000n,12);data.writeBigUInt64LE(1000000n,20);data.writeUInt16LE(50,28);
  assert.doesNotThrow(()=>verifyRouteInstruction(data,1000000n,995000n,50));
  data.writeUInt16LE(500,28);assert.throws(()=>verifyRouteInstruction(data,1000000n,995000n,50),/weaker/);
  data.writeUInt16LE(50,28);data.writeBigUInt64LE(2000000n,12);assert.throws(()=>verifyRouteInstruction(data,1000000n,995000n,50),/weaker/);
  assert.throws(()=>verifyRouteInstruction(Buffer.alloc(31),1000000n,995000n,50),/Unsupported/);
  const withHiddenTail=Buffer.concat([data,data.subarray(data.length-19)]);
  assert.throws(()=>verifyRouteInstruction(withHiddenTail,2000000n,995000n,50),/trailing/);
  // Borsh plan: Raydium (variant 7) and Crema (variant 8, bool aToB).
  // Two route-plan steps also exercise layouts with variable-size enum fields.
  const length=Buffer.alloc(4);length.writeUInt32LE(2);
  const plan=Buffer.from([7,50,0,1,8,1,50,0,1]);
  const tail=Buffer.alloc(19);tail.writeBigUInt64LE(1000000n);tail.writeBigUInt64LE(1000000n,8);tail.writeUInt16LE(50,16);
  for(const shared of [false,true]){
    const head=shared?Buffer.concat([anchorDiscriminator('shared_accounts_route'),Buffer.from([1])]):anchorDiscriminator('route');
    const route=Buffer.concat([head,length,plan,tail]);
    assert.doesNotThrow(()=>verifyRouteInstruction(route,1000000n,995000n,50));
    const unknown=Buffer.from(route);unknown[head.length+4]=255;
    assert.throws(()=>verifyRouteInstruction(unknown,1000000n,995000n,50),/Unsupported/);
    assert.throws(()=>verifyRouteInstruction(Buffer.concat([route,Buffer.from([0])]),1000000n,995000n,50),/trailing/);
  }
});

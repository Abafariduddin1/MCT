import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { Chain } from '../src/chain.mjs';
import { config, USDC, SOL } from '../src/config.mjs';
test('pinned RPC dependency override works with the SDK JSON-RPC client', async () => {
  const seen = [];
  const connection = new Connection('https://rpc.invalid', {
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body); seen.push(request.method);
      const result = request.method === 'getSlot' ? 12345 : { context:{slot:12345}, value:10000000 };
      return new Response(JSON.stringify({ jsonrpc:'2.0',id:request.id,result }), { status:200,headers:{'content-type':'application/json'} });
    }
  });
  assert.equal(await connection.getSlot('confirmed'),12345);
  assert.equal(await connection.getBalance(new PublicKey(SOL)),10000000);
  assert.deepEqual(seen,['getSlot','getBalance']);
});
test('settlement uses confirmed token and SOL deltas, including owner identity', async () => {
  const wallet = Keypair.generate();
  const owner = wallet.publicKey.toBase58();
  const message = new TransactionMessage({ payerKey:wallet.publicKey,
    recentBlockhash:Keypair.generate().publicKey.toBase58(), instructions:[SystemProgram.transfer({ fromPubkey:wallet.publicKey,toPubkey:new PublicKey(SOL),lamports:1 })]
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const row = (mint,amount) => ({ mint,owner,uiTokenAmount:{amount:String(amount)} });
  const connection = {
    getSignatureStatuses:async () => ({ value:[{confirmationStatus:'finalized'}] }),
    getTransaction:async () => ({ transaction:tx,meta:{err:null,loadedAddresses:{writable:[],readonly:[]},
      preBalances:[10000000,1],postBalances:[9945000,1],
      preTokenBalances:[row(USDC,20000000),row(SOL,0)], postTokenBalances:[row(USDC,19000000),row(SOL,10000000)] } })
  };
  const chain = new Chain(config({}),connection); chain.wallet = wallet;
  const result = await chain.settlement({ signature:'sig',side:'buy',mint:SOL });
  assert.equal(result.kind,'success'); assert.equal(result.nativeSpent,55000);
  assert.equal(result.usdcDelta,'-1000000'); assert.equal(result.tokenDelta,'10000000');
});
test('non-finalized execution cannot commit the trade ledger',async()=>{
  let fetched=false;
  const chain=new Chain(config({}),{getSignatureStatuses:async()=>({value:[{confirmationStatus:'confirmed'}]}),
    getTransaction:async()=>{fetched=true;}});
  assert.deepEqual(await chain.settlement({signature:'sig'}),{kind:'pending'});assert.equal(fetched,false);
});

import fs from 'node:fs';
import bs58 from 'bs58';
import { Connection, PublicKey, Keypair, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM, ATA_PROGRAM, USDC } from './config.mjs';
import { raw, units } from './util.mjs';
import { JUPITER_PROGRAM,anchorDiscriminator } from './venues.mjs';
import { routeArgumentsOffset } from './route-layout.mjs';
const TOKEN = new PublicKey(TOKEN_PROGRAM), ATA = new PublicKey(ATA_PROGRAM);
const TOP_PROGRAMS = new Set([
  TOKEN_PROGRAM, ATA_PROGRAM, SystemProgram.programId.toBase58(),
  'ComputeBudget111111111111111111111111111111',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
]);
export function verifyRouteInstruction(data,amount,minimum,slippageCap) {
  const b=Buffer.from(data);
  if(b.length<31||![anchorDiscriminator('route'),anchorDiscriminator('shared_accounts_route')].some(d=>b.subarray(0,8).equals(d)))
    throw new Error('Unsupported Jupiter instruction layout; refuse to guess its limits');
  routeArgumentsOffset(b,b.subarray(0,8).equals(anchorDiscriminator('shared_accounts_route')));
  // These exact-in IDL layouts end in u64 inAmount, u64 quotedOut, u16 slippage, u8 fee.
  const input=b.readBigUInt64LE(b.length-19),output=b.readBigUInt64LE(b.length-11),slippage=b.readUInt16LE(b.length-3);
  if(input!==BigInt(amount)||output===0n||slippage>slippageCap||slippage>10000||output*BigInt(10000-slippage)/10000n<BigInt(minimum))
    throw new Error('Encoded route input or minimum output is weaker than the requested trade');
}
export function tokenAccount(data) {
  const b = Buffer.from(data);
  if (b.length !== 165) throw new Error('Unsupported token-account layout');
  return { mint: new PublicKey(b.subarray(0,32)).toBase58(), owner: new PublicKey(b.subarray(32,64)).toBase58(),
    amount: b.readBigUInt64LE(64), delegate: b.readUInt32LE(72), state: b[108], close: b.readUInt32LE(129) };
}
export function mintCheck(info) {
  if (!info || info.owner.toBase58() !== TOKEN_PROGRAM || info.data.length !== 82) throw new Error('Unsupported mint program or layout');
  const b = info.data;
  if (b.readUInt32LE(0) !== 0 || b.readUInt32LE(46) !== 0 || b[45] !== 1 || b.readBigUInt64LE(36) === 0n)
    throw new Error('Mint/freeze authority enabled, uninitialised mint or zero supply');
  return b[44];
}
export function ata(owner, mint) {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), TOKEN.toBuffer(), new PublicKey(mint).toBuffer()], ATA)[0];
}
export class Chain {
  constructor(c, connection) {
    this.c = c;
    this.connection = connection || new Connection(c.rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }) });
    this.wallet = null;
    this.mintCache=new Map();
    if (c.mode === 'live') {
      if (!c.liveReady) throw new Error('Live execution requires ENABLE_LIVE_TRADING=true');
      if (c.liveAck !== 'I_ACCEPT_REAL_TRADES') throw new Error('Live mode requires LIVE_ACK=I_ACCEPT_REAL_TRADES');
      const key = JSON.parse(fs.readFileSync(c.walletFile, 'utf8'));
      if (!Array.isArray(key) || key.length !== 64 || key.some(x => !Number.isInteger(x) || x < 0 || x > 255))
        throw new Error('Wallet file must contain a 64-byte Solana secret-key array');
      this.wallet = Keypair.fromSecretKey(Uint8Array.from(key));
    }
  }
  get address() { return this.wallet?.publicKey.toBase58(); }
  async verifyMint(mint, decimals) {
    const cached=this.mintCache.get(mint);
    if(cached&&cached.decimals===decimals&&Date.now()-cached.at<300000)return;
    const actual = mintCheck(await this.connection.getAccountInfo(new PublicKey(mint),'finalized'));
    if (actual !== decimals) throw new Error('On-chain decimals differ from market metadata');
    this.mintCache.set(mint,{decimals,at:Date.now()});
    if(this.mintCache.size>500)this.mintCache.delete(this.mintCache.keys().next().value);
  }
  async balances() {
    const owner = this.wallet.publicKey;
    const [native, accounts] = await Promise.all([
      this.connection.getBalance(owner), this.connection.getTokenAccountsByOwner(owner, { programId: TOKEN })
    ]);
    const tokens = {};
    for (const a of accounts.value) {
      const t = tokenAccount(a.account.data);
      if (t.owner !== this.address || t.delegate !== 0 || t.close !== 0 || t.state !== 1)
        throw new Error('Wallet has a delegated, frozen or unexpected token account');
      tokens[t.mint] = (tokens[t.mint] || 0n) + t.amount;
    }
    return { native, tokens, usdc: units(tokens[USDC] || 0n) };
  }
  async prepare(q, side, mint, amount) {
    if (Date.now() - q.receivedAt > 15000) throw new Error('Order is too old; discard and requote');
    if (q.taker !== this.address || q.signatureFeePayer !== this.address) throw new Error('Unexpected signer or fee payer');
    const tx = VersionedTransaction.deserialize(Buffer.from(q.transaction, 'base64'));
    if (tx.version !== 0 || tx.message.header.numRequiredSignatures !== 1 || !tx.message.staticAccountKeys[0].equals(this.wallet.publicKey))
      throw new Error('Unexpected transaction version or signers');
    const tables = [];
    for (const lookup of tx.message.addressTableLookups) {
      const result = await this.connection.getAddressLookupTable(lookup.accountKey);
      if (!result.value) throw new Error('Missing lookup table');
      tables.push(result.value);
    }
    const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: tables });
    let swaps=0;
    for (const ix of tx.message.compiledInstructions) {
      if (!TOP_PROGRAMS.has(keys.get(ix.programIdIndex)?.toBase58())) throw new Error('Unapproved top-level transaction program');
      if(keys.get(ix.programIdIndex).toBase58()===JUPITER_PROGRAM){
        swaps++;verifyRouteInstruction(ix.data,amount,raw(q.otherAmountThreshold),side==='buy'?this.c.slippage:this.c.exitSlippage);
      }
    }
    if(swaps!==1)throw new Error('Expected exactly one supported Jupiter swap instruction');
    const owned = await this.connection.getTokenAccountsByOwner(this.wallet.publicKey, { programId: TOKEN });
    const transactionAccounts=new Set(Array.from({length:keys.length},(_,i)=>keys.get(i).toBase58()));
    const watched=owned.value.filter(a=>{
      const token=tokenAccount(a.account.data);
      if(a.account.owner.toBase58()!==TOKEN_PROGRAM||token.owner!==this.address||token.delegate||token.close||token.state!==1)
        throw new Error('Unexpected pre-swap token-account authority');
      // Empty accounts absent from the transaction cannot be changed by it.
      // Keep every funded or referenced account under simulation checks without
      // growing the watch list each time an old token is fully sold.
      return token.amount>0n||transactionAccounts.has(a.pubkey.toBase58());
    });
    const addresses = [...new Set([
      this.address, ...watched.map(x => x.pubkey.toBase58()),
      ata(this.address, USDC).toBase58(), ata(this.address, mint).toBase58()
    ])];
    if (addresses.length > 30) throw new Error('Too many funded or transaction-referenced token accounts; use a dedicated bot wallet');
    const before = await this.connection.getMultipleAccountsInfo(addresses.map(x => new PublicKey(x)));
    tx.sign([this.wallet]);
    const sim = await this.connection.simulateTransaction(tx, {
      sigVerify: true, commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses }
    });
    if (sim.value.err || !sim.value.accounts) throw new Error('Transaction simulation failed');
    const after = sim.value.accounts.map(a => a ? { ...a, data: Buffer.from(a.data[0], 'base64'), owner: new PublicKey(a.owner) } : null);
    validateSimulation({ before, after, owner: this.address, side, mint, amount: BigInt(amount),
      minimum: raw(q.otherAmountThreshold), c: this.c });
    if (Date.now() - q.receivedAt > 20000 || await this.connection.getBlockHeight('confirmed') >= Number(q.lastValidBlockHeight))
      throw new Error('Order expired during validation; discard and requote');
    return { signedTransaction: Buffer.from(tx.serialize()).toString('base64'), signature: bs58.encode(tx.signatures[0]),
      lastValidBlockHeight: Number(q.lastValidBlockHeight), requestId: q.requestId,minimum:q.otherAmountThreshold };
  }
  async settlement(p,commitment=this.c.liveCommitment||'finalized') {
    const response = await this.connection.getSignatureStatuses([p.signature], { searchTransactionHistory: true });
    const status = response.value[0];
    if (!status || !['confirmed','finalized'].includes(status.confirmationStatus) || (commitment==='finalized'&&status.confirmationStatus!=='finalized')) return { kind: 'pending' };
    const tx = await this.connection.getTransaction(p.signature, { commitment, maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return { kind: 'pending' };
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    let index = -1;
    for (let i = 0; i < keys.length; i++) if (keys.get(i).toBase58() === this.address) { index = i; break; }
    if (index < 0) throw new Error('Confirmed transaction does not contain bot wallet');
    const nativeSpent = tx.meta.preBalances[index] - tx.meta.postBalances[index];
    if (!Number.isSafeInteger(nativeSpent)) throw new Error('Invalid confirmed SOL balance change');
    if (tx.meta.err) return { kind: 'failed', nativeSpent,confirmation:status.confirmationStatus };
    const totals = (rows, mint) => rows.filter(r => r.mint === mint && r.owner === this.address)
      .reduce((sum, r) => sum + raw(r.uiTokenAmount.amount), 0n);
    const before = tx.meta.preTokenBalances || [], after = tx.meta.postTokenBalances || [];
    const usdcDelta = totals(after, USDC) - totals(before, USDC);
    const tokenDelta = totals(after, p.mint) - totals(before, p.mint);
    if (p.side === 'buy' && (usdcDelta >= 0n || tokenDelta <= 0n)) throw new Error('Unexpected confirmed buy balances');
    if (p.side === 'sell' && (usdcDelta <= 0n || tokenDelta >= 0n)) throw new Error('Unexpected confirmed sell balances');
    return { kind: 'success', nativeSpent, usdcDelta: usdcDelta.toString(), tokenDelta: tokenDelta.toString(),confirmation:status.confirmationStatus };
  }
}
export function validateSimulation({ before, after, owner, side, mint, amount, minimum, c }) {
  if (!before[0] || !after[0] || after[0].owner.toBase58() !== SystemProgram.programId.toBase58()
      || after[0].executable || (after[0].data?.length || 0) !== 0)
    throw new Error('Wallet account changed unexpectedly');
  const nativeSpent = before[0].lamports - after[0].lamports;
  if (nativeSpent > c.networkCap + c.rentCap || after[0].lamports < c.reserveSol * 1e9)
    throw new Error('Simulated SOL cost too high or reserve too low');
  const changes = {};
  let rentDelta=0;
  for (let i = 1; i < before.length; i++) {
    const b = before[i], a = after[i];
    const old = b ? tokenAccount(b.data) : null;
    const current = a ? tokenAccount(a.data) : null;
    if (old && (b.owner.toBase58() !== TOKEN_PROGRAM || old.owner !== owner || old.delegate || old.close || old.state !== 1))
      throw new Error('Unexpected pre-swap token-account authority');
    if (current && (a.owner.toBase58() !== TOKEN_PROGRAM || current.owner !== owner || current.delegate || current.close || current.state !== 1))
      throw new Error('Unexpected simulated token-account authority');
    if (old && current && old.mint !== current.mint) throw new Error('Token-account mint changed');
    const m = current?.mint || old?.mint;
    if (m) changes[m] = (changes[m] || 0n) + (current?.amount || 0n) - (old?.amount || 0n);
    rentDelta+=(a?.lamports||0)-(b?.lamports||0);
  }
  for (const [m, change] of Object.entries(changes)) if (![USDC, mint].includes(m) && change < 0n)
    throw new Error('Swap would spend an unrelated wallet token');
  const input = side === 'buy' ? USDC : mint, output = side === 'buy' ? mint : USDC;
  if(nativeSpent-rentDelta>c.networkCap||rentDelta>c.rentCap)throw new Error('Simulated transfer/network spending or account rent exceeds its separate cap');
  if (-(changes[input] || 0n) !== amount || (changes[output] || 0n) < minimum)
    throw new Error('Simulation input/output differs from requested trade');
}

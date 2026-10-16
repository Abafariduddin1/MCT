import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {JITO_TIP_ADDRESSES} from './constants.js';
import {JsonHttp} from './http.js';
import {object,rawAmount} from './util.js';
import {validatedPayload} from './solana.js';
import {SubmissionJournal} from './submissionJournal.js';
import type {BackendConfig} from './config.js';
import type {ValidatedSwap} from './types.js';

export const JITO_TIP_ACCOUNTS:ReadonlySet<string>=new Set(JITO_TIP_ADDRESSES);
const trustedTips=new Set(JITO_TIP_ADDRESSES);

export class JitoExecutor {
  private journal:SubmissionJournal;
  private id=0;
  constructor(private c:BackendConfig,private http=new JsonHttp(fetch,1100)) {
    this.journal=new SubmissionJournal(c.stateDir);
  }

  async send(swap:ValidatedSwap):Promise<{signature:string;bundleId:string;stage:'submitted';transportLatencyMs:number}> {
    if(this.c.core.mode!=='live'||!this.c.core.liveReady||this.c.core.liveAck!=='I_ACCEPT_REAL_TRADES'||this.c.executionTransport!=='jito')
      throw Error('Jito real execution is not enabled');
    const payload=validatedPayload(swap);
    return payload.withExitBudget(async()=>{
      await payload.gate.assertPersisted(swap.signature);
      await this.checkExpiry(swap);
      const tx=VersionedTransaction.deserialize(Buffer.from(payload.prepared.signedTransaction,'base64'));
      if(tx.version!==0||tx.signatures.length!==1||tx.message.header.numRequiredSignatures!==1||
        tx.message.staticAccountKeys[0]?.toBase58()!==payload.payer||bs58.encode(tx.signatures[0]!)!==swap.signature)
        throw Error('Signed transaction does not match validated intent');
      const tables=[];
      for(const lookup of tx.message.addressTableLookups) {
        const row=await payload.chain.connection.getAddressLookupTable(lookup.accountKey);
        if(!row.value)throw Error('Missing transaction lookup table');tables.push(row.value);
      }
      const keys=tx.message.getAccountKeys({addressLookupTableAccounts:tables});let tip=0n,wrapped=0n;
      for(const ix of tx.message.compiledInstructions) {
        if(!keys.get(ix.programIdIndex)?.equals(SystemProgram.programId))continue;
        const data=Buffer.from(ix.data);
        if(data.length!==12||data.readUInt32LE(0)!==2||ix.accountKeyIndexes.length!==2)
          throw Error('Unsupported top-level System instruction in the bundle');
        const from=keys.get(ix.accountKeyIndexes[0]!),to=keys.get(ix.accountKeyIndexes[1]!);
        if(from?.toBase58()!==payload.payer||!to)throw Error('Unexpected SOL transfer signer');
        const amount=data.readBigUInt64LE(4);
        if(trustedTips.has(to.toBase58()))tip+=amount;
        else if(payload.base==='SOL'&&swap.side==='buy'&&to.toBase58()===payload.wrapAddress)wrapped+=amount;
        else throw Error('Unexpected top-level SOL transfer in the bundle');
      }
      if(tip<1000n||tip>BigInt(payload.tipCap)||tip>BigInt(this.c.jitoMaxTip))throw Error('Bundle tip is missing or exceeds its cap');
      if(payload.base==='SOL') {
        const audit=payload.prepared.nativeAudit;if(!audit)throw Error('Native bundle lacks its audited effects');
        if(wrapped!==(swap.side==='buy'?rawAmount(audit.inputRaw):0n)||tip!==BigInt(audit.tipLamports))
          throw Error('Bundle wrapping or tip differs from the simulated native intent');
      }
      const reservation=this.journal.reserve({signature:swap.signature,bytesHash:createHash('sha256').update(tx.serialize()).digest('hex'),transport:'jito',
        at:Date.now(),bundleId:null,outcome:'attempted'});
      const started=performance.now();
      try {
        const response=object(await this.http.request(this.c.jitoOrigin+'/api/v1/bundles',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:++this.id,method:'sendBundle',params:[[payload.prepared.signedTransaction],{encoding:'base64'}]})},1,async()=>{
            await payload.gate.assertPersisted(swap.signature);await this.checkExpiry(swap);
          }));
        if(response.error||typeof response.result!=='string'||!/^[a-fA-F0-9]{32,128}$/.test(response.result))throw Error('Jito submission outcome is unknown');
        reservation.finish('accepted',response.result);
        return {signature:swap.signature,bundleId:response.result,stage:'submitted',transportLatencyMs:performance.now()-started};
      }catch(error) {reservation.finish('unknown');throw error;}finally {reservation.release();}
    });
  }

  private async checkExpiry(swap:ValidatedSwap):Promise<void> {
    const payload=validatedPayload(swap);
    if(Date.now()-swap.preparedAt>15000||await payload.chain.connection.getBlockHeight('confirmed')>=swap.lastValidBlockHeight)
      throw Error('Validated swap expired before submission');
  }

  async status(bundleId:string):Promise<{status:'pending'|'landed'|'failed'|'unknown';slot:number|null}> {
    if(!/^[a-fA-F0-9]{32,128}$/.test(bundleId))throw Error('Invalid bundle ID');
    const response=object(await this.http.request(this.c.jitoOrigin+'/api/v1/bundles',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:++this.id,method:'getInflightBundleStatuses',params:[[bundleId]]})},2));
    if(response.error)throw Error('Jito status lookup failed');
    const result=object(response.result);if(!Array.isArray(result.value))throw Error('Malformed Jito status');
    const row=result.value.map(object).find(value=>value.bundle_id===bundleId);
    if(!row)return {status:'unknown',slot:null};
    const status=row.status==='Pending'?'pending':row.status==='Landed'?'landed':row.status==='Failed'?'failed':'unknown';
    return {status,slot:Number.isSafeInteger(row.landed_slot)?Number(row.landed_slot):null};
  }
}

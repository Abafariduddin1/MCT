import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {VersionedTransaction} from '@solana/web3.js';
import {validatedPayload} from './solana.js';
import {SubmissionJournal} from './submissionJournal.js';
import type {BackendConfig} from './config.js';
import type {ValidatedSwap} from './types.js';

export class RpcExecutor {
  private journal:SubmissionJournal;
  constructor(private c:BackendConfig) {this.journal=new SubmissionJournal(c.stateDir);}

  async send(swap:ValidatedSwap):Promise<{signature:string;stage:'submitted';transportLatencyMs:number}> {
    if(this.c.core.mode!=='live'||!this.c.core.liveReady||this.c.core.liveAck!=='I_ACCEPT_REAL_TRADES'||this.c.executionTransport!=='rpc')
      throw Error('RPC real execution is not enabled');
    const payload=validatedPayload(swap);
    if(payload.base!=='SOL'||payload.prepared.nativeAudit?.tipLamports!==0)throw Error('RPC transport expects an audited untipped native SOL swap');
    return payload.withExitBudget(async()=>{
      await payload.gate.assertPersisted(swap.signature);
      if(Date.now()-swap.preparedAt>15000||await payload.chain.connection.getBlockHeight('confirmed')>=swap.lastValidBlockHeight)
        throw Error('Native RPC swap expired before submission');
      const bytes=Buffer.from(payload.prepared.signedTransaction,'base64'),tx=VersionedTransaction.deserialize(bytes);
      if(tx.version!==0||tx.signatures.length!==1||bs58.encode(tx.signatures[0]!)!==swap.signature)throw Error('RPC transaction does not match its guarded intent');
      const reservation=this.journal.reserve({signature:swap.signature,bytesHash:createHash('sha256').update(bytes).digest('hex'),transport:'rpc',
        at:Date.now(),bundleId:null,outcome:'attempted'}),started=performance.now();
      try {
        const result=await payload.chain.connection.sendRawTransaction(bytes,{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});
        if(result!==swap.signature)throw Error('RPC submission returned an unexpected signature');
        reservation.finish('accepted');return {signature:result,stage:'submitted',transportLatencyMs:performance.now()-started};
      }catch {reservation.finish('unknown');throw Error('RPC submission outcome is unknown; reconcile its signature before another order');}
      finally {reservation.release();}
    });
  }
}

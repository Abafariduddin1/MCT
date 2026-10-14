import {loadConfig} from './config.js';
import {SolanaService} from './solana.js';
import {RugCheckClient,SafetyAggregator} from './rugcheck.js';
import {DexScreener} from './dexScreener.js';
import {PumpStream} from './pumpStream.js';
import {FeedService} from './feed.js';
import {createVault} from './walletVault.js';
import {safeError} from './util.js';
import type {PortfolioGate} from './types.js';

const readOnly:PortfolioGate={
  assertAllowed:async()=>{throw Error('Read-only command cannot authorize a trade');},
  assertPersisted:async()=>{throw Error('Read-only command cannot submit a trade');}
};

async function main():Promise<void> {
  const c=await loadConfig(),command=process.argv[2]||'doctor';
  if(command==='vault-create') {
    const address=createVault(c.walletVault,c.walletEncryptionKey);
    console.log('Encrypted dedicated wallet created. Public address: '+address);return;
  }
  if(!['doctor','feed'].includes(command))throw Error('Use doctor, feed or vault-create');
  // The public Step 1 commands never unlock a wallet or authorize a transaction.
  const service=await SolanaService.create({...c,core:{...c.core,mode:'paper'}},readOnly);
  const slot=await service.connection.getSlot('confirmed');
  console.log('Read-only RPC connected at slot '+slot+'.');
  if(c.core.apiKey)await service.reference.get();
  console.log(JSON.stringify({requestedMode:c.core.mode,readOnly:true,executionTransport:c.executionTransport,
    solUsdReference:service.reference.peek()?.solUsd??null,pumpMeteredData:c.allowMeteredPump,rpcBudget:service.quota.snapshot(),
    liveSettlementAsset:c.liveBase,paperSettlementAsset:c.core.paperBase,maxBuySol:Number(c.maxBuyLamports)/1e9},null,2));
  const pump=new PumpStream(c);
  if(command==='doctor') {
    const result=c.pumpEnabled?await new Promise<{ready:boolean;error:string|null}>(resolve=>{
      let finished=false,connected=false;
      const finish=(value:{ready:boolean;error:string|null})=>{if(finished)return;finished=true;clearTimeout(timer);pump.stop();resolve(value);};
      const timer=setTimeout(()=>finish({ready:false,error:connected?'Connected, but no free launch/migration event observed during the probe':'PumpPortal handshake timed out'}),10000);
      pump.on('health',health=>{connected=Boolean(health.connected);if(!finished&&health.error)finish({ready:false,error:health.error});});
      pump.on('token',event=>{if(event.kind==='create'||event.kind==='migration')finish({ready:true,error:null});});pump.start();
    }):{ready:false,error:'Pump stream intentionally disabled'};
    console.log(JSON.stringify({pumpFreeStream:result,warning:'Connections do not establish successful fills, token safety or latency.'}));return;
  }
  const feed=new FeedService(c,pump,new DexScreener(),new SafetyAggregator(c,service,new RugCheckClient(c)),()=>service.reference.peek()?.solUsd??null);
  feed.on('update',tokens=>console.log(JSON.stringify({type:'FEED_UPDATE',tokens})));
  feed.on('health',health=>console.log(JSON.stringify({type:'HEALTH_UPDATE',health})));
  let stopped=false,referenceWork:Promise<unknown>|null=null;
  const references=setInterval(()=>{
    if(stopped||referenceWork||!c.core.apiKey)return;
    referenceWork=service.reference.get().catch(error=>{
      if(!stopped)console.log(JSON.stringify({type:'HEALTH_UPDATE',health:{referenceError:safeError(error,[c.core.apiKey,c.core.rpc])}}));
    }).finally(()=>{referenceWork=null;});
  },10000);
  feed.start();
  await new Promise<void>(resolve=>{
    const stop=()=>{
      if(stopped)return;stopped=true;clearInterval(references);
      void Promise.allSettled([feed.stop(),referenceWork??Promise.resolve()]).then(()=>resolve());
    };
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  });
}

main().catch(error=>{
  console.error(safeError(error,[process.env.RPC_HTTP_URL||'',process.env.JUPITER_API_KEY||'',process.env.PUMPPORTAL_API_KEY||'',process.env.WALLET_ENCRYPTION_KEY||'']));
  process.exitCode=1;
});

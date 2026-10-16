import fs from 'node:fs';
import path from 'node:path';
import {Ledger,initialLedger,amount,unresolved} from './ledger.js';
import {BotEngine,limit} from './botEngine.js';
import {SolanaService} from './solana.js';
import {loadControllerCore} from './controllerCore.js';
import {ControllerProviders} from './controllerProviders.js';
import {JsonHttp} from './http.js';
import {RugCheckClient,SafetyAggregator} from './rugcheck.js';
import {FeedService} from './feed.js';
import {DexScreener} from './dexScreener.js';
import {PumpStream} from './pumpStream.js';
import {CopyController} from './copyController.js';
import {ControllerServer,validateServerSettings} from './server.js';
import {Notifications} from './notifications.js';
import {solCostMicroUsdc} from './priceReference.js';
import {mintAddress,safeError} from './util.js';
import {SOL} from './constants.js';
import type {BackendConfig} from './config.js';
import type {Candidate} from './controllerTypes.js';
import type {ServerOptions} from './server.js';
import type {PortfolioGate} from './types.js';

export async function startController(c:BackendConfig,options:ServerOptions={}):Promise<{engine:BotEngine;server:ControllerServer;port:number;stop:()=>Promise<void>}> {
  validateServerSettings(c,options);
  if(c.liveBase!=='SOL'||c.core.paperBase!=='SOL')throw Error('Controller requires LIVE_BASE=SOL and PAPER_BASE=SOL');
  if(!c.core.rpc||!c.core.apiKey||/YOUR|PLACEHOLDER/.test(c.core.rpc+c.core.apiKey))throw Error('Configure RPC_HTTP_URL and JUPITER_API_KEY locally');
  if(c.core.copyLeader)mintAddress(c.core.copyLeader);
  let engine:BotEngine|undefined;
  const gate:PortfolioGate={assertAllowed:async intent=>{if(!engine)throw Error('Controller gate is not ready');await engine.assertAllowed(intent);},assertPersisted:async signature=>{if(!engine)throw Error('Controller gate is not ready');await engine.assertPersisted(signature);}};
  const modules=await loadControllerCore(),solana=await SolanaService.create(c,gate);
  const api=new modules.Jupiter(c.core,{request:(url,init,attempts,schedule)=>solana.jupiterHttp.request(url,init,attempts,undefined,schedule)});
  const safety=new SafetyAggregator(c,solana,new RugCheckClient(c)),providers=new ControllerProviders(c,solana,api,safety);
  const file=path.join(c.stateDir,'controller',c.core.mode,'ledger.json'),wallet=c.core.mode==='paper'?'paper':solana.chain.address!;
  let initial:ReturnType<typeof initialLedger>|null=null;
  const fx=new modules.FxReference();
  if(!fs.existsSync(file)){
    if(c.core.mode==='live'&&fs.existsSync(path.join(c.core.dataDir,'state.json')))throw Error('Existing standalone live ledger found; an explicit reconciliation/import is required');
    const ref=await providers.reference();
    const rate=limit(c,'eurUsd')>0?{eurUsd:limit(c,'eurUsd'),fetchedAt:Date.now(),source:'Configured reference (not an executable conversion)'}:await fx.get();
    let cash:bigint;
    if(c.core.mode==='paper')cash=limit(c,'paperInitialSol')>0?BigInt(Math.floor(limit(c,'paperInitialSol')*1e9)):BigInt(Math.floor(limit(c,'paperBalanceEur')*rate.eurUsd/ref.solUsd*1e9));
    else{const b=await solana.chain.balances();if(!Number.isSafeInteger(b.native)||(b.tokens[SOL]??0n)>0n)throw Error('Unsupported initial native balance or funded WSOL account');cash=BigInt(b.native);if(solCostMicroUsdc(cash,ref)>BigInt(Math.floor(c.core.liveCap*1e6)))throw Error('Dedicated wallet exceeds LIVE_INITIAL_USDC_CAP');}
    if(cash<=BigInt(Math.ceil(c.core.reserveSol*1e9)))throw Error('Initial capital cannot cover the SOL reserve');
    if(!Number.isInteger(limit(c,'normalPct'))||!Number.isInteger(limit(c,'copyPct')))throw Error('Controller allocations require integer percentages');
    initial=initialLedger({mode:c.core.mode,wallet,cash,reference:ref,normalPct:limit(c,'normalPct'),copyPct:limit(c,'copyPct'),leader:typeof c.core.copyLeader==='string'&&c.core.copyLeader?c.core.copyLeader:null,orderLamports:c.maxBuyLamports<50000000n?c.maxBuyLamports:50000000n});
    initial.fx={eurUsd:rate.eurUsd,at:rate.fetchedAt,source:rate.source};
  }
  const ledger=new Ledger(file,()=>{if(!initial)throw Error('Initial ledger missing');return initial;},{mode:c.core.mode,wallet});
  let feed:FeedService|null=null,server:ControllerServer|null=null,copy:CopyController|null=null,alerts:Notifications|null=null;
  let stopping=false,timer:ReturnType<typeof setInterval>|null=null;
  const jobs=new Set<Promise<unknown>>();
  try{
    const saved=ledger.read(),leader=typeof c.core.copyLeader==='string'&&c.core.copyLeader?c.core.copyLeader:null;
    if(saved.copy.leader!==leader)throw Error('COPY_LEADER differs from the saved controller; preserve records and reconcile before changing leaders');
    engine=new BotEngine(c,ledger);const bot=engine;bot.attach(providers,e=>modules.screen(e.token,c.core,Date.now(),e.slot));bot.recover();
    const pump=new PumpStream(c);feed=new FeedService(c,pump,new DexScreener(),safety,()=>solana.reference.peek()?.solUsd??null);
    server=new ControllerServer(c,bot,()=>feed!.snapshot(),options);feed.on('update',()=>server?.feedChanged());
    feed.on('health',health=>{bot.health.lastError=safeError(JSON.stringify(health),[c.core.rpc,c.core.apiKey,c.pumpApiKey]);});
    const historyHttp=new JsonHttp(solana.rpcFetch,250);
    // Each page attempt has its own durable feature-budget reservation; retry
    // on the next poll rather than hiding retries inside one reservation.
    const history=new modules.HistorySource(c.core,{request:(url,init)=>historyHttp.request(url,init,1)});
    copy=new CopyController(c,bot,history,modules.parseLeaderSwap,providers);
    if(leader&&c.core.wsEnabled===true){const tracker=copy;tracker.attachStream(new modules.WalletStream(c.core,leader,hint=>tracker.activity(hint),health=>tracker.health(health)));}
    alerts=new Notifications(ledger,String(c.core.telegramToken??''),String(c.core.telegramChat??''));
    const signals=new modules.Signals(c.core);let shortlist:Candidate[]=[],discovery=false,market=false,reference=false,fxBusy=false,nextDiscovery=0,nextMarket=0,nextReference=0,nextFx=0,cursor=0;
    const run=(work:()=>Promise<void>)=>{const promise=work().catch(error=>{if(!stopping){bot.health.lastError=safeError(error,[c.core.rpc,c.core.apiKey,c.pumpApiKey]);bot.emit('health',bot.health);}}).finally(()=>jobs.delete(promise));jobs.add(promise);};
    timer=setInterval(()=>{
      if(stopping)return;const now=Date.now(),state=ledger.read();feed!.pin(state.positions.map(p=>p.mint));alerts!.tick();
      if(!reference&&now>=nextReference){reference=true;nextReference=now+10000;run(async()=>{try{const ref=await providers.reference();if(!stopping)ledger.transact(s=>{s.reference=ref;});}finally{reference=false;}});}
      if(!fxBusy&&now>=nextFx){fxBusy=true;nextFx=now+3600000;run(async()=>{try{const value=limit(c,'eurUsd')>0?{eurUsd:limit(c,'eurUsd'),fetchedAt:Date.now(),source:'Configured EUR/USD reference'}:await fx.get();if(!stopping)ledger.transact(s=>{s.fx={eurUsd:value.eurUsd,at:value.fetchedAt,source:value.source};});}finally{fxBusy=false;}});}
      if(!discovery&&now>=nextDiscovery){discovery=true;nextDiscovery=now+limit(c,'scanMs');run(async()=>{try{const rows=await api.candidates();if(!stopping){shortlist=rows.filter(t=>t&&typeof t.id==='string').slice(0,limit(c,'candidates'));for(const t of shortlist)signals.observe(t);}}finally{discovery=false;}});}
      if(!market&&shortlist.length&&now>=nextMarket){market=true;nextMarket=now+Math.max(2000,limit(c,'shortlistMs'));run(async()=>{try{
        // Rotate bounded batches so broad discovery cannot be starved by a hot shortlist.
        const batch=shortlist.slice(cursor,cursor+30);cursor=cursor+30>=shortlist.length?0:cursor+30;
        const tokens=await api.tokens(batch.map(t=>t.id),10,true);
        if(stopping)return;
        for(const t of tokens){const signal=signals.observe(t),current=ledger.read();
          if(signal.enter&&current.settings.autoPilot&&current.settings.normalEnabled&&!current.settings.paused&&!current.settings.panic&&!current.orders.some(unresolved)){
            const ref=current.reference;if(!ref||now-ref.at>15000)continue;
            void bot.autoBuy(t.id,{bucket:'normal',strategy:signal.strategy??'momentum',at:Date.now(),expiresAt:Date.now()+15000,maxUnitUsdc:t.usdPrice/ref.usdcUsd*(1+limit(c,'maxJump')/100),sourceSignature:null}).catch(()=>{});
          }
        }
      }finally{market=false;}});}
    },500);
    const port=await server.listen();feed.start();bot.start();copy.start();
    const stop=async()=>{
      if(stopping)return;stopping=true;if(timer)clearInterval(timer);
      await server!.close();await copy!.stop();await bot.stop();await feed!.stop();await alerts!.stop();await Promise.allSettled([...jobs]);ledger.close();
    };
    return {engine:bot,server,port,stop};
  }catch(error){stopping=true;if(timer)clearInterval(timer);await server?.close();await copy?.stop();await engine?.stop();await feed?.stop();await alerts?.stop();await Promise.allSettled([...jobs]);ledger.close();throw error;}
}

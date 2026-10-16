import path from 'node:path';
import {loadCore} from './core.js';
import type {CoreConfig,CoreModules} from './types.js';
import {solToLamports} from './util.js';
export interface BackendConfig {
  core:CoreConfig;stateDir:string;rpcCreditsPerDay:number;rpcExitReserve:number;
  pumpEnabled:boolean;pumpApiKey:string;allowMeteredPump:boolean;pumpEventsPerDay:number;pumpMaxWatched:number;
  dexRefreshMs:number;maxFeedTokens:number;rugRequestsPerDay:number;safetyTtlMs:number;minLpLockedPct:number;
  liveBase:'SOL'|'USDC';maxBuyLamports:bigint;
  executionTransport:'jupiter'|'jito'|'rpc';jitoOrigin:string;jitoMaxTip:number;
  walletVault:string;walletEncryptionKey:string;host:string;port:number;appAccessToken:string;
}
export async function loadConfig(env:Record<string,string|undefined>=process.env,modules?:CoreModules):Promise<BackendConfig>{
  const bool=(key:string,fallback:boolean)=>{const value=env[key];if(value===undefined||value==='')return fallback;if(!['true','false'].includes(value))throw Error(key+' must be true or false');return value==='true';};
  const num=(key:string,fallback:number,min:number,max:number)=>{const n=env[key]===undefined||env[key]===''?fallback:Number(env[key]);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid '+key);return n;};
  const core=(modules??await loadCore()).config({...env,PAPER_BASE:env.PAPER_BASE||'SOL',DATA_DIR:env.BOT_DATA_DIR||env.DATA_DIR||'./data-v4',COPY_COMMITMENT:env.COPY_COMMITMENT||'finalized'});
  const liveBase=env.LIVE_BASE||'SOL';if(!['SOL','USDC'].includes(liveBase))throw Error('Invalid LIVE_BASE');
  const transport=env.EXECUTION_TRANSPORT||(liveBase==='SOL'?'jito':'jupiter');if(!['jupiter','jito','rpc'].includes(transport))throw Error('Invalid EXECUTION_TRANSPORT');
  if(liveBase==='SOL'&&transport==='jupiter')throw Error('SOL build transactions require jito or rpc transport, not Jupiter execute');
  if(liveBase==='USDC'&&transport==='rpc')throw Error('The inherited USDC route supports Jupiter execute or Jito transport');
  const maxBuyLamports=solToLamports(env.MAX_BUY_SOL||'0.1');
  if(maxBuyLamports<1000000n||maxBuyLamports>1000000000n)throw Error('MAX_BUY_SOL must be between 0.001 and 1 SOL');
  const jito=new URL(env.JITO_ORIGIN||'https://dublin.mainnet.block-engine.jito.wtf');
  const allowed=new Set(['mainnet.block-engine.jito.wtf','dublin.mainnet.block-engine.jito.wtf','london.mainnet.block-engine.jito.wtf','amsterdam.mainnet.block-engine.jito.wtf','frankfurt.mainnet.block-engine.jito.wtf']);
  if(jito.protocol!=='https:'||!allowed.has(jito.hostname)||jito.port||jito.username||jito.password||jito.search||jito.hash||jito.pathname!=='/')throw Error('Unsupported JITO_ORIGIN');
  const stateDir=path.resolve(env.APP_STATE_DIR||'./state');
  const rpcCreditsPerDay=num('RPC_CREDIT_BUDGET_PER_DAY',25000,100,100000),rpcExitReserve=num('RPC_EXIT_RESERVE_CREDITS',1000,10,10000);
  if(rpcExitReserve>=rpcCreditsPerDay)throw Error('RPC exit reserve must be below the daily limit');
  return{core,stateDir,rpcCreditsPerDay,rpcExitReserve,pumpEnabled:bool('PUMP_STREAM_ENABLED',true),pumpApiKey:env.PUMPPORTAL_API_KEY||'',
    allowMeteredPump:bool('ALLOW_METERED_PUMP_DATA',false),pumpEventsPerDay:num('PUMP_MAX_METERED_EVENTS_PER_DAY',1000,10,100000),
    pumpMaxWatched:num('PUMP_MAX_WATCHED_TOKENS',20,1,100),dexRefreshMs:num('DEX_REFRESH_MS',3000,1000,60000),
    maxFeedTokens:num('MAX_FEED_TOKENS',200,30,500),rugRequestsPerDay:num('RUGCHECK_REQUESTS_PER_DAY',500,10,10000),
    safetyTtlMs:num('SAFETY_CACHE_MS',60000,10000,600000),minLpLockedPct:num('MIN_LP_LOCKED_PCT',95,50,100),
    liveBase:liveBase as 'SOL'|'USDC',maxBuyLamports,
    executionTransport:transport as 'jupiter'|'jito'|'rpc',jitoOrigin:jito.origin,jitoMaxTip:num('JITO_TIP_CAP_LAMPORTS',1000,1000,50000),
    walletVault:path.resolve(env.WALLET_VAULT_FILE||'./wallet.vault.json'),walletEncryptionKey:env.WALLET_ENCRYPTION_KEY||'',
    host:env.APP_HOST||'127.0.0.1',port:num('APP_PORT',8787,1024,65535),appAccessToken:env.APP_ACCESS_TOKEN||''};
}

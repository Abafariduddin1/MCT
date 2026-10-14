import type {Connection,Keypair} from '@solana/web3.js';

export type Mode='paper'|'live';
export type RiskStatus='eligible'|'risky'|'unknown';
export interface Check {key:'mintAuthority'|'freezeAuthority'|'top10'|'liquidity'|'age'|'lpLocked'|'rugcheck'|'tokenProgram';status:'pass'|'fail'|'unknown';detail:string}
export interface SafetyReport {
  mint:string;isSafe:boolean;status:RiskStatus;riskReason:string;checkedAt:number;expiresAt:number;
  checks:Check[];top10Pct:number|null;lpLockedPct:number|null;rugScore:number|null;
}
export interface MarketPoint {at:number;mcapUsd:number}
export interface MarketToken {
  mint:string;name:string;symbol:string;imageUri:string|null;mcapUsd:number|null;fdvUsd:number|null;
  change5mPct:number|null;liquidityUsd:number|null;volume5mUsd:number|null;createdAt:number|null;
  observedAt:number;source:'dexscreener'|'pumpportal';estimated:boolean;
}
export interface FeedToken extends MarketToken {
  bondingPct:number|null;migrated:boolean;isSafe:boolean;riskStatus:RiskStatus;riskReason:string;
  sparkline:number[];points:MarketPoint[];safety:SafetyReport|null;metadataAt:number|null;
}
export interface PumpEvent {
  kind:'create'|'migration'|'trade';mint:string;signature:string|null;name:string|null;symbol:string|null;
  marketCapSol:number|null;bondingPct:number|null;receivedAt:number;
}
export interface CoreConfig {
  mode:Mode;liveReady:boolean;liveAck:string;rpc:string;apiKey:string;dataDir:string;walletFile:string;
  maxPosition:number;maxExposure:number;priority:number;jitoTip:number;networkCap:number;rentCap:number;
  slippage:number;exitSlippage:number;reserveSol:number;ageHours:number;liquidity:number;topHolders:number;
  impact:number;swapFee:number;exitSwapFee:number;paperBase:'SOL'|'USDC';
  liveCommitment:'confirmed'|'finalized';copyCommitment:'finalized';liveCap:number;
  [name:string]:unknown;
}
export interface PreparedCoreSwap {
  signedTransaction:string;signature:string;requestId:string;lastValidBlockHeight:number;minimum:string;
  nativeAudit?:NativeAudit;
}
export interface NativeAudit {
  base:'SOL';side:'buy'|'sell';mint:string;inputRaw:string;minimumRaw:string;
  tipLamports:number;feeLamports:number;rentDeltaLamports:number;tokenAccounts:string[];
}
export interface CoreChainPort {
  c:CoreConfig;wallet:Keypair|null;connection:Connection;readonly address:string|undefined;
  verifyMint(mint:string,decimals:number):Promise<void>;
  balances():Promise<{native:number;usdc:number;tokens:Record<string,bigint>}>;
  prepare(quote:unknown,side:'buy'|'sell',mint:string,amount:bigint):Promise<PreparedCoreSwap>;
  settlement(intent:Record<string,unknown>,commitment?:'confirmed'|'finalized'):Promise<Record<string,unknown>>;
}
export interface CoreModules {
  config(env:Record<string,string|undefined>):CoreConfig;
  Chain:new(c:CoreConfig,connection?:Connection)=>CoreChainPort;
  validateQuote(q:unknown,input:string,output:string,amount:bigint,c:CoreConfig,live:boolean):void;
  verifyRouteInstruction(data:Uint8Array,amount:bigint,minimum:bigint,slippageCap:number):void;
}
export interface SwapIntent {side:'buy'|'sell';mint:string;decimals:number;amountRaw:string;quote:unknown;expiresAt:number|null}
export interface PortfolioGate {
  assertAllowed(intent:SwapIntent):Promise<void>;
  assertPersisted(signature:string):Promise<void>;
}
export interface ValidatedSwap {
  readonly signature:string;readonly requestId:string;readonly lastValidBlockHeight:number;
  readonly minimum:string;readonly mint:string;readonly side:'buy'|'sell';readonly preparedAt:number;
  readonly base:'SOL'|'USDC';
}
export type FetchLike=typeof fetch;

import type {Mode, NativeAudit, SwapIntent, ValidatedSwap, SafetyReport, MarketToken} from './types.js';
import type {SolReference} from './priceReference.js';

export type Bucket = 'normal' | 'copy';
export type Preset = 'Safe' | 'Fast' | 'Degen';
export type OrderStage = 'received' | 'preparing' | 'prepared' | 'submitted' | 'unknown' | 'confirmed' | 'finalized' | 'failed' | 'rejected';
export interface Protection {stop:number; take:number; trailStart:number; trail:number; holdMs:number; partialBps:number}
export interface Position {
  id:string; mint:string; symbol:string; decimals:number; bucket:Bucket; strategy:string;
  quantityRaw:string; costLamports:string; openedAt:number; entrySignature:string|null;
  markLamports:string|null; markAt:number|null; peakLamports:string; quoteFailures:number;
  protection:Protection; partialTaken:boolean; queuedSellRaw:string; exitReason:string|null;
  entryReference:SolReference; entryMcapUsd:number|null;
  entryFx:{eurUsd:number;at:number;source:string}|null;
}
export interface RiskAccount {dayStartLamports:string; highWaterLamports:string; entries:number; halt:string|null}
export interface Allocation extends RiskAccount {pct:number; cashLamports:string}
export interface ControllerSettings {
  autoPilot:boolean; normalEnabled:boolean; copyEnabled:boolean; preset:Preset;
  orderLamports:string; panic:boolean; paused:boolean;
}
export type Command =
  | {id:string; type:'QUICK_TRADE'; side:'buy'; mint:string; amountSol:string}
  | {id:string; type:'QUICK_TRADE'; side:'sell'; mint:string; percentBps:number}
  | {id:string; type:'SET_BOT_PRESET'; preset:Preset; autoPilot:boolean; normalEnabled:boolean; copyEnabled:boolean; amountSol:string}
  | {id:string; type:'SET_ALLOCATIONS'; normalPct:number; copyPct:number; reservePct:number}
  | {id:string; type:'PANIC_CASH_OUT_ALL'}
  | {id:string; type:'PAUSE_ENTRIES'; paused:boolean};
export interface CommandRecord {id:string; hash:string; type:Command['type']; at:number; stage:OrderStage|'accepted'; reason:string|null; orderId:string|null}
export interface Signal {strategy:string; bucket:Bucket; expiresAt:number; at:number; maxUnitUsdc:number|null; sourceSignature:string|null}
export interface Candidate {
  id:string; symbol:string; decimals:number; tokenProgram:string; isVerified:boolean; firstPool:{createdAt:string};
  liquidity:number; holderCount:number; organicScore:number;
  audit:{mintAuthorityDisabled:boolean; freezeAuthorityDisabled:boolean; topHoldersPercentage:number};
  usdPrice:number; priceBlockId:number; stats1h:{buyVolume:number; sellVolume:number}; stats5m:{buyVolume:number; sellVolume:number};
  mcap?:number; [key:string]:unknown;
}
export interface CandidateEvidence {token:Candidate; safety:SafetyReport; market:MarketToken; at:number; slot:number}
export interface Quote {
  inputMint:string; outputMint:string; inAmount:string; outAmount:string; otherAmountThreshold:string;
  receivedAt:number; priceImpact:number; [key:string]:unknown;
}
export interface Order {
  id:string; commandId:string|null; side:'buy'|'sell'; mint:string; symbol:string; decimals:number; bucket:Bucket;
  amountRaw:string; stage:OrderStage; createdAt:number; updatedAt:number; reason:string|null;
  strategy:string; signal:Signal|null; protection:Protection; partialProfit:boolean;
  reserveLamports:string; reference:SolReference; entryMcapUsd:number|null;
  fx:{eurUsd:number;at:number;source:string}|null;
  signature:string|null; nativeAudit:NativeAudit|null; lastValidBlockHeight:number|null;
  applied:boolean; receipt:Settlement|null; preparationMs:number|null; transportMs:number|null; fillMs:number|null;
}
export type Settlement = {kind:'pending'} | {
  kind:'success'; base:'SOL'; baseDelta:string; tokenDelta:string; nativeSpent:number;
  feeLamports:number; tipLamports:number; rentDeltaLamports:number; confirmation:'confirmed'|'finalized';
} | {kind:'failed'; nativeSpent:number; feeLamports:number; confirmation:'confirmed'|'finalized'};
export interface CopyEvent {side:'buy'|'sell'; mint:string; decimals:number; baseMint:string; leaderBefore:string; baseAmount:string; tokenAmount:string; at:number}
export interface CopyState {
  leader:string|null; baselineSlot:number|null; nextSlot:number|null;
  scan:{fromSlot:number; toSlot:number; token:string|null; at:number}|null;
  claims:Record<string,number>; queuedSales:Record<string,Array<{event:CopyEvent; signature:string}>>;
  blocked:string|null; lastPollAt:number|null; lastSignalAt:number|null; creditDay:string; credits:number;
  streamReady:boolean; streamGapAt:number|null; streamUsage:{day:string; bytes:number; connections:number};
}
export interface DurableEvent {seq:number; at:number; type:string; data:Record<string,unknown>}
export interface LedgerState {
  version:1; mode:Mode; base:'SOL'; wallet:string; timezone:string; createdAt:number; updatedAt:number; seq:number;
  initialCashLamports:string; fundingLamports:string; cashLamports:string; realizedLamports:string;
  feesLamports:string; rentLamports:string; day:string; risk:RiskAccount;
  buckets:{normal:Allocation; copy:Allocation; reserve:Allocation};
  settings:ControllerSettings; positions:Position[]; orders:Order[]; commands:CommandRecord[];
  cooldowns:Record<string,number>; paperTokenAccounts:string[]; copy:CopyState;
  reference:SolReference|null; initialReference:SolReference; fx:{eurUsd:number; at:number; source:string}|null;
  events:DurableEvent[]; notificationCursor:number;
}
export interface RuntimePort {
  reference():Promise<SolReference>;
  candidate(mint:string):Promise<CandidateEvidence>;
  quote(side:'buy'|'sell',mint:string,amountRaw:string,fast?:boolean):Promise<Quote>;
  checkWallet(state:LedgerState):Promise<void>;
  prepare(intent:SwapIntent):Promise<ValidatedSwap>;
  audit(swap:ValidatedSwap):NativeAudit;
  send(swap:ValidatedSwap):Promise<{transportLatencyMs:number}>;
  settlement(order:Order,commitment:'confirmed'|'finalized'):Promise<Settlement>;
}

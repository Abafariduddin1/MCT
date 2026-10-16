import type {CoreConfig} from './types.js';
import type {Candidate,CopyEvent,Quote} from './controllerTypes.js';
export interface HttpPort {request(url:string,options?:RequestInit,attempts?:number,schedule?:{priority?:number}):Promise<unknown>}
export interface ApiPort {
  tokens(mints:string[],priority?:number,fresh?:boolean,signal?:AbortSignal):Promise<Candidate[]>;
  candidates(signal?:AbortSignal):Promise<Candidate[]>;
  quote(input:string,output:string,amount:bigint,taker?:string,context?:{side:'buy'|'sell'}):Promise<Quote>;
}
export interface HistoryTransaction {slot:number;transactionIndex?:number;transaction:{signatures:string[]};[key:string]:unknown}
export interface HistoryPort {slot():Promise<number>;page(leader:string,from:number,to:number,token?:string|null):Promise<{data:HistoryTransaction[];paginationToken?:string|null}>}
export interface StreamHealth {ready:boolean;connected:boolean;error:string|null;lastSlotAt?:number;bytes?:number;estimatedCredits?:number}
export interface StreamPort {start():void;stop():void;usage:{day:string;bytes:number;connections:number};health:StreamHealth}
export interface StrategySignal {enter:boolean;strategy?:string;reason:string;momentum?:number}
export interface SignalPort {observe(token:Candidate,now?:number):StrategySignal}
export interface FxPort {get(signal?:AbortSignal):Promise<{eurUsd:number;date:string;source:string;fetchedAt:number}>}
export interface ControllerCore {
  Jupiter:new(c:CoreConfig,http:HttpPort)=>ApiPort;
  Signals:new(c:CoreConfig)=>SignalPort;
  screen(token:Candidate,c:CoreConfig,now:number,slot:number):string|null;
  HistorySource:new(c:CoreConfig,http:HttpPort)=>HistoryPort;
  parseLeaderSwap(tx:HistoryTransaction,leader:string):CopyEvent|null;
  WalletStream:new(c:CoreConfig,leader:string,onActivity:(hint:{slot:number;detectedAt:number})=>void,onHealth:(health:StreamHealth)=>void)=>StreamPort;
  FxReference:new()=>FxPort;
}
export async function loadControllerCore():Promise<ControllerCore>{
  const root=new URL('../../core/src/',import.meta.url);
  const [api,risk,history,copy,stream,fx]=await Promise.all(['api.mjs','risk.mjs','history.mjs','copy.mjs','stream.mjs','reference.mjs'].map(name=>import(new URL(name,root).href))) as [Pick<ControllerCore,'Jupiter'>,Pick<ControllerCore,'Signals'|'screen'>,Pick<ControllerCore,'HistorySource'>,Pick<ControllerCore,'parseLeaderSwap'>,Pick<ControllerCore,'WalletStream'>,Pick<ControllerCore,'FxReference'>];
  return {...api,...risk,...history,...copy,...stream,...fx};
}

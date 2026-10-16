import {createHash} from 'node:crypto';
import {mintAddress,object,solToLamports} from './util.js';
import type {Command} from './controllerTypes.js';

export const PROTOCOL_VERSION=1;
export function parseCommand(value:unknown):Command {
  const row=object(value);
  if(row.v!==1||typeof row.id!=='string'||! /^[A-Za-z0-9_-]{16,80}$/.test(row.id))throw Error('Expected protocol v1 and a unique 16–80 character command id');
  const fields:Record<string,string[]>={QUICK_TRADE:['side','mint',row.side==='buy'?'amountSol':'percentBps'],SET_BOT_PRESET:['preset','autoPilot','normalEnabled','copyEnabled','amountSol'],SET_ALLOCATIONS:['normalPct','copyPct','reservePct'],PANIC_CASH_OUT_ALL:[],PAUSE_ENTRIES:['paused']};
  if(typeof row.type!=='string'||!Object.hasOwn(fields,row.type))throw Error('Unknown command');
  const keys=['v','id','type',...fields[row.type]!];
  if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key)))throw Error('Unexpected or missing command fields');
  for(const key of ['paused','autoPilot','normalEnabled','copyEnabled'])if(key in row&&typeof row[key]!=='boolean')throw Error('Invalid boolean');
  if('amountSol'in row&&(typeof row.amountSol!=='string'||solToLamports(row.amountSol)<=0n))throw Error('Expected a positive decimal SOL string');
  if(row.type==='QUICK_TRADE'){
    mintAddress(row.mint);if(!['buy','sell'].includes(String(row.side)))throw Error('Unknown trade side');
    if(row.side==='sell'&&(!Number.isInteger(row.percentBps)||Number(row.percentBps)<1||Number(row.percentBps)>10000))throw Error('Sale percentBps must be 1–10000');
  }
  if(row.type==='SET_BOT_PRESET'&&!['Safe','Fast','Degen'].includes(String(row.preset)))throw Error('Unknown preset');
  if(row.type==='SET_ALLOCATIONS'){
    for(const key of ['normalPct','copyPct','reservePct'])if(!Number.isInteger(row[key])||Number(row[key])<0||Number(row[key])>100)throw Error('Allocation percentages must be integers');
    if(Number(row.normalPct)+Number(row.copyPct)+Number(row.reservePct)!==100)throw Error('Allocation percentages must sum to 100');
  }
  const {v:_,...command}=row;return command as unknown as Command;
}
export function commandHash(command:Command):string {
  const sorted=Object.fromEntries(Object.entries(command).sort(([a],[b])=>a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

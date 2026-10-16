import { createHash } from 'node:crypto';
import bs58 from 'bs58';
export const JUPITER_PROGRAM='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const PUMPSWAP_PROGRAM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const anchorDiscriminator=name=>createHash('sha256').update(`global:${name}`).digest().subarray(0,8);
const anchorVenues=new Map([
  [JUPITER_PROGRAM,['route','route_with_token_ledger','shared_accounts_route','shared_accounts_route_with_token_ledger','exact_out_route','shared_accounts_exact_out_route']],
  [PUMPSWAP_PROGRAM,['buy','sell','buy_exact_quote_in']],
  ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',['swap_base_input','swap_base_output']],
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',['swap','swap_v2']],
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',['swap','swap_v2','two_hop_swap','two_hop_swap_v2']],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',['swap','swap2','swap_exact_out','swap_exact_out2','swap_with_price_impact','swap_with_price_impact2']]
]);
export function isSwapInstruction(ix) {
  const program=typeof ix.programId==='string'?ix.programId:ix.programId?.toBase58?.();
  let data;
  try{data=typeof ix.data==='string'?Buffer.from(bs58.decode(ix.data)):null;}catch{return false;}
  if(!data)return false;
  const names=anchorVenues.get(program);
  if(names)return names.some(name=>data.length>=8&&data.subarray(0,8).equals(anchorDiscriminator(name)));
  return program==='675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' && [9,11].includes(data[0]);
}

import {JsonHttp} from './http.js';
import {object,positive} from './util.js';
import {SOL,USDC} from './constants.js';

export interface SolReference {
  solUsd:number;usdcUsd:number;solUsdc:number;slot:number;at:number;
}

export class PriceReference {
  private cached:SolReference|null=null;
  private pending:Promise<SolReference>|null=null;
  constructor(
    private apiKey:string,
    private currentSlot:()=>Promise<number>,
    private http=new JsonHttp(fetch,1100),
    private ttlMs=10000
  ) {}

  peek():SolReference|null {
    return this.cached&&Date.now()-this.cached.at<=this.ttlMs?{...this.cached}:null;
  }

  async get():Promise<SolReference> {
    const cached=this.peek();if(cached)return cached;
    if(this.pending)return this.pending;
    this.pending=this.refresh().finally(()=>{this.pending=null;});
    return this.pending;
  }

  private async refresh():Promise<SolReference> {
    if(!this.apiKey)throw Error('JUPITER_API_KEY is required for a verified SOL reference');
    const response=object(await this.http.request('https://api.jup.ag/price/v3?ids='+SOL+','+USDC,
      {headers:{'x-api-key':this.apiKey}},2));
    const sol=object(response[SOL]),usdc=object(response[USDC]);
    const solUsd=positive(sol.usdPrice),usdcUsd=positive(usdc.usdPrice);
    const slot=await this.currentSlot();
    if(!Number.isSafeInteger(slot)||slot<=0)throw Error('Current Solana slot unavailable');
    for(const [row,decimals] of [[sol,9],[usdc,6]] as const) {
      if(row.decimals!==decimals||!Number.isSafeInteger(row.blockId)||Number(row.blockId)>slot+5||slot-Number(row.blockId)>300)
        throw Error('SOL/USDC price reference is stale or inconsistent with the chain');
    }
    if(solUsd===null||solUsd>1000000||usdcUsd===null||usdcUsd<0.97||usdcUsd>1.03)
      throw Error('SOL/USDC price reference is invalid or USDC is outside the accepted peg range');
    this.cached={solUsd,usdcUsd,solUsdc:solUsd/usdcUsd,slot,at:Date.now()};
    return {...this.cached};
  }
}

export function solCostMicroUsdc(lamports:bigint,reference:SolReference):bigint {
  if(lamports<0n||Date.now()-reference.at>15000||reference.at>Date.now()+1000||!Number.isFinite(reference.solUsdc)||reference.solUsdc<=0)
    throw Error('A fresh server price reference is required for SOL sizing');
  const scaled=BigInt(Math.ceil(reference.solUsdc*1000000000));
  return (lamports*scaled+999999999999n)/1000000000000n;
}

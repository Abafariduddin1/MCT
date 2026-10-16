import {JsonHttp} from './http.js';
import {finite,imageUri,label,mintAddress,object,positive} from './util.js';
import type {MarketToken} from './types.js';
export function parseDexPairs(value:unknown,requested:Set<string>,at=Date.now()):MarketToken[]{
  if(!Array.isArray(value)||value.length>1000)throw Error('Invalid DexScreener pair response');
  const best=new Map<string,MarketToken>();
  for(const input of value){
    try{
      const p=object(input);if(p.chainId!=='solana')continue;
      const base=object(p.baseToken),mint=mintAddress(base.address);if(!requested.has(mint))continue;
      const liquidity=object(p.liquidity??{}),change=object(p.priceChange??{}),volume=object(p.volume??{}),info=object(p.info??{});
      const row:MarketToken={mint,name:label(base.name,mint.slice(0,6)),symbol:label(base.symbol,'?',16),imageUri:imageUri(info.imageUrl),
        mcapUsd:positive(p.marketCap),fdvUsd:positive(p.fdv),change5mPct:finite(change.m5),liquidityUsd:finite(liquidity.usd),
        volume5mUsd:finite(volume.m5),createdAt:positive(p.pairCreatedAt),observedAt:at,source:'dexscreener',estimated:false};
      const old=best.get(mint);if(!old||(row.liquidityUsd??-1)>(old.liquidityUsd??-1))best.set(mint,row);
    }catch{continue;}
  }return[...best.values()];
}
export class DexScreener {
  private cache=new Map<string,MarketToken>();
  constructor(private http=new JsonHttp(fetch,1200),private ttlMs=2500){}
  async tokens(mints:string[],signal?:AbortSignal):Promise<MarketToken[]>{
    const unique=[...new Set(mints.map(mintAddress))];if(unique.length>500)throw Error('Too many requested tokens');
    const missing=unique.filter(mint=>{const row=this.cache.get(mint);return!row||Date.now()-row.observedAt>this.ttlMs;});
    for(let i=0;i<missing.length;i+=30){
      const group=missing.slice(i,i+30);
      const data=await this.http.request('https://api.dexscreener.com/tokens/v1/solana/'+group.join(','),signal?{signal}:{},2);
      for(const row of parseDexPairs(data,new Set(group)))this.cache.set(row.mint,row);
    }
    for(const [mint,row]of this.cache)if(Date.now()-row.observedAt>300000)this.cache.delete(mint);
    return unique.map(mint=>this.cache.get(mint)).filter((row):row is MarketToken=>Boolean(row)&&Date.now()-row!.observedAt<300000);
  }
  async trending(signal?:AbortSignal):Promise<string[]>{
    const data=await this.http.request('https://api.dexscreener.com/token-boosts/top/v1',signal?{signal}:{},2);
    if(!Array.isArray(data))throw Error('Invalid token boost response');
    const mints:string[]=[];for(const input of data.slice(0,100)){try{const row=object(input);if(row.chainId==='solana')mints.push(mintAddress(row.tokenAddress));}catch{}}
    // Paid boosts are discovery hints, never safety or executable buy signals.
    return[...new Set(mints)].slice(0,60);
  }
}

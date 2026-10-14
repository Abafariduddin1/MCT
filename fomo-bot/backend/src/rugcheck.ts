import path from 'node:path';
import {JsonHttp} from './http.js';
import {QuotaTracker} from './quota.js';
import {finite,mintAddress,object,safeError} from './util.js';
import type {BackendConfig} from './config.js';
import type {Check,MarketToken,SafetyReport} from './types.js';
import type {SolanaService} from './solana.js';
export interface RugSummary {score:number|null;lpLockedPct:number|null;risks:Array<{name:string;level:string}>;observedAt:number}
export function parseRugSummary(value:unknown):RugSummary{
  const data=object(value);if(data.error)throw Error('RugCheck has no usable report');
  if(!Array.isArray(data.risks))throw Error('RugCheck risk list unavailable');
  const score=finite(data.score_normalised),locked=finite(data.lpLockedPct);
  if(score!==null&&(score<0||score>100))throw Error('Invalid RugCheck score');
  if(locked!==null&&(locked<0||locked>100))throw Error('Invalid LP lock percentage');
  const risks=data.risks.map(input=>{const r=object(input);if(typeof r.name!=='string'||typeof r.level!=='string')throw Error('Malformed RugCheck risk');return{name:r.name.slice(0,100),level:r.level.toLowerCase()};});
  return{score,lpLockedPct:locked,risks,observedAt:Date.now()};
}
export class RugCheckClient {
  private cache=new Map<string,RugSummary>();readonly quota:QuotaTracker;
  constructor(c:BackendConfig,private http=new JsonHttp(fetch,1200)){
    this.quota=new QuotaTracker(path.join(c.stateDir,'rugcheck-quota.json'),c.rugRequestsPerDay);
  }
  async summary(mint:string):Promise<RugSummary>{
    mint=mintAddress(mint);const cached=this.cache.get(mint);if(cached&&Date.now()-cached.observedAt<60000)return cached;
    this.quota.consume(1);
    const report=parseRugSummary(await this.http.request('https://api.rugcheck.xyz/v1/tokens/'+mint+'/report/summary',{},1));
    this.cache.set(mint,report);if(this.cache.size>500)this.cache.delete(this.cache.keys().next().value!);return report;
  }
}
export class SafetyAggregator {
  private cache=new Map<string,SafetyReport>();
  constructor(private c:BackendConfig,private solana:Pick<SolanaService,'inspectMint'|'top10AccountPct'>,private rug:Pick<RugCheckClient,'summary'>){}
  async inspect(mint:string,market:MarketToken|null):Promise<SafetyReport>{
    mint=mintAddress(mint);const cached=this.cache.get(mint);
    if(!market||market.mint!==mint||Date.now()-market.observedAt>15000||market.observedAt>Date.now()+1000)market=null;
    if(cached&&Date.now()<cached.expiresAt&&market?.createdAt&&Date.now()-market.createdAt>=this.c.core.ageHours*3600000
      &&market.liquidityUsd!==null&&market.liquidityUsd>=this.c.core.liquidity
      &&cached.checks.filter(check=>['age','liquidity'].includes(check.key)).every(check=>check.status==='pass'))return cached;
    const checks:Check[]=[];let top10:number|null=null,rugScore:number|null=null,locked:number|null=null;
    const append=(key:Check['key'],status:Check['status'],detail:string)=>checks.push({key,status,detail});
    const age=market?.createdAt?Date.now()-market.createdAt:null,liquidity=market?.liquidityUsd??null;
    append('age',age===null?'unknown':age>=this.c.core.ageHours*3600000?'pass':'fail',age===null?'Pool age unavailable':age>=this.c.core.ageHours*3600000?'Pool age meets the trading policy':'Pool is younger than the trading policy');
    append('liquidity',liquidity===null?'unknown':liquidity>=this.c.core.liquidity?'pass':'fail',liquidity===null?'Liquidity unavailable':liquidity>=this.c.core.liquidity?'Liquidity meets the minimum':'Liquidity below the minimum');
    // An unevaluated new launch never receives a green badge; avoid spending
    // RPC/report quota on every launch that already fails the trading policy.
    if(checks.some(check=>check.status!=='pass')){
      for(const key of ['mintAuthority','freezeAuthority','top10','lpLocked','rugcheck','tokenProgram'] as const)append(key,'unknown','Not evaluated for this ineligible discovery token');
    }else{
      try{
        const facts=await this.solana.inspectMint(mint);
        append('tokenProgram',facts.classic&&facts.initialized&&facts.supply>0n?'pass':'fail','Only initialized classic SPL mints are supported');
        append('mintAuthority',facts.mintAuthorityRevoked?'pass':'fail',facts.mintAuthorityRevoked?'Mint authority revoked':'Mint authority enabled or unverifiable');
        append('freezeAuthority',facts.freezeAuthorityRevoked?'pass':'fail',facts.freezeAuthorityRevoked?'Freeze authority revoked':'Freeze authority enabled or unverifiable');
        if(facts.classic&&facts.initialized){top10=await this.solana.top10AccountPct(mint,facts.supply);}
        append('top10',top10===null?'unknown':top10<=this.c.core.topHolders?'pass':'fail',top10===null?'Top account concentration unavailable':`Top ten token accounts hold ${top10.toFixed(2)}%; this is not beneficial-owner attribution`);
      }catch(error){for(const key of ['tokenProgram','mintAuthority','freezeAuthority','top10'] as const)if(!checks.some(check=>check.key===key))append(key,'unknown',safeError(error));}
      try{
        const report=await this.rug.summary(mint);rugScore=report.score;locked=report.lpLockedPct;
        const adverse=report.risks.find(r=>!['info','information','low'].includes(r.level));
        append('rugcheck',rugScore===null?'unknown':adverse||rugScore>25?'fail':'pass',adverse?adverse.name:rugScore===null?'RugCheck score unavailable':'No high risk reported; provider checks are incomplete protections');
        append('lpLocked',locked===null?'unknown':locked>=this.c.minLpLockedPct?'pass':'fail',locked===null?'LP lock not verified':`Provider reports ${locked.toFixed(1)}% LP locked; lock percentage does not guarantee exit liquidity`);
      }catch(error){append('rugcheck','unknown',safeError(error));append('lpLocked','unknown','LP lock not verified');}
    }
    const failed=checks.find(check=>check.status==='fail'),unknown=checks.find(check=>check.status==='unknown');
    const report:SafetyReport={mint,isSafe:!failed&&!unknown,status:failed?'risky':unknown?'unknown':'eligible',riskReason:failed?.detail??unknown?.detail??'Checks passed; trading-policy checks still apply',
      checkedAt:Date.now(),expiresAt:Date.now()+this.c.safetyTtlMs,checks,top10Pct:top10,lpLockedPct:locked,rugScore};
    this.cache.set(mint,report);if(this.cache.size>500)this.cache.delete(this.cache.keys().next().value!);return report;
  }
}

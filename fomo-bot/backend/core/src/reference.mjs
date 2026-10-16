export class FxReference {
  constructor(fetcher=fetch){this.fetcher=fetcher;this.value=null;}
  async get(signal){
    if(this.value&&Date.now()-this.value.fetchedAt<3600000)return this.value;
    const response=await this.fetcher('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('ECB EUR/USD reference unavailable');
    const xml=await response.text(),date=xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
    const rate=Number(xml.match(/currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/)?.[1]);
    if(!date||!Number.isFinite(rate)||rate<0.5||rate>2||Date.now()-Date.parse(date)>7*86400000||Date.parse(date)>Date.now()+86400000)
      throw new Error('Invalid or stale ECB EUR/USD reference');
    this.value={eurUsd:rate,date,source:'ECB daily reference (not an executable conversion quote)',fetchedAt:Date.now()};return this.value;
  }
}

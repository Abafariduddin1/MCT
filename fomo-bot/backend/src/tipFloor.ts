import {JsonHttp} from './http.js';
import {object,positive} from './util.js';

export class TipFloor {
  private cached:{value:number|null;at:number}|null=null;
  private pending:Promise<number|null>|null=null;
  constructor(private http=new JsonHttp(fetch,1100)) {}

  async get():Promise<number|null> {
    if(this.cached&&Date.now()-this.cached.at<10000)return this.cached.value;
    if(this.pending)return this.pending;
    this.pending=this.refresh().finally(()=>{this.pending=null;});return this.pending;
  }

  private async refresh():Promise<number|null> {
    let value:number|null=null;
    try {
      const rows=await this.http.request('https://bundles.jito.wtf/api/v1/bundles/tip_floor',{},1);
      if(Array.isArray(rows)&&rows.length>0&&rows.length<=10) {
        const row=object(rows[0]),at=typeof row.time==='string'?Date.parse(row.time):NaN;
        if(Number.isFinite(at)&&Date.now()-at<=30000&&at<=Date.now()+1000)
          value=positive(row.landed_tips_50th_percentile);
      }
    } catch { /* The configured minimum remains capped when this optional source is unavailable. */ }
    this.cached={value,at:Date.now()};return value;
  }
}

import type {Ledger} from './ledger.js';
import type {FetchLike} from './types.js';

/** Optional delivery is outside the financial critical path. A crash can repeat
 * an alert, never the trade. Only durable fill/failure events are sent. */
export class Notifications {
  private busy:Promise<void>|null=null;private next=0;private retries=0;
  constructor(private ledger:Ledger,private token:string,private chat:string,private fetcher:FetchLike=fetch){
    if(Boolean(token)!==Boolean(chat))throw Error('Both Telegram token and chat id are required');
    if(token&&(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)||! /^-?\d{1,20}$/.test(chat)))throw Error('Invalid Telegram destination settings');
  }
  tick():void{if(!this.token||this.busy||Date.now()<this.next)return;this.busy=this.flush().finally(()=>{this.busy=null;});}
  async stop():Promise<void>{await this.busy;}
  private async flush():Promise<void>{
    const s=this.ledger.read(),row=s.events.find(e=>e.seq>s.notificationCursor&&['TRADE_FILLED','TRADE_FAILED'].includes(e.type));if(!row)return;
    this.next=Date.now()+5000;
    try{
      const text=`${s.mode.toUpperCase()} ${row.type==='TRADE_FILLED'?'fill':'failed transaction'}: ${String(row.data.side)} ${String(row.data.mint)} (${String(row.data.confirmation)}). Order ${String(row.data.orderId)}`;
      const response=await this.fetcher('https://api.telegram.org/bot'+this.token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:this.chat,text}),redirect:'error',signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw Error('Notification rejected');const body=await response.json() as {ok?:boolean};if(body.ok!==true)throw Error('Notification not acknowledged');
      this.ledger.transact(next=>{next.notificationCursor=row.seq;});this.retries=0;
    }catch{this.retries++;this.next=Date.now()+Math.min(300000,5000*2**Math.min(this.retries,6));}
  }
}

import type {FetchLike} from './types.js';
import {wait} from './util.js';
export class JsonHttp {
  private next=0;private running=false;private serial=0;private backgroundBurst=0;
  private queue:Array<{url:string;init:RequestInit;attempts:number;dispatch:(()=>Promise<void>)|undefined;priority:number;id:number;deadline:number;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}>=[];
  constructor(private fetcher:FetchLike=fetch,private intervalMs=1050,private maxBytes=2000000){}
  request(url:string,init:RequestInit={},attempts=2,dispatch?:()=>Promise<void>,schedule:{priority?:number;maxQueueMs?:number}={}):Promise<unknown>{
    if(this.queue.length>=128)return Promise.reject(Error('Provider request queue full'));
    return new Promise((resolve,reject)=>{this.queue.push({url,init,attempts,dispatch,priority:schedule.priority??10,id:this.serial++,deadline:Date.now()+(schedule.maxQueueMs??30000),resolve,reject});void this.drain();});
  }
  private async drain():Promise<void>{
    if(this.running)return;this.running=true;
    try{while(this.queue.length){
      // Select after the rate wait so an exit can overtake queued discovery.
      await wait(Math.max(0,this.next-Date.now()));this.queue.sort((a,b)=>a.priority-b.priority||a.id-b.id);
      let index=0;
      if(this.queue[0]!.priority>=10&&this.backgroundBurst>=2){index=this.queue.reduce((oldest,row,i)=>row.id<this.queue[oldest]!.id?i:oldest,0);this.backgroundBurst=0;}
      const task=this.queue.splice(index,1)[0]!;
      if(task.priority>=10)this.backgroundBurst++;
      try{if(Date.now()>task.deadline||task.init.signal?.aborted)throw Error('Queued provider request expired or was cancelled');task.resolve(await this.perform(task.url,task.init,task.attempts,task.dispatch));}catch(error){task.reject(error);}
    }}finally{this.running=false;}
  }
  private async perform(url:string,init:RequestInit,attempts:number,dispatch?:()=>Promise<void>):Promise<unknown>{
    for(let attempt=0;attempt<attempts;attempt++){
      await wait(Math.max(0,this.next-Date.now()),init.signal??undefined);this.next=Date.now()+this.intervalMs;
      await dispatch?.();
      let response:Response;
      try{response=await this.fetcher(url,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});}
      catch{if(attempt+1===attempts||init.signal?.aborted)throw Error('Request failed or timed out');await wait(500*(attempt+1),init.signal??undefined);continue;}
      if(!response.ok){
        await response.body?.cancel();
        if(attempt+1<attempts&&(response.status===429||response.status>=500)){
          const seconds=Number(response.headers.get('retry-after'));this.next=Date.now()+Math.min(30000,Math.max(1000,Number.isFinite(seconds)?seconds*1000:1000));continue;
        }throw Error('Provider returned HTTP '+response.status);
      }
      if(Number(response.headers.get('content-length'))>this.maxBytes)throw Error('Provider response exceeds size limit');
      if(!response.body)throw Error('Empty provider response');
      const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;if(value){size+=value.length;if(size>this.maxBytes)throw Error('Provider response exceeds size limit');parts.push(value);}}}
      catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
      try{return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;}catch{throw Error('Malformed provider JSON');}
    }throw Error('Request failed');
  }
}

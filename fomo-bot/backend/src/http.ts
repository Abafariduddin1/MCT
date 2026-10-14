import type {FetchLike} from './types.js';
import {wait} from './util.js';
export class JsonHttp {
  private tail:Promise<unknown>=Promise.resolve();private next=0;private queued=0;
  constructor(private fetcher:FetchLike=fetch,private intervalMs=1050,private maxBytes=2000000){}
  request(url:string,init:RequestInit={},attempts=2,dispatch?:()=>Promise<void>):Promise<unknown>{
    if(this.queued>=128)return Promise.reject(Error('Provider request queue full'));
    this.queued++;
    const work=this.tail.then(()=>this.perform(url,init,attempts,dispatch)).finally(()=>{this.queued--;});this.tail=work.catch(()=>{});return work;
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

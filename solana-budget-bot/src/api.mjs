import { raw } from './util.mjs';
import { USDC } from './config.mjs';
import {WakeSignal} from './wake.mjs';
function delay(ms,signal){
  if(signal?.aborted)return Promise.reject(new Error('API request cancelled'));
  return new Promise((resolve,reject)=>{
    const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolve();};
    const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(new Error('API request cancelled'));};
    const timer=setTimeout(done,Math.max(0,ms));signal?.addEventListener('abort',cancel,{once:true});
  });
}
export class Http {
  constructor(interval=1050,fetcher=fetch){this.interval=interval;this.fetcher=fetcher;this.next=0;this.queue=[];this.running=false;this.sequence=0;this.backgroundBurst=0;this.rateWake=new WakeSignal();this.metrics={requests:0,retries:0,queueWaitMs:0};}
  request(url,options={},attempts=3,schedule={}){
    if(options.signal?.aborted)return Promise.reject(new Error('API request cancelled'));
    if(this.queue.length>=128)return Promise.reject(new Error('API request queue is full'));
    return new Promise((resolve,reject)=>{
      const task={url,options,attempts,priority:schedule.priority??10,deadline:Date.now()+(schedule.maxQueueMs??30000),enqueued:Date.now(),id:this.sequence++,resolve,reject};
      task.cancel=()=>{const index=this.queue.indexOf(task);if(index>=0)this.queue.splice(index,1);reject(new Error('API request cancelled'));this.rateWake.wake();};
      options.signal?.addEventListener('abort',task.cancel,{once:true});this.queue.push(task);
      this.drain();
    });
  }
  async drain(){
    if(this.running)return;this.running=true;
    try{
      while(this.queue.length){
        // Choose priority after the shared rate-limit wait, so an urgent exit can
        // overtake discovery queued while the API bucket was unavailable.
        while(this.queue.length&&this.next>Date.now())await this.rateWake.wait(this.next-Date.now());
        if(!this.queue.length)break;
        this.queue.sort((a,b)=>a.priority-b.priority||a.id-b.id);
        // Quotes/critical reads always come first. Among background reads,
        // reserve the third turn for the oldest request so fast refreshes
        // cannot consume every available slot and starve discovery forever.
        let index=0,fairTurn=false;
        if(this.queue[0].priority>=10&&this.backgroundBurst>=2){
          index=this.queue.reduce((oldest,row,i)=>row.id<this.queue[oldest].id?i:oldest,0);fairTurn=true;
        }
        const task=this.queue.splice(index,1)[0];
        try{
          if(Date.now()>task.deadline||task.options.signal?.aborted)throw new Error('Queued API request expired or was cancelled');
          if(task.priority>=10)this.backgroundBurst=fairTurn?0:this.backgroundBurst+1;
          this.metrics.queueWaitMs+=Date.now()-task.enqueued;
          task.resolve(await this.perform(task.url,task.options,task.attempts));
        }catch(e){task.reject(e);}finally{task.options.signal?.removeEventListener('abort',task.cancel);}
      }
    }finally{this.running=false;if(this.queue.length)this.drain();}
  }
  async perform(url,options,attempts){
    for(let i=0;i<attempts;i++){
      await delay(Math.max(0,this.next-Date.now()),options.signal);this.next=Date.now()+this.interval;this.metrics.requests++;
      let response;
      try{response=await this.fetcher(url,{...options,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});}
      catch{if(i+1===attempts||options.signal?.aborted)throw new Error(options.signal?.aborted?'API request cancelled':'Network request failed or timed out');this.metrics.retries++;await delay(500*2**i,options.signal);continue;}
      if(response.ok)return response.json();
      if((response.status===429||response.status>=500)&&i+1<attempts){
        const retry=Number(response.headers.get('retry-after'))*1000,reset=Number(response.headers.get('x-ratelimit-reset'))*1000-Date.now();
        this.next=Date.now()+Math.min(60000,Math.max(1000*2**i,retry||0,reset||0));this.metrics.retries++;continue;
      }
      let detail='';try{const body=await response.json(),issues=body.error?.issues;
        detail=Array.isArray(issues)?issues.map(x=>`${(x.path||[]).join('.')}: ${String(x.message)}`).join('; ')
          :typeof body.error==='string'?body.error:typeof body.errorMessage==='string'?body.errorMessage:'';
      }catch{}
      throw new Error(`API returned HTTP ${response.status}${detail?': '+detail.slice(0,250):''}`);
    }
  }
}
export class Jupiter {
  constructor(c,http,executionHttp){this.c=c;this.http=http||new Http(c.apiMs);this.executionHttp=executionHttp||http||new Http(0);this.cache=new Map();}
  get(path,priority=10,signal){return this.http.request(`https://api.jup.ag${path}`,{headers:{'x-api-key':this.c.apiKey},...(signal?{signal}:{})},3,{priority});}
  cachedToken(mint,maxAge=this.c.metadataTtlMs){const row=this.cache.get(mint);return row&&Date.now()-row.at<=maxAge?row.token:null;}
  remember(tokens){for(const token of tokens)if(token?.id)this.cache.set(token.id,{token,at:Date.now()});
    if(this.cache.size>1000){const oldest=[...this.cache].sort((a,b)=>a[1].at-b[1].at);for(const [id]of oldest.slice(0,this.cache.size-1000))this.cache.delete(id);}return tokens;}
  async tokens(mints,priority=5,fresh=false,signal){
    if(signal?.aborted)throw new Error('API request cancelled');
    const ids=[...new Set(mints)];if(ids.length>500)throw new Error('Token batch exceeds 500 mints');
    const cached=ids.map(id=>this.cachedToken(id));if(!fresh&&cached.every(Boolean))return cached;
    const all=[];for(let i=0;i<ids.length;i+=100){
      const data=await this.get('/tokens/v2/search?query='+encodeURIComponent(ids.slice(i,i+100).join(',')),priority,signal);
      if(!Array.isArray(data))throw new Error('Unexpected token search response');all.push(...data);
    }return this.remember(all);
  }
  async candidates(signal){
    if(this.c.watchlist.length)return this.tokens(this.c.watchlist,20,false,signal);
    const sources=[['toporganicscore','1h'],['toptraded','1h'],['toptrending','5m'],['toptraded','24h'],['toptrending','1h']];
    const unique=new Map();
    for(const [category,interval]of sources){
      const data=await this.get(`/tokens/v2/${category}/${interval}?limit=${Math.min(100,this.c.candidates)}`,20,signal);
      if(!Array.isArray(data))throw new Error('Unexpected token discovery response');for(const t of data)unique.set(t.id,t);
      if(unique.size>=this.c.candidates)break;
    }
    return this.remember([...unique.values()].sort((a,b)=>(b.organicScore||0)-(a.organicScore||0)).slice(0,this.c.candidates));
  }
  async quote(input, output, amount, taker, context = {}) {
    const selling=context.side==='sell'||(context.side!=='buy'&&output===USDC);
    const limits = selling ? { ...this.c, slippage: this.c.exitSlippage, swapFee: this.c.exitSwapFee } : this.c;
    const p = new URLSearchParams({ inputMint: input, outputMint: output, amount: String(amount),
      slippageBps: String(limits.slippage), excludeRouters: 'jupiterz,dflow,okx',
      maxSupportedTransactionVersion: '0', priorityFeeLamports: String(this.c.priority),
      jitoTipLamports: String(this.c.jitoTip), broadcastFeeType: 'maxCap' });
    if (taker) p.set('taker', taker);
    const q = await this.get('/swap/v2/order?' + p,selling?0:2);
    validateQuote(q, input, output, amount, limits, Boolean(taker));
    return { ...q, receivedAt: Date.now() };
  }
  execute(signedTransaction, requestId) {
    // Never automatically retry an execution POST or create a replacement swap on a timeout.
    return this.executionHttp.request('https://api.jup.ag/swap/v2/execute', {
      method: 'POST', headers: { 'x-api-key': this.c.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTransaction, requestId })
    }, 1);
  }
}
export function validateQuote(q, input, output, amount, c, live = false) {
  if (q.error || q.errorCode || q.inputMint !== input || q.outputMint !== output || raw(q.inAmount) !== BigInt(amount))
    throw new Error('Quote failed or does not match the requested swap');
  if (raw(q.outAmount) <= 0n || raw(q.otherAmountThreshold) <= 0n || raw(q.otherAmountThreshold) > raw(q.outAmount))
    throw new Error('Invalid quote output or minimum output');
  if (q.swapMode !== 'ExactIn' || q.router !== 'metis') throw new Error('Unsupported route or swap mode');
  if (!Number.isInteger(q.slippageBps) || q.slippageBps < 0 || q.slippageBps > c.slippage)
    throw new Error('Quote exceeds slippage cap');
  if (raw(q.otherAmountThreshold) < raw(q.outAmount) * BigInt(10000-c.slippage) / 10000n)
    throw new Error('Quote minimum output is inconsistent with slippage cap');
  if (!Number.isFinite(q.priceImpact)) throw new Error('Quote has no usable price impact');
  if (!Number.isFinite(q.feeBps) || q.feeBps < 0 || q.feeBps > c.swapFee) throw new Error('Swap fee exceeds cap or is unavailable');
  if (live) {
    if (!q.transaction || !q.requestId || q.transactionVersion !== 0 || q.gasless)
      throw new Error('Expected a non-sponsored v0 transaction');
    for (const key of ['signatureFeeLamports','prioritizationFeeLamports','rentFeeLamports'])
      if (!Number.isSafeInteger(q[key]) || q[key] < 0) throw new Error(`Missing or invalid ${key}`);
    if (q.signatureFeeLamports + q.prioritizationFeeLamports > c.networkCap || q.rentFeeLamports > c.rentCap)
      throw new Error('Network fee or rent exceeds cap');
    if(q.prioritizationFeeLamports>c.priority+c.jitoTip)throw new Error('Priority fee and tip exceed their configured cap');
    if (!Number.isSafeInteger(Number(q.lastValidBlockHeight)) || Number(q.lastValidBlockHeight) <= 0)
      throw new Error('No usable transaction expiry');
  }
}

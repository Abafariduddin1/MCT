import { Http } from './api.mjs';

// Raw read-only RPC avoids the old SDK's v0-only response decoder. Never signs v1.
export class HistorySource {
  constructor(c,http=new Http(250)){this.c=c;this.http=http;this.id=0;}
  async rpc(method,params) {
    const data=await this.http.request(this.c.rpc,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:++this.id,method,params})},2);
    if(data.error)throw new Error(`History RPC ${data.error.code}: ${String(data.error.message).slice(0,200)}`);
    if(data.result===undefined)throw new Error('History RPC has no result');
    return data.result;
  }
  slot(){return this.rpc('getSlot',[{commitment:this.c.copyCommitment||'finalized'}]);}
  page(leader,fromSlot,toSlot,token=null) {
    return this.rpc('getTransactionsForAddress',[leader,{transactionDetails:'full',encoding:'jsonParsed',
      maxSupportedTransactionVersion:1,commitment:this.c.copyCommitment||'finalized',sortOrder:'asc',limit:this.c.copyPage,
      ...(token?{paginationToken:token}:{}),filters:{slot:{gte:fromSlot,lte:toSlot},status:'succeeded',
        // Helius requires a mint for amount filters. Copy discovery spans mints;
        // retain the own-transfer filter and validate nonzero swap deltas locally.
        tokenAccounts:'balanceChanged',tokenTransfer:{direction:'any'}}}]);
  }
}

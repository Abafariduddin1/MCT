export class FakeSocket extends EventTarget{
  static all=[];constructor(url){super();this.url=url;this.requests=[];this.closed=false;FakeSocket.all.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(text){const r=JSON.parse(text);this.requests.push(r);queueMicrotask(()=>this.message({jsonrpc:'2.0',id:r.id,result:r.id}));}
  message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  close(){if(this.closed)return;this.closed=true;this.dispatchEvent(new Event('close'));}
}

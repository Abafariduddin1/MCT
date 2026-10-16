import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
export function object(value:unknown):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value))throw Error('Expected an object');return value as Record<string,unknown>;
}
export function finite(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)?value:null;}
export function positive(value:unknown):number|null{const n=finite(value);return n!==null&&n>0?n:null;}
export function label(value:unknown,fallback:string,max=40):string{return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,max)||fallback:fallback;}
export function mintAddress(value:unknown):string{
  if(typeof value!=='string')throw Error('Missing mint address');
  const key=new PublicKey(value).toBase58();if(key!==value)throw Error('Noncanonical mint address');return key;
}
export function rawAmount(value:string):bigint{if(typeof value!=='string'||!/^(0|[1-9]\d{0,24})$/.test(value))throw Error('Invalid raw amount');return BigInt(value);}
export function solToLamports(value:string):bigint{
  if(!/^(0|[1-9]\d{0,3})(\.\d{1,9})?$/.test(value))throw Error('SOL amount must be a decimal string with at most nine places');
  const [whole='0',fraction='']=value.split('.');return BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));
}
export function atomicJson(file:string,value:unknown):void{
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.renameSync(temporary,file);}catch(error){fs.rmSync(temporary,{force:true});throw error;}
  // Persist the directory entry as well as the file on platforms that support it.
  // Windows does not expose directory fsync through this API.
  if(process.platform!=='win32'){const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
}
export function safeError(error:unknown,secrets:string[]=[]):string{
  let message=error instanceof Error?error.message:String(error);
  for(const secret of secrets.filter(s=>s.length>3))message=message.replaceAll(secret,'[redacted]');
  return message.replace(/(?:https?|wss?):\/\/[^\s]+/g,'[endpoint]').slice(0,240);
}
const imageHosts=new Set(['cdn.dexscreener.com','dd.dexscreener.com','ipfs.io','gateway.pinata.cloud','pump.mypinata.cloud','arweave.net']);
export function imageUri(value:unknown):string|null{
  if(typeof value!=='string'||value.length>1500)return null;
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&imageHosts.has(u.hostname)?u.href:null;}catch{return null;}
}
export function day(now=Date.now()):string{return new Date(now).toISOString().slice(0,10);}
export async function wait(ms:number,signal?:AbortSignal):Promise<void>{
  if(signal?.aborted)throw Error('Cancelled');
  await new Promise<void>((resolve,reject)=>{
    const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolve();};
    const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(Error('Cancelled'));};
    const timer=setTimeout(done,Math.max(0,ms));signal?.addEventListener('abort',cancel,{once:true});
  });
}

import fs from 'node:fs';
import {createHash} from 'node:crypto';
import type {CoreModules} from './types.js';

const schema=JSON.parse(fs.readFileSync(new URL('../../core/src/jupiter-layout.json',import.meta.url),'utf8')) as {
  types:Array<{name:string;type:{kind:string;fields?:Array<{name:string;type:unknown}>;variants?:Array<{name:string;fields?:Array<{type?:unknown}>}>}}>
};
const types=new Map(schema.types.map(row=>[row.name.toLowerCase(),row.type]));
const discriminator=(name:string)=>createHash('sha256').update('global:'+name).digest().subarray(0,8);

export function strengthenNativeMinimum(data:Uint8Array,minimum:bigint):Buffer {
  const bytes=Buffer.from(data),prefix=bytes.subarray(0,8);
  let outputAt:number,slippageAt:number;
  if(prefix.equals(discriminator('route'))||prefix.equals(discriminator('shared_accounts_route'))) {
    if(bytes.length<31)throw Error('Truncated native route');outputAt=bytes.length-11;slippageAt=bytes.length-3;
  }else if(prefix.equals(discriminator('route_v2'))||prefix.equals(discriminator('shared_accounts_route_v2'))) {
    const header=8+(prefix.equals(discriminator('shared_accounts_route_v2'))?1:0);
    if(bytes.length<header+26)throw Error('Truncated native V2 route');outputAt=header+8;slippageAt=header+16;
  }else throw Error('Unsupported native Jupiter route instruction');
  const output=bytes.readBigUInt64LE(outputAt);
  if(minimum<=0n||minimum>output)throw Error('Native quote minimum is outside the encoded output');
  const current=bytes.readUInt16LE(slippageAt),strongestAllowed=Number((output-minimum)*10000n/output);
  // The API may round its minimum up by one unit. Reduce the encoded tolerance
  // rather than accepting a weaker floor or changing the requested token amount.
  bytes.writeUInt16LE(Math.min(current,strongestAllowed),slippageAt);return bytes;
}

export function verifyNativeRoute(data:Uint8Array,amount:bigint,minimum:bigint,slippageCap:number,legacy:CoreModules['verifyRouteInstruction']):void {
  const bytes=Buffer.from(data),prefix=bytes.subarray(0,8);
  if(prefix.equals(discriminator('route'))||prefix.equals(discriminator('shared_accounts_route'))) {
    legacy(bytes,amount,minimum,slippageCap);
    if(bytes.at(-1)!==0)throw Error('Encoded route contains an integrator platform fee');
    return;
  }
  const shared=prefix.equals(discriminator('shared_accounts_route_v2'));
  if(!shared&&!prefix.equals(discriminator('route_v2')))throw Error('Unsupported native Jupiter route instruction');
  // V2 places its exact-in limits before the route vector. The four bytes
  // following slippage contain extra fee/slippage controls; this implementation
  // supports only all-zero controls. Unknown extensions remain unsupported.
  const header=8+(shared?1:0);
  if(bytes.length<header+26)throw Error('Truncated native V2 route header');
  const input=bytes.readBigUInt64LE(header),output=bytes.readBigUInt64LE(header+8),slippage=bytes.readUInt16LE(header+16);
  if(input!==amount||output<=0n||slippage>slippageCap||slippage>10000||output*BigInt(10000-slippage)/10000n<minimum)
    throw Error('Native V2 route input or minimum output differs from the intent');
  if(!bytes.subarray(header+18,header+22).equals(Buffer.alloc(4)))throw Error('Unsupported native V2 fee/slippage controls');
  let offset=header+22;
  const consume=(length:number)=>{if(length<0||offset+length>bytes.length)throw Error('Truncated native V2 route vector');offset+=length;};
  const skip=(value:unknown,depth=0):void=>{
    if(depth>12)throw Error('Native route nesting exceeds its limit');
    const fixed:Record<string,number>={bool:1,u8:1,i8:1,u16:2,i16:2,u32:4,i32:4,f32:4,u64:8,i64:8,f64:8,u128:16,i128:16,publicKey:32,pubkey:32};
    if(typeof value==='string'&&fixed[value]) {const at=offset;consume(fixed[value]!);if(value==='bool'&&bytes[at]!==0&&bytes[at]!==1)throw Error('Invalid route boolean');return;}
    const type=value as {array?:[unknown,number];option?:unknown;vec?:unknown;defined?:string|{name:string}};
    if(type?.array){if(!Number.isSafeInteger(type.array[1])||type.array[1]>128)throw Error('Oversized route array');for(let i=0;i<type.array[1];i++)skip(type.array[0],depth+1);return;}
    if(type?.option){const at=offset;consume(1);if(bytes[at]===1)skip(type.option,depth+1);else if(bytes[at]!==0)throw Error('Invalid route option');return;}
    if(type?.vec){const at=offset;consume(4);const count=bytes.readUInt32LE(at);if(count>128)throw Error('Oversized nested route vector');for(let i=0;i<count;i++)skip(type.vec,depth+1);return;}
    const name=type?.defined?(typeof type.defined==='string'?type.defined:type.defined.name):typeof value==='string'?value:null;
    const definition=name?types.get(name.toLowerCase()):undefined;
    if(!definition)throw Error('Unsupported pinned native route type');
    if(definition.kind==='struct'){for(const field of definition.fields??[])skip(field.type,depth+1);return;}
    if(definition.kind==='enum'){
      const at=offset;consume(1);const variant=definition.variants?.[bytes[at]!];
      if(!variant)throw Error('Unsupported native venue variant; update the pinned layout before trading');
      for(const field of variant.fields??[])skip(field.type??field,depth+1);return;
    }
    throw Error('Unsupported native route definition');
  };
  const at=offset;consume(4);const steps=bytes.readUInt32LE(at);
  if(steps<1||steps>32)throw Error('Native V2 route has no steps or exceeds its budget');
  for(let i=0;i<steps;i++) {
    skip({defined:'Swap'});
    const weightAt=offset;consume(2);if(bytes.readUInt16LE(weightAt)>10000)throw Error('Invalid native V2 route weight');
    consume(2); // Input/output token indices are one byte each.
  }
  if(offset!==bytes.length)throw Error('Unexpected trailing bytes in native V2 route');
}

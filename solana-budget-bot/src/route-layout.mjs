import fs from 'node:fs';
const schema=JSON.parse(fs.readFileSync(new URL('./jupiter-layout.json',import.meta.url),'utf8'));
const types=new Map(schema.types.map(t=>[t.name.toLowerCase(),t.type]));
export function routeArgumentsOffset(data,shared){
  const b=Buffer.from(data);let offset=shared?9:8;
  const consume=n=>{if(!Number.isSafeInteger(n)||n<0||offset+n>b.length)throw Error('Truncated Jupiter route layout');offset+=n;};
  const skip=(type,depth=0)=>{
    if(depth>12)throw Error('Unsupported recursive Jupiter route layout');
    const fixed={bool:1,u8:1,i8:1,u16:2,i16:2,u32:4,i32:4,f32:4,u64:8,i64:8,f64:8,u128:16,i128:16,publicKey:32,pubkey:32};
    if(typeof type==='string'&&fixed[type]){consume(fixed[type]);return;}
    if(type?.array){for(let i=0;i<type.array[1];i++)skip(type.array[0],depth+1);return;}
    if(type?.option){const at=offset;consume(1);if(b[at]===1)skip(type.option,depth+1);else if(b[at]!==0)throw Error('Invalid route option');return;}
    if(type?.vec){const at=offset;consume(4);const length=b.readUInt32LE(at);if(length>128)throw Error('Route vector exceeds validation budget');for(let i=0;i<length;i++)skip(type.vec,depth+1);return;}
    const name=type?.defined?(typeof type.defined==='string'?type.defined:type.defined.name):typeof type==='string'?type:null;
    const definition=name&&types.get(name.toLowerCase());
    if(!definition)throw Error('Unsupported Jupiter route type');
    if(definition.kind==='struct'){for(const field of definition.fields)skip(field.type,depth+1);return;}
    if(definition.kind==='enum'){
      const at=offset;consume(1);const variant=definition.variants[b[at]];
      if(!variant)throw Error('Unsupported Jupiter venue variant; update the pinned layout');
      for(const field of variant.fields||[])skip(field.type||field,depth+1);return;
    }
    throw Error('Unsupported Jupiter type layout');
  };
  skip({vec:{defined:'RoutePlanStep'}});
  if(offset+19!==b.length)throw Error('Unexpected trailing bytes or changed Jupiter route layout');
  return offset;
}

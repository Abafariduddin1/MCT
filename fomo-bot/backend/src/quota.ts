import fs from 'node:fs';
import path from 'node:path';
import {atomicJson,day,object} from './util.js';
export class QuotaTracker {
  private usage:{day:string;spent:number};
  constructor(readonly file:string,readonly dailyLimit:number,readonly reserve=0,private now=Date.now){
    this.usage={day:day(now()),spent:0};
    if(fs.existsSync(file)){
      const saved=object(JSON.parse(fs.readFileSync(file,'utf8')));
      if(typeof saved.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(saved.day)||saved.day>this.usage.day||!Number.isSafeInteger(saved.spent)||Number(saved.spent)<0)throw Error('Invalid quota record; refusing to reset usage');
      if(saved.day===this.usage.day)this.usage={day:saved.day,spent:Number(saved.spent)};
    }
  }
  consume(cost:number,urgent=false):void{
    if(!Number.isSafeInteger(cost)||cost<1)throw Error('Invalid quota cost');
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const lock=this.file+'.lock';let fd:number;
    try{fd=fs.openSync(lock,'wx',0o600);}catch{throw Error('Quota reservation locked; keep one backend writer and investigate a stale quota lock');}
    try{
      const current=new QuotaTracker(this.file,this.dailyLimit,this.reserve,this.now).usage;
      if(current.day!==day(this.now())){current.day=day(this.now());current.spent=0;}
      const limit=this.dailyLimit-(urgent?0:this.reserve);
      if(current.spent+cost>limit)throw Error('Daily request budget reached');
      const next={day:current.day,spent:current.spent+cost};atomicJson(this.file,next);this.usage=next;
    }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
  }
  snapshot():{day:string;spent:number;remaining:number}{return this.usage.day===day(this.now())?{...this.usage,remaining:Math.max(0,this.dailyLimit-this.usage.spent)}:{day:day(this.now()),spent:0,remaining:this.dailyLimit};}
}

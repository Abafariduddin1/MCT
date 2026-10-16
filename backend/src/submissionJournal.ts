import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import {atomicJson,object} from './util.js';

export interface Submission {
  signature:string;bytesHash:string;transport:'jito'|'rpc';at:number;
  bundleId:string|null;outcome:'attempted'|'accepted'|'unknown';
}

export class SubmissionJournal {
  private file:string;
  private lock:string;
  constructor(stateDir:string) {
    this.file=path.join(stateDir,'execution-submissions.json');
    this.lock=this.file+'.lock';
    this.read();
  }

  private read():Submission[] {
    if(!fs.existsSync(this.file))return [];
    const value=object(JSON.parse(fs.readFileSync(this.file,'utf8')));
    if(value.version!==1||!Array.isArray(value.attempts)||value.attempts.length>5000)throw Error('Invalid execution submission journal');
    const seen=new Set<string>();
    return value.attempts.map(input=>{
      const row=object(input);
      if(typeof row.signature!=='string'||bs58.decode(row.signature).length!==64||seen.has(row.signature)||
        typeof row.bytesHash!=='string'||!/^[a-f0-9]{64}$/.test(row.bytesHash)||!['jito','rpc'].includes(String(row.transport))||
        !Number.isSafeInteger(row.at)||Number(row.at)<0||!['attempted','accepted','unknown'].includes(String(row.outcome))||
        (row.bundleId!==null&&(typeof row.bundleId!=='string'||!/^[a-fA-F0-9]{32,128}$/.test(row.bundleId))))throw Error('Invalid execution journal receipt');
      seen.add(row.signature);return row as unknown as Submission;
    });
  }

  reserve(record:Submission):{finish:(outcome:'accepted'|'unknown',bundleId?:string)=>void;release:()=>void} {
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    let fd:number;
    try {fd=fs.openSync(this.lock,'wx',0o600);}catch {throw Error('Another execution submission is active, or its lock needs recovery');}
    let released=false;
    const release=()=>{if(released)return;released=true;fs.closeSync(fd);fs.unlinkSync(this.lock);};
    try {
      const rows=this.read();
      // Respect receipts from the previous Step 1 archive if one was used.
      const old=path.join(path.dirname(this.file),'jito-submissions.json');
      if(fs.existsSync(old)) {
        const legacy=object(JSON.parse(fs.readFileSync(old,'utf8')));
        if(legacy.version!==1||!Array.isArray(legacy.attempts))throw Error('Invalid previous Jito journal');
        if(legacy.attempts.some(input=>object(input).signature===record.signature))throw Error('This signature was already attempted; reconcile it instead of resubmitting');
      }
      if(rows.some(row=>row.signature===record.signature))throw Error('This signature was already attempted; reconcile it instead of resubmitting');
      if(rows.length>=5000)throw Error('Execution journal full; archive only after reconciliation');
      rows.push(record);atomicJson(this.file,{version:1,attempts:rows});
      return {release,finish:(outcome,bundleId)=>{
        if(released)throw Error('Execution reservation was released');
        record.outcome=outcome;record.bundleId=bundleId??null;atomicJson(this.file,{version:1,attempts:rows});
      }};
    }catch(error) {release();throw error;}
  }
}

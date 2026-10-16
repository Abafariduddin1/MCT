// Validation only. Never executes a command or contacts a provider.
import fs from 'node:fs';
import {parseCommand} from '../dist/src/protocol.js';
const path=process.argv[2];if(!path)throw Error('Supply the Swift-generated JSON fixture path');
const rows=JSON.parse(fs.readFileSync(path,'utf8'));
if(!Array.isArray(rows)||rows.length!==6)throw Error('Expected six command fixtures');
const accepted=rows.map(row=>parseCommand(row));
if(new Set(accepted.map(c=>c.id)).size!==6)throw Error('Duplicate fixture ids');
console.log('Validated all 6 Swift-encoded command variants against the actual backend parser. No commands executed.');

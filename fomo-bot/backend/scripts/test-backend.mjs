import {spawn} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../dist/',import.meta.url);
const files=readdirSync(new URL('test/',root)).filter(name=>name.endsWith('.test.js')).sort().map(name=>'test/'+name);
const child=spawn(process.execPath,['--test',...files],{cwd:fileURLToPath(root),stdio:'inherit',shell:false});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});

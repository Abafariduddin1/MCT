import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const dir of ['src','scripts','test']) {
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.mjs')))
    execFileSync(process.execPath,['--check',`${dir}/${file}`],{stdio:'inherit'});
}
console.log('All source, scripts and test modules passed syntax checks.');

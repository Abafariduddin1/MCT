// Reproduces the shared Swift/client checks using an actual loopback paper
// controller. The temporary credential stays in a private temporary file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const backend=fileURLToPath(new URL('../',import.meta.url));
const ios=fileURLToPath(new URL('../../ios/',import.meta.url));
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fomobot-step4-'));
const probe=path.join(directory,'probe.json'),codec=path.join(directory,'swift-commands.json');
const server=spawn(process.execPath,['scripts/serve-swift-fixture.mjs',probe],{cwd:backend,stdio:['ignore','inherit','inherit']});
let serverError=null,active=null;
server.on('error',error=>{serverError=error;});
const cancel=()=>{active?.kill('SIGTERM');server.kill('SIGTERM');process.exitCode=130;};
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
const run=(command,args,cwd,env=process.env)=>new Promise((resolve,reject)=>{
 const child=spawn(command,args,{cwd,env,stdio:'inherit'});active=child;
 child.once('error',error=>reject(Error('Could not start '+command+': '+error.message)));
 child.once('exit',(code,signal)=>{active=null;code===0?resolve():reject(Error(command+' failed ('+(signal??code)+')'));});
});
try{
 const deadline=Date.now()+10000;
 while(!fs.existsSync(probe)){
  if(serverError||server.exitCode!==null||Date.now()>deadline)throw Error('Local paper fixture did not start');
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 // This package uses XCTest exclusively. Do not launch a second, empty
 // Swift Testing runner after XCTest has finished.
 await run('swift',['test','--disable-swift-testing','-j','1'],ios,{...process.env,FOMOBOT_LOCAL_PROBE_FILE:probe,FOMOBOT_CODEC_OUTPUT:codec});
 await run(process.execPath,['scripts/verify-swift-commands.mjs',codec],backend);
 await run('swift',['build','-c','release','--target','FomoBotCore','-j','1'],ios);
 if(process.platform!=='win32')await run('sh',['Scripts/check-apple-syntax.sh'],ios);
 console.log('Shared Swift tests, actual controller HTTP, command codec and Release core checks passed. Review explicit test skips; Apple iOS SDK/device acceptance remains separate.');
}catch(error){console.error(error.message);process.exitCode=process.exitCode||1;}
finally{
 if(server.exitCode===null&&!serverError){
  const closed=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');
  let timer;await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>{server.kill('SIGKILL');resolve();},5000);})]);clearTimeout(timer);
 }
 fs.rmSync(directory,{recursive:true,force:true});process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
}

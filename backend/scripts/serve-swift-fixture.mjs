// Optional local Swift transport integration. Virtual paper data only.
import fs from 'node:fs';
import {fixture,buy} from '../dist/test/controller-fixture.js';
import {ControllerServer} from '../dist/src/server.js';
const output=process.argv[2];if(!output)throw Error('Supply a private temporary JSON file path');
const f=await fixture();const server=new ControllerServer({...f.c,port:0},f.engine);
try{
 f.engine.submitCommand(buy());await f.engine.idle();const port=await server.listen();
 fs.writeFileSync(output,JSON.stringify({url:'http://127.0.0.1:'+port,token:f.c.appAccessToken,id:'buy_command_00000001',mint:f.ledger.read().positions[0].mint}),{mode:0o600});
 let stopped=false;
 const stop=async()=>{if(stopped)return;stopped=true;await server.close();await f.cleanup();fs.rmSync(output,{force:true});};
 process.once('SIGINT',()=>{void stop().then(()=>process.exit(0));});process.once('SIGTERM',()=>{void stop().then(()=>process.exit(0));});
 console.log('Local paper fixture is ready. No external provider is connected.');
}catch(error){await server.close();await f.cleanup();throw error;}

import {readFile,writeFile,unlink,rename} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {privatePath} from './files.js';
import {parseManagedPolicy,createManagedBroker} from './managed-network.js';
import {createGateway} from './gateway.js';

/** Launched only by the native app, with an inherited host-only control pipe.
 * Guest bytes never reach stdin; guest status cannot enable/disable this process.
 */
async function main(){
 process.umask(0o077);
 if(process.platform!=='darwin')throw Error('Managed host service requires macOS.');
 const [folder,portText]=process.argv.slice(2),port=Number(portText);
 if(!folder||!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid managed host arguments.');
 const run=await privatePath(folder,true),root=await privatePath(dirname(run),true),policyFile=await privatePath(join(root,'managed-network.json'));
 const policyBytes=await readFile(policyFile);if(policyBytes.length>65536)throw Error('Network policy is too large.');
 const broker=createManagedBroker(parseManagedPolicy(JSON.parse(policyBytes.toString())));
 const keyPath=join(root,`gateway-key-${port}`),key=randomBytes(32);let ownsKey=false;
 let running=false,finished=false;let gateway:Awaited<ReturnType<typeof createGateway>>|undefined;
 const finish=async()=>{if(finished)return;finished=true;running=false;broker.close();gateway?.closeAllConnections();gateway?.close();if(ownsKey&&await readFile(keyPath,'utf8').catch(()=>'')===key.toString('hex'))await unlink(keyPath).catch(()=>{});process.stdin.destroy();};
 try{
  await new Promise<void>((r,j)=>{broker.server.once('error',j);broker.server.listen(join(run,'egress.sock'),r);});
  gateway=await createGateway({port,guestPort:4173,socketPath:join(run,'api.sock'),publicDirectory:resolve(dirname(fileURLToPath(import.meta.url)),'../public'),proofKey:key,healthy:()=>running&&!finished});
  await new Promise<void>((r,j)=>{gateway!.once('error',j);gateway!.listen(port,'127.0.0.1',r);});
  // Publish host proof only after this process owns the loopback listener. Replace a
  // stale file atomically; a live gateway prevents binding, so its key is untouched.
  const staged=join(run,'proof-key');await writeFile(staged,key.toString('hex'),{flag:'wx',mode:0o600});await rename(staged,keyPath);ownsKey=true;
  // Native parent maintains a lease, independently of guest output. EOF/expiry closes all flows.
  let lease=Date.now(),pending='';const watchdog=setInterval(()=>{if(Date.now()-lease>6000)void finish();},1000);watchdog.unref();
  process.stdin.setEncoding('utf8');process.stdin.on('data',(chunk:string)=>{pending+=chunk;if(pending.length>1024){void finish();return;}let index:number;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);if(line==='RUNNING'){running=true;lease=Date.now();}else if(line==='BOOTING'){running=false;lease=Date.now();}else void finish();}});
  process.stdin.on('end',()=>void finish());process.stdin.on('error',()=>void finish());
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void finish());
  console.log('SUPPORT_MANAGED_READY_V1');
 }catch(e){await finish();throw e;}
}
main().catch(()=>{console.error('Managed host service could not start. Check the private policy, runtime bundle and free port.');process.exitCode=1;});

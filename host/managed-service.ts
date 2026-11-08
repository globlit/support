import {readFile,writeFile,unlink,rename} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {privatePath} from './files.js';
import {parseManagedPolicy,createManagedBroker} from './managed-network.js';
import {createGateway} from './gateway.js';
import {managedLease} from './managed-lease.js';

/** Launched by the native app with a host-only control pipe. */
async function main(){
 process.umask(0o077);
 if(process.platform!=='darwin')throw Error('Managed host service requires macOS.');
 const [folder,portText]=process.argv.slice(2),port=Number(portText);
 if(!folder||!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid managed host arguments.');
 const run=await privatePath(folder,true),root=await privatePath(dirname(run),true),policyFile=await privatePath(join(root,'managed-network.json'));
 const policyBytes=await readFile(policyFile);if(policyBytes.length>65536)throw Error('Network policy is too large.');
 const broker=createManagedBroker(parseManagedPolicy(JSON.parse(policyBytes.toString())));
 const keyPath=join(root,`gateway-key-${port}`),key=randomBytes(32);let ownsKey=false;
 let finished=false;let gateway:Awaited<ReturnType<typeof createGateway>>|undefined;
 const finish=async()=>{if(finished)return;finished=true;broker.close();gateway?.closeAllConnections();gateway?.close();if(ownsKey&&await readFile(keyPath,'utf8').catch(()=>'')===key.toString('hex'))await unlink(keyPath).catch(()=>{});process.stdin.destroy();};
 const lease=managedLease(()=>void finish());
 try{
  await new Promise<void>((r,j)=>{broker.server.once('error',j);broker.server.listen(join(run,'egress.sock'),r);});
  gateway=await createGateway({port,guestPort:4173,socketPath:join(run,'api.sock'),publicDirectory:resolve(dirname(fileURLToPath(import.meta.url)),'../public'),proofKey:key,healthy:()=>lease.running&&!finished});
  await new Promise<void>((r,j)=>{gateway!.once('error',j);gateway!.listen(port,'127.0.0.1',r);});
  // Publish host proof after binding the listener.
  const staged=join(run,'proof-key');await writeFile(staged,key.toString('hex'),{flag:'wx',mode:0o600});await rename(staged,keyPath);ownsKey=true;
  // The native parent lease closes all flows on EOF or expiry.
  const watchdog=setInterval(()=>lease.tick(),1000);watchdog.unref();
  process.stdin.setEncoding('utf8');process.stdin.on('data',(chunk:string)=>lease.write(chunk));
  process.stdin.on('end',lease.close);process.stdin.on('error',lease.close);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,lease.close);
  console.log('SUPPORT_MANAGED_READY_V1');
 }catch(e){await finish();throw e;}
}
main().catch(()=>{console.error('Managed host service could not start. Check the private policy, runtime bundle and free port.');process.exitCode=1;});

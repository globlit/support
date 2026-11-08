import {readFile,mkdir,mkdtemp,lstat,writeFile,unlink,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requireVerifiedNativeProvider} from './provider.js';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {parseProfile,renderPF,sshArguments} from './policy.js';
import {privatePath,snapshot} from './files.js';
import {verifyPF} from './firewall.js';
import {inputImage} from './input-image.js';
import {createGateway} from './gateway.js';
import {tartReadiness} from './tart-readiness.js';
import {vmCommand,validateVMRequest} from './vm-connection.js';

process.umask(0o077);
const [command,file,destination]=process.argv.slice(2);
async function main(){
 if(['vm-discover','vm-check','vm-trust','vm-connect'].includes(command)){
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>8192)throw Error('VM selection exceeds size limit.');}
  await vmCommand(command,validateVMRequest(JSON.parse(input)),report=>console.log(JSON.stringify(report)));return;
 }

 const protectedPaths=[dirname(fileURLToPath(import.meta.url)),join(homedir(),'Library','Application Support','Support Host')];
 if(command==='inspect-vagrant'&&file){
  if(process.platform!=='darwin')throw Error('Run inspect-vagrant on the Mac that owns the VM.');
  const location=resolve(file);if(!(await lstat(location)).isDirectory())throw Error('Choose the host Vagrant project directory.');
  let executable='';for(const candidate of ['/opt/homebrew/bin/vagrant','/usr/local/bin/vagrant','/usr/bin/vagrant'])if(await lstat(candidate).catch(()=>null)){executable=candidate;break;}
  if(!executable)throw Error('Vagrant was not found on this Mac.');
  const result=await promisify(execFile)(executable,['status','--machine-readable'],{cwd:location,timeout:20000,maxBuffer:128*1024,env:{PATH:'/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',HOME:homedir(),VAGRANT_CWD:location,VAGRANT_VAGRANTFILE:'Vagrantfile',CHECKPOINT_DISABLE:'1',VAGRANT_CHECKPOINT_DISABLE:'1'}});
  const rows=result.stdout.split('\n').map(line=>line.split(','));
  const machines=rows.filter(row=>['provider-name','state'].includes(row[2])).map(row=>({machine:row[1],field:row[2],value:row.slice(3).join(',')}));
  const provider=rows.find(row=>row[2]==='provider-name')?.[3]??'';
  if(provider==='tart'){
   const read=async(binary:string,args:string[])=>{try{return (await promisify(execFile)(binary,args,{cwd:location,timeout:10000,maxBuffer:128*1024,env:{PATH:'/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',HOME:homedir(),CHECKPOINT_DISABLE:'1',VAGRANT_CHECKPOINT_DISABLE:'1'}})).stdout.trim();}catch{return '';}};
   const binary=async(name:string)=>{for(const base of ['/opt/homebrew/bin','/usr/local/bin']){const p=join(base,name);if(await lstat(p).catch(()=>null))return p;}return '';};
   const tart=await binary('tart'),softnet=await binary('softnet');
   const plugins=await read(executable,['plugin','list']);
   const report=tartReadiness({provider,pluginVersion:plugins.match(/vagrant-tart \(([^ ,)]+)/)?.[1],tartVersion:tart?await read(tart,['--version']):'',tartHelp:tart?await read(tart,['run','--help']):'',softnetVersion:softnet?await read(softnet,['--version']):'',softnetHelp:softnet?await read(softnet,['--help']):''});
   console.log('Tart connection checks');for(const c of report.checks)console.log(`${c.ok?'Available':'Needs attention'} · ${c.name}: ${c.detail}`);
   console.log('\n'+report.message+'\nOpen VM connection in the Mac companion and select a running VM.');
  }else console.log(JSON.stringify({machines,message:'Choose a Tart-backed Vagrant project. Other providers need their own verified host boundary.'},null,2));return;
 }
 if(command==='input-image'&&file&&destination){console.log(await inputImage(file,destination,protectedPaths));return;}
 if(command==='snapshot'&&file&&destination){console.log(await snapshot(file,destination,{protectedPaths}));return;}
 if(!['network-rules','check-network','serve'].includes(command)||!file)throw Error('Usage: node host/main.js network-rules|check-network|serve /absolute/host-profile.json; or snapshot|input-image /selected/folder /new/private/output; or inspect-vagrant /host/vagrant/project');
 await privatePath(resolve(file));const profile=parseProfile(JSON.parse(await readFile(file,'utf8')));
 if(command==='network-rules'){console.log(renderPF(profile.network));return;}
 if(command==='serve')await requireVerifiedNativeProvider();
 await verifyPF(profile.network);if(command==='check-network'){console.log('Loaded PF rules match. Provider topology and disabled shares still require host verification.');return;}
 if(process.getuid?.()===0)throw Error('Run the gateway as the Mac user, never root. PF inspection needs a narrow administrator-provided read mechanism; do not run Support as root.');
 const root=join(homedir(),'Library','Application Support','Support Host');await mkdir(root,{recursive:true,mode:0o700});await privatePath(root,true);
 for(const keyFile of [profile.identityFile,profile.knownHostsFile]){await privatePath(keyFile);if(![root,join(homedir(),'.ssh')].some(base=>{const rel=relative(base,keyFile);return rel!==''&&!rel.startsWith('..')&&!rel.startsWith('/');}))throw Error('Store dedicated SSH files in ~/.ssh or the private Support Host directory, outside exportable workspaces.');}
 // No TCP upstream listener: a browser cannot bypass this gateway and execute guest HTML.
 const run=await mkdtemp(join(root,'run-')),socket=join(run,'backend.sock'),keyPath=join(root,`gateway-key-${profile.port}`),key=randomBytes(32);
 // Existing key is never overwritten: another active host gateway must be stopped first.
 await writeFile(keyPath,key.toString('hex'),{flag:'wx',mode:0o600});
 let ssh:ReturnType<typeof spawn>|undefined,server:Awaited<ReturnType<typeof createGateway>>|undefined,healthy=false,timer:NodeJS.Timeout|undefined,closing=false;
 const stop=async()=>{if(closing)return;closing=true;healthy=false;if(timer)clearTimeout(timer);server?.closeAllConnections();await new Promise<void>(r=>{if(server?.listening)server.close(()=>r());else r();});if(ssh&&ssh.exitCode===null){ssh.kill('SIGTERM');await Promise.race([new Promise(r=>ssh!.once('exit',r)),delay(2000)]);if(ssh.exitCode===null)ssh.kill('SIGKILL');}await unlink(keyPath).catch(()=>{});await rm(run,{recursive:true,force:true});};
 try{
  ssh=spawn('/usr/bin/ssh',sshArguments(profile,socket),{env:{PATH:'/usr/bin:/bin',HOME:homedir(),LANG:'C'},stdio:['ignore','ignore','ignore']});
  let failed=false;ssh.once('error',()=>{failed=true;healthy=false;});ssh.once('exit',()=>{failed=true;healthy=false;void stop();});
  let ready=false;for(let i=0;i<100;i++){if(failed)throw Error('SSH failed. Check the dedicated key, pinned host key and VM connection.');const s=await lstat(socket).catch(()=>null);if(s?.isSocket()&&s.uid===process.getuid?.()&&!(s.mode&0o077)){ready=true;break;}await delay(100);}
  if(!ready||failed||closing)throw Error('Private SSH socket was not established.');
  healthy=true;
  server=await createGateway({port:profile.port,guestPort:profile.guestPort,socketPath:socket,publicDirectory:resolve(dirname(fileURLToPath(import.meta.url)),'../public'),proofKey:key,healthy:()=>healthy&&!failed&&!closing});
  if(failed||closing||ssh.exitCode!==null)throw Error('SSH ended before the gateway became available.');
  await new Promise<void>((r,j)=>{server!.once('error',j);server!.listen(profile.port,'127.0.0.1',r);});
  // Losing the audit closes browser access; permanent rules are never removed by exit.
  const monitor=async()=>{try{await verifyPF(profile.network);if(!closing)timer=setTimeout(()=>void monitor(),5000);}catch{console.error('Host network policy changed. Gateway stopped; stop the VM before repairing host policy.');await stop();}};
  timer=setTimeout(()=>void monitor(),5000);
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>void stop());
  console.log(`Host-served Support UI: http://127.0.0.1:${profile.port}. PF rules stay installed when this gateway stops.`);
 }catch(e){await stop();throw e;}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Host gateway failed.');process.exitCode=1;});

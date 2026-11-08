import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,lstat,realpath,mkdir,mkdtemp,writeFile,rm,unlink,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir,networkInterfaces} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {machinesFromStatus,parseSSH,validateProcessSnapshot,checkHostConfigurationBoundary,checkIsolation,isolationHelp,isolationSnippet,validateRepositoryRoot,validateApprovedShare,UnapprovedSharesError,directoryShares,type Machine,type Check,type SSHSettings,type UnapprovedShare} from './vm-discovery.js';
import {privatePath} from './files.js';
import {sshArguments,sshConfigPath,type SSHConnection} from './policy.js';
import {createGateway} from './gateway.js';

export type VMRequest={project:string;machine?:string;fingerprint?:string;port?:number;repositories?:string;shares?:string[]};
export type VMReport={machines:Machine[];machine?:string;checks:Check[];ready:boolean;fingerprint?:string;url?:string;unapprovedShares?:(UnapprovedShare&{approvable:boolean})[]};
export const installCommands=`# Run inside Ubuntu, not on the Mac. Requires Node.js 24.5 or later.\ngit clone https://github.com/globlit/support.git ~/support\ncd ~/support\nnpm ci\nnpm run build\nnpm start\n# For an existing checkout, use its directory instead of cloning.\n# Keep Support bound to 127.0.0.1:4173 inside the VM.`;
const root=()=>join(homedir(),'Library','Application Support','Support Host');
const hostIPs=()=>Object.values(networkInterfaces()).flatMap(items=>(items??[]).map(i=>i.address));
let cancellation=new AbortController();
const environment={PATH:'/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',HOME:homedir(),LANG:'C',CHECKPOINT_DISABLE:'1',VAGRANT_CHECKPOINT_DISABLE:'1'};
async function run(binary:string,args:string[],cwd?:string){return (await promisify(execFile)(binary,args,{cwd,env:{...environment,...(cwd?{VAGRANT_CWD:cwd,VAGRANT_VAGRANTFILE:'Vagrantfile'}:{})},signal:cancellation.signal,timeout:20000,maxBuffer:256*1024,encoding:'utf8'})).stdout;}
export function validateVMRequest(value:unknown):VMRequest{
 const v=value as VMRequest;
 if(!v||typeof v!=='object'||Object.keys(v).some(k=>!['project','machine','fingerprint','port','repositories','shares'].includes(k))||typeof v.project!=='string'||!v.project.startsWith('/')||v.project.length>4096||/[\0\r\n]/.test(v.project)||v.machine!==undefined&&!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(v.machine)||v.fingerprint!==undefined&&!/^SHA256:[A-Za-z0-9+/]{43}$/.test(v.fingerprint)||v.port!==undefined&&(!Number.isInteger(v.port)||v.port<1024||v.port>65535))throw Error('Invalid VM connection selection.');
 if(v.repositories!==undefined&&(typeof v.repositories!=='string'||!v.repositories.startsWith('/')||v.repositories.length>4096||/[\0\r\n]/.test(v.repositories)))throw Error('Invalid repositories folder.');
 if(v.shares!==undefined&&(!Array.isArray(v.shares)||v.shares.length>16||new Set(v.shares).size!==v.shares.length||v.shares.some(s=>typeof s!=='string'||!s.startsWith('/')||s.length>4096||/[\0\r\n]/.test(s))))throw Error('Invalid approved shares.');
 return v;
}
async function processes(){
 const helper=resolve(dirname(fileURLToPath(import.meta.url)),'../../Runtime/inspect-processes');
 return validateProcessSnapshot(JSON.parse(await run(helper,[])));
}
async function vagrantPath(){for(const path of ['/opt/homebrew/bin/vagrant','/usr/local/bin/vagrant','/usr/bin/vagrant'])if(await lstat(path).catch(()=>null))return path;throw Error('Vagrant is not installed. Install Vagrant and vagrant-tart on this Mac, then recheck.');}
async function projectPath(path:string){
 const project=await realpath(path);if(project!==resolve(path)||!(await lstat(project)).isDirectory())throw Error('Choose the original Vagrant project folder, not a link.');
 const file=join(project,'Vagrantfile'),stat=await lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.mode&0o022)throw Error('Use a Vagrantfile owned by your Mac account and not writable by other users.');
 return project;
}
export function parseHostKey(text:string,host:string,port:number){
 const keys=text.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.trim().split(/\s+/));
 if(keys.length!==1||keys[0].length!==3||keys[0][1]!=='ssh-ed25519'||!/^([A-Za-z0-9+/]{4})+={0,2}$/.test(keys[0][2]))throw Error('Could not read one Ed25519 SSH host key. Check the VM SSH service.');
 const key=Buffer.from(keys[0][2],'base64');
 if(key.length!==51||key.readUInt32BE(0)!==11||key.subarray(4,15).toString()!=='ssh-ed25519'||key.readUInt32BE(15)!==32)throw Error('Invalid SSH host key.');
 return {line:`${port===22?host:`[${host}]:${port}`} ssh-ed25519 ${key.toString('base64')}\n`,fingerprint:'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'')};
}
async function scan(ssh:SSHSettings){return parseHostKey(await run('/usr/bin/ssh-keyscan',['-T','5','-t','ed25519','-p',String(ssh.port),ssh.host]),ssh.host,ssh.port);}
async function replacePrivateFile(path:string,contents:string){
 try{await privatePath(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const temp=path+'.'+randomBytes(8).toString('hex');
 try{await writeFile(temp,contents,{flag:'wx',mode:0o600});await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}
}
async function privateDirectory(path:string){await mkdir(path,{recursive:true,mode:0o700});await privatePath(path,true);}
type VMTransport=SSHConnection&{port:number};
function profile(ssh:SSHSettings,knownHostsFile:string,port:number):VMTransport{return {port,guestPort:4173,sshUser:ssh.user,identityFile:ssh.identity,knownHostsFile,network:{guestIPv4:ssh.host,sshPort:ssh.port}};}
export type SSHFailure='auth'|'hostkey'|'route'|'refused'|'closed'|'timeout'|'unknown';
/** Maps SSH error output to a failure kind. Never shows the output. */
export function classifySSHFailure(stderr:string,timedOut=false):SSHFailure{
 if(/Permission denied \(/.test(stderr))return 'auth';
 if(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* is not known/i.test(stderr))return 'hostkey';
 if(/No route to host/i.test(stderr))return 'route';
 if(/Connection refused/i.test(stderr))return 'refused';
 if(/Connection (?:reset|closed) by|kex_exchange_identification/i.test(stderr))return 'closed';
 if(timedOut||/timed out/i.test(stderr))return 'timeout';
 return 'unknown';
}
const sshFailureDetail:Record<SSHFailure,string>={
 auth:'The VM refused the SSH key reported by Vagrant.',
 hostkey:'The VM SSH host key does not match the identity saved on this Mac.',
 route:'The Mac has no network route to the VM address.',
 refused:'The VM refused the SSH connection.',
 closed:'The VM closed the SSH connection before sign-in.',
 timeout:'The SSH connection to the VM timed out.',
 unknown:'SSH could not connect with the discovered key and pinned host identity.',
};
const sshFailureHelp:Record<SSHFailure,string>={
 auth:'Support signs in only with the private key from vagrant ssh-config, never with a password. Check that the VM user authorizes this key. If the Vagrantfile sets config.ssh.password, Vagrant can report a key that the VM does not accept. Run the commands below, then Recheck.',
 hostkey:'Click Recheck. If the VM identity step asks again, compare the fingerprint with the VM console before you trust it.',
 route:'Allow Support Companion in System Settings → Privacy & Security → Local Network, then restart Support Companion. Check that the VM is running and that its address matches vagrant ssh-config. Then Recheck.',
 refused:'Check that the SSH service runs in the VM. If the VM runs fail2ban, repeated failed sign-ins can ban the Mac address. Run the VM commands below, then Recheck.',
 closed:'The VM SSH service or fail2ban closed the connection. Run the VM commands below, then Recheck.',
 timeout:'Check that the VM is running and reachable. Check the firewall inside the VM allows SSH from the Mac. Allow Support Companion in System Settings → Privacy & Security → Local Network. Then Recheck.',
 unknown:'Run the diagnostic command below on the Mac. Its last lines name the SSH error. Then Recheck.',
};
const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
/** Returns shell commands that reproduce the Support SSH connection for manual diagnosis. */
export function sshDiagnosticCommands(kind:SSHFailure,p:VMTransport){
 const mac=`# On the Mac: reproduce the SSH connection made by Support. Stop it with Ctrl-C.\nssh -v -F /dev/null -N -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o ${shellQuote('UserKnownHostsFile='+sshConfigPath(p.knownHostsFile))} -i ${shellQuote(p.identityFile)} -p ${p.network.sshPort} -L /tmp/support-ssh-test.sock:127.0.0.1:${p.guestPort} ${p.sshUser}@${p.network.guestIPv4}\nrm -f /tmp/support-ssh-test.sock`;
 const key=`\n\n# On the Mac: print the public key that Support uses.\nssh-keygen -y -f ${shellQuote(p.identityFile)}\n\n# Inside the VM: list the authorized keys for ${p.sshUser}.\ncat ~/.ssh/authorized_keys`;
 const vm=`\n\n# Inside the VM: check the SSH service and fail2ban.\nsudo systemctl status ssh --no-pager\nsudo fail2ban-client status sshd\nsudo fail2ban-client unban --all`;
 return mac+(kind==='auth'?key:'')+(kind==='refused'||kind==='closed'||kind==='timeout'?vm:'');
}
export class SSHForwardError extends Error{
 readonly help:string;readonly copy:string;
 constructor(readonly kind:SSHFailure,p:VMTransport){super(sshFailureDetail[kind]);this.help=sshFailureHelp[kind];this.copy=sshDiagnosticCommands(kind,p);}
}
// Fixed SSH options shared by diagnostics and the gateway.
export async function withForward<T>(p:VMTransport,fn:(socket:string,alive:()=>boolean)=>Promise<T>):Promise<T>{
 await privateDirectory(root());
 // Short path: sockaddr_un limits its length.
 const dir=await mkdtemp('/private/tmp/support-vm-');await privatePath(dir,true);
 const socket=join(dir,'s');let live=true,stderr='';
 const child=spawn('/usr/bin/ssh',sshArguments(p,socket),{env:environment,stdio:['ignore','ignore','pipe']});
 child.stderr!.setEncoding('utf8');child.stderr!.on('data',(data:string)=>{if(stderr.length<8192)stderr+=data.slice(0,8192-stderr.length);});
 const cancel=()=>{live=false;child.kill('SIGTERM');};cancellation.signal.addEventListener('abort',cancel,{once:true});
 const failed=()=>{live=false;};child.once('error',failed);child.once('exit',failed);
 try{
  let ready=false;for(let n=0;n<120&&live;n++){const stat=await lstat(socket).catch(()=>null);if(stat?.isSocket()&&stat.uid===process.getuid?.()&&!(stat.mode&0o077)){ready=true;break;}await delay(100);}
  if(!ready||!live){
   const timedOut=live;
   if(!timedOut)await Promise.race([new Promise(r=>child.stderr!.once('end',r)),delay(500)]);
   throw new SSHForwardError(classifySSHFailure(stderr,timedOut),p);
  }
  return await fn(socket,()=>live);
 }finally{cancellation.signal.removeEventListener('abort',cancel);live=false;if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(1000)]);if(child.exitCode===null)child.kill('SIGKILL');}await rm(dir,{recursive:true,force:true});}
}
export async function probeSupport(socket:string):Promise<'running'|'unavailable'|'different'> {
 return new Promise(resolve=>{
  let done=false;const finish=(value:'running'|'unavailable'|'different')=>{if(!done){done=true;clearTimeout(timer);resolve(value);}};
  const req=request({socketPath:socket,path:'/api/session',headers:{Host:'127.0.0.1:4173',Accept:'application/json'},agent:false},res=>{
   let text='';res.on('data',chunk=>{text+=chunk;if(text.length>8192){finish('different');req.destroy();}});
   res.on('end',()=>{try{const v=JSON.parse(text);finish(res.statusCode===200&&/^application\/json/.test(res.headers['content-type']??'')&&typeof v.authenticated==='boolean'&&typeof v.initialized==='boolean'?'running':'different');}catch{finish('different');}});
   res.on('error',()=>finish('unavailable'));
  });
  const timer=setTimeout(()=>{finish('unavailable');req.destroy();},5000);
  req.on('error',()=>finish('unavailable'));req.end();
 });
}
const vmOperations={platform:process.platform,processes,run,root,probeSupport,withForward,serve,hostIPs,vagrantPath,scan};
export type VMOperations=typeof vmOperations;
/** Returns the installed Support code folder for a module folder. */
export function installRoot(moduleDir:string){
 for(let dir=moduleDir;dir!==dirname(dir);dir=dirname(dir))if(dir.endsWith('.app'))return dir;
 return dirname(moduleDir);
}
/** Host OS operations. Replaceable in tests. */
export async function vmCommand(command:string,input:VMRequest,emit:(report:VMReport)=>void,overrides:Partial<VMOperations>={}){
 const ops={...vmOperations,...overrides};
 if(!['vm-discover','vm-check','vm-trust','vm-connect'].includes(command))throw Error('Unknown VM connection action.');
 input=validateVMRequest(input);
 if(ops.platform!=='darwin')throw Error('Open VM connection on the Mac that runs Vagrant/Tart.');
 if(process.getuid?.()===0)throw Error('Run Support as your Mac account, not as administrator.');
 cancellation=new AbortController();const cancel=()=>cancellation.abort();process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
 const report:VMReport={machines:[],checks:[],ready:false};
 const step=(check:Check)=>{report.checks=report.checks.filter(x=>x.id!==check.id).concat(check);emit({...report});};
 let stage='project';
 try{
  const project=await projectPath(input.project);
  const repositories=input.repositories,approved=input.shares??[];
  const supportPaths=[ops.root(),installRoot(dirname(fileURLToPath(import.meta.url)))];
  const realFolder=async(path:string)=>{const stat=await lstat(path);return await realpath(path)===path&&stat.isDirectory()&&stat.uid===process.getuid?.();};
  const checkApprovedShare=async(path:string)=>{validateApprovedShare(path,project,homedir(),supportPaths);if(!await realFolder(path))throw Error(`Approved share ${path} must be a real folder owned by your Mac account, not a symlink.`);};
  const checkRepositories=async()=>{
   for(const share of approved)await checkApprovedShare(share);
   if(!repositories)return;
   validateRepositoryRoot(repositories,project,homedir(),supportPaths);
   if(!await realFolder(repositories))throw Error('Select a real repositories folder owned by your Mac account, not a symlink.');
  };
  await checkRepositories();
  // Inspect before evaluating a potentially shared Vagrantfile on the Mac.
  try{checkHostConfigurationBoundary(await ops.processes(),repositories,approved);}
  catch(e){
   if(!(e instanceof UnapprovedSharesError))throw e;
   report.unapprovedShares=await Promise.all(e.shares.map(async s=>({...s,approvable:await checkApprovedShare(s.path).then(()=>true,()=>false)})));
   const blocked=report.unapprovedShares.some(s=>!s.approvable);
   step({id:'shares',title:'Running VM shares',state:'action',detail:e.message+'\n'+report.unapprovedShares.map(s=>`${s.path} · tag ${s.tag} · ${s.readOnly?'read-only':'read/write'} · VM ${s.vm}${s.approvable?'':' · cannot be approved'}`).join('\n'),help:(blocked?'Shares marked "cannot be approved" expose the Vagrantfile, Vagrant machine state, host credentials or Support files. Remove them from the VM configuration and restart the VM. ':'')+'The VM can write to every approved read/write share. Approve only folders that no host tool executes or loads configuration from. Example: Claude Code on the Mac loads hooks from .claude/settings.json in the folder where it starts.'});
   return;
  }
  const vagrant=await ops.vagrantPath();
  report.machines=machinesFromStatus(await ops.run(vagrant,['status','--machine-readable'],project));
  step({id:'project',title:'Vagrant project',state:'passed',detail:`${report.machines.length} VM${report.machines.length===1?'':'s'} found.`});
  if(command==='vm-discover')return;
  stage='machine';const machine=report.machines.find(m=>m.name===input.machine);report.machine=machine?.name;
  if(!machine)throw Error('Select a VM from this project.');
  if(machine.provider!=='tart')throw Error(`This VM uses ${machine.provider}. This connection flow supports vagrant-tart.`);
  if(machine.state!=='running')throw Error('This VM is stopped. Start it in Vagrant, then refresh this list.');
  const plugins=await ops.run(vagrant,['plugin','list'],project);
  if(!/^vagrant-tart \(1\.0\.0(?:,|\))/m.test(plugins))throw Error('This flow supports vagrant-tart 1.0.0. The installed plugin needs a compatibility check before connecting.');
  const idFile=join(project,'.vagrant','machines',machine.name,'tart','id');
  if(await realpath(idFile)!==idFile)throw Error('The Vagrant machine record must not be a link.');
  const vmName=(await readFile(idFile,'utf8')).trim();if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(vmName))throw Error('The selected VM has an unsupported Tart identifier.');
  step({id:'machine',title:'Running VM',state:'passed',detail:`${machine.name} · Tart ${vmName}`});
  stage='ssh';const ssh=parseSSH(await ops.run(vagrant,['ssh-config',machine.name],project));await privatePath(ssh.identity);if(repositories)validateRepositoryRoot(repositories,project,homedir(),[ssh.identity]);for(const share of approved)validateApprovedShare(share,project,homedir(),[ssh.identity]);
  step({id:'ssh',title:'SSH settings',state:'passed',detail:`${ssh.user}@${ssh.host}:${ssh.port} · private key discovered from Vagrant`});
  stage='isolation';let boundary:ReturnType<typeof checkIsolation>;
  try{boundary=checkIsolation(await ops.processes(),vmName,ssh,ops.hostIPs(),repositories,approved);}
  catch(e){step({id:stage,title:'Mac isolation',state:'action',detail:message(e),help:isolationHelp(ssh.port,repositories),copy:isolationSnippet(ssh.port,repositories)});step({id:'support',title:'Support in the VM',state:'blocked',detail:'Waiting for the isolation check. No SSH connection has been opened.'});return;}
  const recheck=async()=>{await checkRepositories();await privatePath(ssh.identity);const current=checkIsolation(await ops.processes(),vmName,ssh,ops.hostIPs(),repositories,approved);if(JSON.stringify(current)!==JSON.stringify(boundary))throw Error('The VM or its network policy changed. Recheck before connecting.');};
  await recheck();
  const running=directoryShares((await ops.processes()).find(p=>p.pid===boundary.pid)!.args!);
  step({id:'isolation',title:'Mac isolation',state:'passed',detail:(repositories||running.length?'Tart arguments checked. Selected and approved shares remain exceptions.':'Tart arguments checked. No shared folders, extra disks, GUI or audio. Clipboard sharing is allowed.')+' Support does not check or enforce the VM network.'});
  const extra=running.filter(s=>s.path!==repositories);
  if(extra.length)step({id:'shares',title:'Approved extra shares',state:'passed',detail:extra.map(s=>`${s.path} · tag ${s.tag} · ${s.readOnly?'read-only':'read/write'}`).join('\n'),help:'The VM can write to every read/write share. Host tools must not execute or load configuration from these folders. Remove an approval in this window to block the VM again.'});
  if(repositories){
   const share=running.find(s=>s.path===repositories)!;
   step({id:'repositories',title:'Shared repositories · read/write',state:'passed',detail:repositories,help:`This folder, including Git metadata, is writable from the VM. Use separate checkouts or worktrees for simultaneous edits. Keep host-executed configuration outside it. If the share is not mounted in Ubuntu, use the commands below, then set Support's repository path to /workspace/host${share.name?'/'+share.name:''}.`,copy:`# Inside Ubuntu only; skip if Vagrant already mounts the share.\nsudo mkdir -p /workspace/host\nsudo mount -t virtiofs ${share.tag} /workspace/host`});
  }
  stage='identity';await privateDirectory(ops.root());
  const keyId=createHash('sha256').update(JSON.stringify({project,machine:machine.name,vmName,ssh})).digest('hex').slice(0,32);
  const keyDir=join(ops.root(),'vm-'+keyId);await privateDirectory(keyDir);const knownHosts=join(keyDir,'known_hosts');
  const key=await ops.scan(ssh);await recheck();
  let saved='';try{await privatePath(knownHosts);saved=await readFile(knownHosts,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(saved!==key.line){
   if(command==='vm-trust'&&input.fingerprint===key.fingerprint){await replacePrivateFile(knownHosts,key.line);}
   else{report.fingerprint=key.fingerprint;step({id:'identity',title:saved?'VM identity changed':'Verify this VM once',state:'action',detail:key.fingerprint,help:(saved?'The saved SSH key no longer matches. Only replace it if you know why the VM identity changed. ':'')+'Compare this fingerprint with the VM console. Trust it only if they match; an SSH scan alone does not establish identity.',copy:'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256'});step({id:'support',title:'Support in the VM',state:'blocked',detail:'Waiting for you to verify the VM fingerprint.'});return;}
  }
  step({id:'identity',title:'VM identity',state:'passed',detail:'SSH host key matches the identity saved on this Mac.'});
  stage='support';await recheck();const p=profile(ssh,knownHosts,input.port??4173);
  await ops.withForward(p,async(socket,alive)=>{
   const status=await ops.probeSupport(socket);await recheck();
   if(status!=='running'){step({id:'support',title:status==='different'?'Unexpected service':'Support is not responding',state:'action',detail:status==='different'?'Port 4173 does not return the expected Support API. Check which service uses it inside the VM.':'SSH works, but Support is not responding on 127.0.0.1:4173 inside the VM. It may be missing or stopped.',help:'If Support is already installed, start it in that checkout with npm start. Otherwise use the commands below inside Ubuntu. Installing Claude or Codex alone does not install Support. If Support already runs, check that the VM SSH service allows TCP forwarding: sudo sshd -T | grep -Ei "allowtcpforwarding|disableforwarding" must print allowtcpforwarding yes or local, and disableforwarding no. Recheck after the service starts.',copy:installCommands});return;}
   step({id:'support',title:'Support in the VM',state:'passed',detail:'Support is running on the VM loopback address. Your Vault and work sessions stay in the VM.'});
   report.ready=true;emit({...report});
   if(command==='vm-connect'){
    stage='connection';await recheck();await ops.serve(p,socket,alive,recheck,url=>{report.url=url;emit({...report});},createHash('sha256').update(keyId+'\n'+key.fingerprint).digest('hex').slice(0,32));
   }
  });
 }catch(e){report.ready=false;delete report.url;step({id:stage,title:({project:'Check the Vagrant project',machine:'Select a running VM',ssh:'SSH settings',isolation:'Mac isolation',identity:'VM identity',support:'Support in the VM',connection:'Connection stopped'} as Record<string,string>)[stage],state:'action',detail:message(e),...(stage==='project'?{help:'Choose a host-owned project containing Vagrantfile. Vagrant reads and executes this Ruby file on your Mac. Disable guest shares before using a project that was writable from the VM.'}:{}),...(e instanceof SSHForwardError?{title:'SSH connection',help:e.help,copy:e.copy}:{})});}finally{process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
}
function message(error:unknown){
 // Never echo execFile stderr.
 if(error&&typeof error==='object'&&'cmd' in error)return 'A local check failed or timed out. Confirm Vagrant/Tart is available and the VM is running, then Recheck.';
 return error instanceof Error?error.message.slice(0,2000):'The connection check failed.';
}
async function serve(p:VMTransport,socket:string,alive:()=>boolean,recheck:()=>Promise<void>,connected:(url:string)=>void,connectionId:string){
 const parent=process.ppid;
 const key=randomBytes(32),keyPath=join(root(),`gateway-key-${p.port}`);let written=false,healthy=false;
 const server=await createGateway({port:p.port,guestPort:p.guestPort,socketPath:socket,publicDirectory:resolve(dirname(fileURLToPath(import.meta.url)),'../public'),proofKey:key,connectionId,healthy:()=>healthy&&alive()});
 let stop!:()=>void;const ended=new Promise<void>(r=>stop=r);let failure:unknown;
 const onSignal=()=>{healthy=false;stop();};let timer:NodeJS.Timeout|undefined;
 try{
  // Listen before creating a key.
  await new Promise<void>((r,j)=>{server.once('error',j);server.listen(p.port,'127.0.0.1',r);});
  await replacePrivateFile(keyPath,key.toString('hex'));written=true;healthy=true;
  process.once('SIGTERM',onSignal);process.once('SIGINT',onSignal);
  const monitor=async()=>{try{if(process.ppid!==parent||!alive()||cancellation.signal.aborted)throw Error('SSH disconnected.');await recheck();if(healthy)timer=setTimeout(()=>void monitor(),2000);}catch(e){healthy=false;failure=e;server.closeAllConnections();stop();}};
  connected(`http://127.0.0.1:${p.port}`);timer=setTimeout(()=>void monitor(),2000);await ended;
  if(failure)throw failure;
 }finally{
  healthy=false;if(timer)clearTimeout(timer);process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);if(written)await unlink(keyPath).catch(()=>{});server.closeAllConnections();await new Promise<void>(r=>{if(server.listening)server.close(()=>r());else r();});
 }
}

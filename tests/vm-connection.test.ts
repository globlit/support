import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {machinesFromStatus,parseSSH,checkIsolation,checkHostConfigurationBoundary,validateProcessSnapshot,validateRepositoryRoot,directoryShares,isolationSnippet,type ProcessRecord} from '../host/vm-discovery.js';
import {parseHostKey,probeSupport,validateVMRequest,vmCommand,type VMReport,type VMOperations} from '../host/vm-connection.js';
const ssh={host:'192.0.2.20',port:22,user:'vagrant',identity:'/Users/operator/Project with spaces/.vagrant/key'};
const allow='in proto tcp @host port 22,out proto tcp 198.51.100.10/32 port 443';
const block='in 0.0.0.0/0,out 0.0.0.0/0,out @host';
function processes():ProcessRecord[]{return [
 {pid:100,ppid:1,executable:'/opt/homebrew/bin/tart',args:['/opt/homebrew/bin/tart','run','support-lab','--no-graphics','--no-audio','--no-clipboard',`--net-softnet-allow=${allow}`,`--net-softnet-block=${block}`]},
 {pid:101,ppid:100,executable:'/opt/homebrew/bin/softnet',args:['/opt/homebrew/bin/softnet','--vm-fd','0','--vm-mac-address','aa:bb:cc:dd:ee:ff','--allow',allow,'--block',block]}
];}
const status='1,lab,provider-name,tart\n1,other,provider-name,virtualbox\n1,lab,state,running\n1,other,state,poweroff\n';
function sshConfig(identity=ssh.identity){return `Host lab\n HostName ${ssh.host}\n User ${ssh.user}\n Port 22\n IdentityFile "${identity}"\n StrictHostKeyChecking no\n UserKnownHostsFile /dev/null\n ProxyCommand dangerous\n ForwardAgent yes\n`;}
const keyBlob=Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),Buffer.alloc(32,7)]);
const keyText=`${ssh.host} ssh-ed25519 ${keyBlob.toString('base64')}\n`;
test('machine discovery retains every VM and rejects unsafe target names',()=>{
 assert.deepEqual(machinesFromStatus(status),[{name:'lab',provider:'tart',state:'running'},{name:'other',provider:'virtualbox',state:'poweroff'}]);
 assert.throws(()=>machinesFromStatus('1,../../escape,state,running'));
 assert.equal(machinesFromStatus('1,,ui,information,no VM').length,0);
});
test('SSH discovery retains exact spaced key path but never dangerous Vagrant SSH options',()=>{
 assert.deepEqual(parseSSH(sshConfig()),ssh);
 for(const bad of [sshConfig()+' HostName 127.0.0.1',sshConfig().replace(ssh.host,'localhost'),sshConfig().replace(ssh.host,'127.0.0.1'),sshConfig().replace('Port 22','Port 70000'),sshConfig().replace('User vagrant','User --exec'),sshConfig().replace(ssh.identity,'%d/.ssh/key'),sshConfig()+'\nHost other'])assert.throws(()=>parseSSH(bad));
});
test('runtime isolation accepts only a matched Tart VM and its real Softnet policy',()=>{
 const result=checkIsolation(processes(),'support-lab',ssh,['192.168.1.8']);assert.equal(result.pid,100);assert.equal(result.softnetPid,101);
 assert.throws(()=>checkIsolation(processes(),'other-vm',ssh,[]));
 assert.throws(()=>checkIsolation(processes(),'support-lab',ssh,['198.51.100.10']));
 assert.throws(()=>checkIsolation(processes(),'support-lab',ssh,[ssh.host]));
 const unknown=processes();unknown[1].args=null;assert.throws(()=>checkIsolation(unknown,'support-lab',ssh,[]));
 const orphan=processes();orphan[1].ppid=500;assert.throws(()=>checkIsolation(orphan,'support-lab',ssh,[]));
});
test('all filesystem and network bypass options are refused, including unknown future options',()=>{
 for(const arg of ['--dir=/Users/me','--disk=/dev/disk0','--rosetta=host','--net-host','--net-bridged=en0','--net-fd=3','--net-softnet-control-fd=3','--net-softnet-expose=4173:4173','--vnc','--clipboard','--future-device']){
  const ps=processes();ps[0].args!.push(arg);assert.throws(()=>checkIsolation(ps,'support-lab',ssh,[]),arg);
 }
 const ps=processes();ps[1].args!.push('--control-fd','1');assert.throws(()=>checkIsolation(ps,'support-lab',ssh,[]));
 const defaultNAT=processes();defaultNAT[0].args=defaultNAT[0].args!.slice(0,6);assert.throws(()=>checkIsolation(defaultNAT,'support-lab',ssh,[]));
 const unreadable=processes();unreadable[0].args=null;assert.throws(()=>checkHostConfigurationBoundary(unreadable));
});
test('egress cannot admit broad networks, Mac services, inbound connections or policy overrides',()=>{
 for(const extra of ['out 0.0.0.0/0','out proto tcp 127.0.0.1/32 port 443','out proto tcp 169.254.169.254/32 port 80','out proto tcp 192.168.1.8/32 port 443','out proto tcp @host port 443','out proto tcp 198.51.100.10/24 port 443','out proto tcp 198.51.100.10/32 port 0','in proto tcp port 4173','out @peers','out proto tcp 198.51.100.10/32 port 443']){
  const ps=processes();ps[0].args![6]=`--net-softnet-allow=${allow},${extra}`;ps[1].args![6]=`${allow},${extra}`;assert.throws(()=>checkIsolation(ps,'support-lab',ssh,['192.168.1.8']),extra);
 }
 const ps=processes();ps[1].args![6]='in @host';assert.throws(()=>checkIsolation(ps,'support-lab',ssh,[]));
});
test('process snapshots and native requests are bounded and strict',()=>{
 assert.equal(validateProcessSnapshot(processes()).length,2);
 assert.deepEqual(validateProcessSnapshot([{pid:5,ppid:1,executable:'/usr/bin/other'}]),[{pid:5,ppid:1,executable:'/usr/bin/other',args:null}]);
 assert.throws(()=>checkHostConfigurationBoundary(validateProcessSnapshot([{pid:5,ppid:1,executable:'/opt/homebrew/bin/tart'}])));
 for(const data of [[...processes(),processes()[0]],[{pid:1,ppid:0,executable:'tart',args:'fake'}],Array(4097).fill({})])assert.throws(()=>validateProcessSnapshot(data));
 assert.deepEqual(validateVMRequest({project:'/Users/operator/VM',machine:'lab',port:4174}),{project:'/Users/operator/VM',machine:'lab',port:4174});
 for(const v of [{project:'relative'}, {project:'/tmp/VM',machine:'--help'}, {project:'/tmp/VM',command:'shell'}, {project:'/tmp/VM',port:0},{project:'/tmp/VM',fingerprint:'anything'}])assert.throws(()=>validateVMRequest(v));
});
test('host key pins use the correct SSH host representation and fingerprint',()=>{
 const key=parseHostKey(keyText,ssh.host,22);assert.match(key.fingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);assert.ok(key.line.startsWith(ssh.host+' '));
 assert.ok(parseHostKey(keyText,ssh.host,2222).line.startsWith(`[${ssh.host}]:2222 `));
 for(const text of [keyText+keyText,keyText.replace('ssh-ed25519','ssh-rsa'),'fake ssh-ed25519 AAAA\n'])assert.throws(()=>parseHostKey(text,ssh.host,22));
});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'support-vm-wizard-')),project=join(root,'project with spaces'),state=join(root,'state'),key=join(root,'key');
 await mkdir(join(project,'.vagrant','machines','lab','tart'),{recursive:true});await writeFile(join(project,'Vagrantfile'),'# test host-owned configuration',{mode:0o600});await writeFile(join(project,'.vagrant','machines','lab','tart','id'),'support-lab');await writeFile(key,'fixture',{mode:0o600});
 const reports:VMReport[]=[],calls:string[]=[];let ps=processes(),service:'running'|'unavailable'|'different'='running';
 const ops:Partial<VMOperations>={platform:'darwin',root:()=>state,processes:async()=>ps,hostIPs:()=>['192.168.1.8'],vagrantPath:async()=>'/fixture/vagrant',run:async(_binary,args)=>{calls.push(args.join(' '));if(args[0]==='status')return status;if(args[0]==='plugin')return 'vagrant-tart (1.0.0, global)';if(args[0]==='ssh-config')return sshConfig(key);throw Error('Unexpected local command');},scan:async()=>{calls.push('scan');return parseHostKey(keyText,ssh.host,22);},withForward:async(_p,fn)=>{calls.push('forward');return fn('/test/socket',()=>true);},probeSupport:async()=>{calls.push('probe');return service;},serve:async(_p,_socket,_alive,_recheck,connected)=>{calls.push('serve');connected('http://127.0.0.1:4173');}};
 return {root,project,state,calls,reports,ops,setProcesses:(value:ProcessRecord[])=>ps=value,setService:(value:typeof service)=>service=value,async command(command:string,fingerprint?:string,repositories?:string){reports.length=0;await vmCommand(command,{project,machine:'lab',fingerprint,repositories},r=>reports.push(structuredClone(r)),ops);return reports.at(-1)!;},async done(){await rm(root,{recursive:true,force:true});}};
}
test('full wizard discovers, verifies identity, probes Support and rechecks before explicit connect',async()=>{
 const f=await fixture();try{
  const discovery=await f.command('vm-discover');assert.equal(discovery.machines.length,2);assert.deepEqual(f.calls,['status --machine-readable']);
  const check=await f.command('vm-check');assert.ok(check.fingerprint);assert.equal(check.ready,false);assert.ok(!f.calls.includes('forward'));
  const trust=await f.command('vm-trust',check.fingerprint);assert.equal(trust.ready,true);assert.ok(f.calls.includes('probe'));assert.ok(!f.calls.includes('serve'));
  const connected=await f.command('vm-connect');assert.equal(connected.url,'http://127.0.0.1:4173');assert.equal(f.calls.at(-1),'serve');
  const dirs=await readdir(f.state);assert.equal(dirs.length,1);assert.match(await readFile(join(f.state,dirs[0],'known_hosts'),'utf8'),/ssh-ed25519/);
 }finally{await f.done();}
});
test('unsafe shares stop before Vagrant executes; unsafe networking stops before any SSH traffic',async()=>{
 const f=await fixture();try{
  const shared=processes();shared[0].args!.push('--dir=/Users/operator');f.setProcesses(shared);
  assert.equal((await f.command('vm-check')).ready,false);assert.equal(f.calls.length,0);
  const nat=processes();nat[0].args=nat[0].args!.slice(0,6);f.setProcesses(nat);
  const result=await f.command('vm-check');assert.ok(result.checks.find(c=>c.id==='isolation')?.copy);assert.ok(!f.calls.includes('scan'));assert.ok(!f.calls.includes('forward'));assert.equal(result.ready,false);
 }finally{await f.done();}
});
test('missing service and wrong service cannot enable Connect; checks do not install or start anything',async()=>{
 const f=await fixture();try{
  const check=await f.command('vm-check');await f.command('vm-trust',check.fingerprint);
  for(const state of ['unavailable','different'] as const){f.setService(state);const result=await f.command('vm-connect');assert.equal(result.ready,false);assert.ok(!result.url);assert.ok(!f.calls.includes('serve'));assert.ok(result.checks.find(c=>c.id==='support')?.help);}
  assert.ok(f.calls.every(c=>/^(status|plugin|ssh-config|scan|forward|probe)/.test(c)));
 }finally{await f.done();}
});
test('a changed host key needs a fresh explicit fingerprint match and cannot silently overwrite the pin',async()=>{
 const f=await fixture();try{
  const first=await f.command('vm-check');await f.command('vm-trust',first.fingerprint);f.calls.length=0;
  const otherBlob=Buffer.from(keyBlob);otherBlob[50]=99;const other=parseHostKey(`${ssh.host} ssh-ed25519 ${otherBlob.toString('base64')}`,ssh.host,22);f.ops.scan=async()=>other;
  const changed=await f.command('vm-connect');assert.equal(changed.fingerprint,other.fingerprint);assert.equal(changed.ready,false);assert.ok(!f.calls.includes('forward'));
  const stale=await f.command('vm-trust',first.fingerprint);assert.equal(stale.ready,false);
  assert.equal((await f.command('vm-trust',other.fingerprint)).ready,true);
 }finally{await f.done();}
});
test('runtime changes between scan and Support check stop connection before forwarding',async()=>{
 const f=await fixture();try{
  f.ops.scan=async()=>{const ps=processes();ps[0].args!.push('--clipboard');f.setProcesses(ps);return parseHostKey(keyText,ssh.host,22);};
  const result=await f.command('vm-check');assert.equal(result.ready,false);assert.ok(!f.calls.includes('forward'));
 }finally{await f.done();}
});
test('service probe accepts only a bounded Support JSON response and never follows redirects or executes HTML',async()=>{
 const root=await mkdtemp(join(tmpdir(),'support-probe-')),socket=join(root,'s');let mode='ok';
 const server=createServer((req,res)=>{assert.equal(req.url,'/api/session');assert.equal(req.headers.host,'127.0.0.1:4173');if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:22'});res.end();}else if(mode==='html'){res.setHeader('Content-Type','text/html');res.end('<script>bad()</script>');}else {res.setHeader('Content-Type','application/json');res.end(mode==='large'?'x'.repeat(9000):JSON.stringify({authenticated:false,initialized:true}));}});
 await new Promise<void>(r=>server.listen(socket,r));
 try{assert.equal(await probeSupport(socket),'running');for(const value of ['redirect','html','large']){mode=value;assert.equal(await probeSupport(socket),'different');}}
 finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
 assert.equal(await probeSupport(socket),'unavailable');
});

test('the writable repository exception is exact and cannot include host control paths',()=>{
 const repo='/Users/operator/project/repos',project='/Users/operator/project',home='/Users/operator';
 validateRepositoryRoot(repo,project,home,['/Applications/Support Companion.app']);
 for(const path of [home,project,'/Users','/','/Users/operator/.ssh','/Users/operator/Library/repos','/Applications/Support Companion.app','/Users/operator/project/../repos'])assert.throws(()=>validateRepositoryRoot(path,project,home));
 assert.throws(()=>validateRepositoryRoot(repo,project,home,[repo+'/private_key']));
 const ps=processes();ps[0].args!.push('--dir='+repo+':tag=support-repos');
 checkHostConfigurationBoundary(ps,repo);checkIsolation(ps,'support-lab',ssh,[],repo);
 assert.throws(()=>checkHostConfigurationBoundary(ps,repo+'/child'));
 assert.throws(()=>checkIsolation(ps,'support-lab',ssh,[]));
 const readOnly=processes();readOnly[0].args!.push('--dir='+repo+':ro');assert.throws(()=>checkIsolation(readOnly,'support-lab',ssh,[],repo));
 const another=processes();another[0].args!.push('--dir='+repo,'--dir=/Users/operator');assert.throws(()=>checkIsolation(another,'support-lab',ssh,[],repo));
 assert.throws(()=>checkIsolation(processes(),'support-lab',ssh,[],repo));
 assert.deepEqual(directoryShares(['tart','run','lab','--dir',`repos:${repo}:tag=repos`]),[{path:repo,name:'repos',tag:'repos',readOnly:false}]);
 for(const arg of ['--dir=~/repos','--dir=/Users/operator/repos:tag=bad;command','--dir=/Users/operator/repos:rw,ro','--dir=/Users/operator/repos:tag=a,tag=b'])assert.throws(()=>directoryShares([arg]));
 assert.ok(isolationSnippet(22,repo+"/#{unsafe}'").includes("#{unsafe}\\'"));
});
test('wizard allows only the selected shared root and still checks all network and SSH boundaries',async()=>{
 const f=await fixture();try{
  const repositories=join(f.project,'repos');await mkdir(repositories);
  const ps=processes();ps[0].args!.push('--dir='+repositories+':tag=support-repos');f.setProcesses(ps);
  const check=await f.command('vm-check',undefined,repositories);assert.ok(check.fingerprint);
  const ready=await f.command('vm-trust',check.fingerprint,repositories);assert.equal(ready.ready,true);
  assert.equal(ready.checks.find(c=>c.id==='repositories')?.detail,repositories);
  const denied=await f.command('vm-connect',undefined,f.project);assert.equal(denied.ready,false);assert.ok(!f.calls.includes('serve'));
 }finally{await f.done();}
});

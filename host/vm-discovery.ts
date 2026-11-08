import {isIP} from 'node:net';
import {basename,resolve,relative,parse,join} from 'node:path';
import {checkAddress} from './managed-network.js';

export type Machine={name:string;provider:string;state:string};
export type SSHSettings={host:string;port:number;user:string;identity:string};
export type ProcessRecord={pid:number;ppid:number;executable:string;args:string[]|null};
export type Check={id:string;title:string;state:'passed'|'action'|'blocked';detail:string;help?:string;copy?:string};
export function machinesFromStatus(text:string):Machine[]{
 const machines=new Map<string,Machine>();
 for(const line of text.split('\n')){
  const [,name,field,...parts]=line.trim().split(',');
  if(!name||!['provider-name','state'].includes(field))continue;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name))throw Error('Vagrant returned an unsupported machine name.');
  const item=machines.get(name)??{name,provider:'',state:''};
  const value=parts.join(',');if(!/^[a-z0-9_-]{1,64}$/.test(value))throw Error('Invalid Vagrant status.');
  if(field==='provider-name')item.provider=value;else item.state=value;
  machines.set(name,item);
 }
 return [...machines.values()];
}
/** Vagrant's SSH output is data, never a config passed through to ssh. */
export function parseSSH(text:string):SSHSettings{
 const allowed=new Set(['hostname','port','user','identityfile']),values=new Map<string,string>();let hosts=0;
 for(const line of text.split('\n')){
  const match=line.trim().match(/^(\S+)\s+(.+)$/);if(!match)continue;
  const key=match[1].toLowerCase();if(key==='host')hosts++;
  if(!allowed.has(key))continue;
  if(values.has(key))throw Error('Vagrant returned ambiguous SSH settings.');
  let value=match[2].trim();if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1);
  if(/[\r\n\0"\\]/.test(value))throw Error('Invalid SSH setting.');
  values.set(key,value);
 }
 const result={host:values.get('hostname')??'',port:Number(values.get('port')),user:values.get('user')??'',identity:values.get('identityfile')??''};
 if(hosts!==1||isIP(result.host)!==4||!Number.isInteger(result.port)||result.port<1||result.port>65535||!/^[_a-zA-Z][_a-zA-Z0-9-]{0,63}$/.test(result.user)||!result.identity.startsWith('/')||result.identity.includes('%'))throw Error('Vagrant must supply one IPv4 SSH destination, user, port and absolute private-key path.');
 checkAddress(result.host,true);
 return result;
}
function options(args:string[],flags:string[],values:string[]){
 const out=new Map<string,string>();const positional:string[]=[];
 for(let i=0;i<args.length;i++){
  const arg=args[i];if(!arg.startsWith('-')){positional.push(arg);continue;}
  const equal=arg.indexOf('='),key=equal<0?arg:arg.slice(0,equal);
  if(out.has(key))throw Error(`Repeated runtime option: ${key}`);
  if(flags.includes(key)&&equal<0){out.set(key,'');continue;}
  if(values.includes(key)){const value=equal<0?args[++i]:arg.slice(equal+1);if(!value||value.startsWith('-'))throw Error(`Missing value for ${key}`);out.set(key,value);continue;}
  throw Error(`Unsupported runtime option: ${key}. Remove unapproved shares, extra devices and VNC from this VM.`);
 }
 return {out,positional};
}
export function validateProcessSnapshot(value:unknown):ProcessRecord[]{
 if(!Array.isArray(value)||value.length>4096)throw Error('Could not inspect the Mac process table.');
 const seen=new Set<number>();
 for(const row of value){if(!row||!Number.isSafeInteger(row.pid)||row.pid<1||seen.has(row.pid)||!Number.isSafeInteger(row.ppid)||row.ppid<0||typeof row.executable!=='string'||row.executable.length>4096||row.args!=null&&(!Array.isArray(row.args)||row.args.length>512||row.args.some((a:unknown)=>typeof a!=='string'||a.length>16384)))throw Error('Invalid Mac process snapshot.');seen.add(row.pid);}
 // Normalize missing argv fields from Swift.
 return value.map(row=>({...row,args:row.args??null}));
}
export type RepositoryShare={path:string;name?:string;tag:string;readOnly:boolean};
export function directoryShares(args:string[]):RepositoryShare[]{
 const result:RepositoryShare[]=[];
 for(let i=0;i<args.length;i++){
  if(!/^--dir(?:=|$)/.test(args[i]))continue;
  const value=args[i]==='--dir'?args[++i]:args[i].slice(6);
  const match=value?.match(/^(?:([a-zA-Z0-9_.-]{1,64}):)?(\/[^:]+)(?::([^:]+))?$/);
  if(!match)throw Error('Use an absolute host path for the Tart repository share.');
  let readOnly=false,tag='com.apple.virtio-fs';const seen=new Set<string>();
  for(const option of match[3]?.split(',')??[]){const key=option.split('=')[0];if(seen.has(key))throw Error('Duplicate share option.');seen.add(key);
   if(option==='ro')readOnly=true;
   else if(/^tag=[a-zA-Z0-9_.-]{1,64}$/.test(option))tag=option.slice(4);
   else throw Error('Unsupported Tart share option.');
  }
  result.push({path:match[2],name:match[1],tag,readOnly});
 }
 return result;
}
const within=(root:string,path:string)=>path===root||(!relative(root,path).startsWith('..')&&!relative(root,path).startsWith('/'));
const broadRoots=(path:string,home:string)=>[parse(path).root,home,'/Users','/home','/Volumes','/tmp','/private/tmp'];
const protectedRoots=(home:string,protectedPaths:string[])=>['/Applications','/System','/Library','/usr','/bin','/sbin','/etc','/private/etc','/var','/private/var',join(home,'Library'),join(home,'.ssh'),join(home,'.vagrant.d'),join(home,'.config'),...protectedPaths];
/** Validates the single writable repositories folder. */
export function validateRepositoryRoot(path:string,project:string,home:string,protectedPaths:string[]=[]){
 if(!path.startsWith('/')||resolve(path)!==path||/[\0\r\n:]/.test(path)||path.split('/').some(part=>part.startsWith('.'))||broadRoots(path,home).includes(path))throw Error('Choose a narrow, real repositories folder, not your home, a system folder or a hidden settings folder.');
 if(within(path,project)||protectedRoots(home,protectedPaths).some(p=>within(path,p)||within(p,path)))throw Error('The repositories share overlaps Vagrant configuration, host credentials or Support files. Choose a separate folder.');
}
/** Validates an extra share approved by the user. */
export function validateApprovedShare(path:string,project:string,home:string,protectedPaths:string[]=[]){
 const underHome=relative(home,path);
 if(!path.startsWith('/')||resolve(path)!==path||/[\0\r\n:]/.test(path)||broadRoots(path,home).includes(path)||within(home,path)&&underHome.split('/')[0].startsWith('.'))throw Error(`Approved share ${path} must be a narrow folder, not your home, a system folder or a hidden folder in your home.`);
 if(within(path,project)||protectedRoots(home,[join(project,'Vagrantfile'),join(project,'.vagrant'),...protectedPaths]).some(p=>within(path,p)||within(p,path)))throw Error(`Approved share ${path} overlaps the Vagrantfile, Vagrant machine state, host credentials or Support files. Remove that share from the VM.`);
}
export type UnapprovedShare=RepositoryShare&{vm:string};
export class UnapprovedSharesError extends Error{
 constructor(readonly shares:UnapprovedShare[]){super(`A running Tart VM shares ${shares.length} folder${shares.length===1?'':'s'} not approved here. Vagrant is not run until every share is approved or removed.`);}
}
/** Run before Vagrant evaluates Ruby. */
export function checkHostConfigurationBoundary(processes:ProcessRecord[],repositories?:string,approved:string[]=[]){
 const allowed=new Set(repositories?[repositories,...approved]:approved),unapproved:UnapprovedShare[]=[];
 for(const p of processes.filter(p=>basename(p.executable)==='tart')){
  if(!p.args)throw Error('Cannot read a running Tart process. Close other Tart commands and retry; Support cannot verify the folder boundary.');
  if(!p.args.includes('run'))continue;
  if(p.args.some(a=>/^--(disk|rosetta)(=|$)/.test(a)))throw Error('A running Tart VM exposes an extra host disk or Rosetta share. Remove it and restart that VM before continuing.');
  const vm=p.args[2]&&!p.args[2].startsWith('-')?p.args[2]:'unknown';
  for(const share of directoryShares(p.args))if(!allowed.has(share.path))unapproved.push({...share,vm});
 }
 if(unapproved.length)throw new UnapprovedSharesError(unapproved);
}
const netValues=new Set(['--net-bridged','--net-softnet-allow','--net-softnet-block','--net-softnet-expose']);
/** Splits Tart arguments into network and other options. */
function splitTartArguments(args:string[]){
 const rest:string[]=[],network:string[]=[];
 for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--dir'){i++;continue;}
  if(arg.startsWith('--dir='))continue;
  if(arg.startsWith('--net-')){network.push(arg);if(!arg.includes('=')&&netValues.has(arg)&&args[i+1]!==undefined)network.push(args[++i]);continue;}
  rest.push(arg);
 }
 return {rest,network};
}
/** Checks the running Tart VM for shares, devices, and host channels. */
export function checkIsolation(processes:ProcessRecord[],vmName:string,ssh:SSHSettings,hostIPs:string[],repositories?:string,approved:string[]=[]):{pid:number;policy:string}{
 checkHostConfigurationBoundary(processes,repositories,approved);
 const candidates=processes.filter(p=>basename(p.executable)==='tart'&&p.args?.[1]==='run'&&p.args.includes(vmName));
 if(candidates.length!==1)throw Error('Cannot match this Vagrant VM to one running Tart process. Start it in Vagrant, then recheck.');
 const tart=candidates[0],{rest,network}=splitTartArguments(tart.args!.slice(2)),config=options(rest,['--no-graphics','--no-audio','--no-clipboard'],[]);
 if(config.positional.length!==1||config.positional[0]!==vmName)throw Error('Unexpected Tart launch arguments.');
 const shares=directoryShares(tart.args!),share=repositories?shares.find(s=>s.path===repositories):undefined;
 if(repositories&&(!share||share.readOnly))throw Error('The selected repositories folder is not exposed read/write by this VM. Configure the Tart volume shown below, restart the VM, then Recheck.');
 for(const flag of ['--no-graphics','--no-audio'])if(!config.out.has(flag))throw Error('Disable the Tart GUI and audio in this Vagrant machine, then restart it.');
 checkAddress(ssh.host,true,hostIPs);
 return {pid:tart.pid,policy:JSON.stringify({vmName,ssh,network,clipboard:!config.out.has('--no-clipboard'),shares:shares.map(s=>JSON.stringify(s)).sort()})};
}
export function isolationHelp(port:number,repositories?:string){return `Keep the Vagrant project, SSH keys and Support app outside VM shares. Disable default /vagrant and every synced folder not approved in this window. ${repositories?'The selected repositories folder must be shared read/write.':'Select a repositories folder in this window if you need a writable share.'} Disable SSH agent forwarding.\n\nInside this machine's Tart provider block (named tart below), use these options. Restart the VM yourself, then Recheck. Support does not check or enforce the VM network: configure network isolation yourself.`;}
export function isolationSnippet(port:number,repositories?:string){
 const volume=repositories ? "'"+(repositories+':tag=support-repos').replaceAll('\\','\\\\').replaceAll("'","\\'")+"'" : '';
 return `tart.gui = false\ntart.audio = false\ntart.volumes = [${volume}]\n# Outside the provider block, disable other synced folders:\n# config.vm.synced_folder ".", "/vagrant", disabled: true\n# config.ssh.forward_agent = false`;
}

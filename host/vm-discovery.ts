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
  throw Error(`Unsupported runtime option: ${key}. Remove unapproved shares, extra devices, clipboard, VNC and alternate networking from this VM.`);
 }
 return {out,positional};
}
export function validateProcessSnapshot(value:unknown):ProcessRecord[]{
 if(!Array.isArray(value)||value.length>4096)throw Error('Could not inspect the Mac process table.');
 const seen=new Set<number>();
 for(const row of value){if(!row||!Number.isSafeInteger(row.pid)||row.pid<1||seen.has(row.pid)||!Number.isSafeInteger(row.ppid)||row.ppid<0||typeof row.executable!=='string'||row.executable.length>4096||row.args!=null&&(!Array.isArray(row.args)||row.args.length>512||row.args.some((a:unknown)=>typeof a!=='string'||a.length>16384)))throw Error('Invalid Mac process snapshot.');seen.add(row.pid);}
 // Swift Codable omits nil optional fields; normalize unreadable/not-collected argv.
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
/** The user grants exactly one writable repository root, never host control/configuration. */
export function validateRepositoryRoot(path:string,project:string,home:string,protectedPaths:string[]=[]){
 if(!path.startsWith('/')||resolve(path)!==path||/[\0\r\n:]/.test(path)||path.split('/').some(part=>part.startsWith('.'))||[parse(path).root,home,'/Users','/home','/Volumes','/tmp','/private/tmp'].includes(path))throw Error('Choose a narrow, real repositories folder, not your home, a system folder or a hidden settings folder.');
 const protectedRoots=['/Applications','/System','/Library','/usr','/bin','/sbin','/etc','/private/etc','/var','/private/var',join(home,'Library'),join(home,'.ssh'),join(home,'.vagrant.d'),join(home,'.config'),...protectedPaths];
 if(within(path,project)||protectedRoots.some(p=>within(path,p)||within(p,path)))throw Error('The repositories share overlaps Vagrant configuration, host credentials or Support files. Choose a separate folder.');
}
/** Run before Vagrant evaluates Ruby. The selected writable exception may not include host config. */
export function checkHostConfigurationBoundary(processes:ProcessRecord[],repositories?:string){
 for(const p of processes.filter(p=>basename(p.executable)==='tart')){
  if(!p.args)throw Error('Cannot read a running Tart process. Close other Tart commands and retry; Support cannot verify the folder boundary.');
  if(!p.args.includes('run'))continue;
  if(p.args.some(a=>/^--(disk|rosetta)(=|$)/.test(a)))throw Error('A running Tart VM exposes an extra host disk or Rosetta share. Remove it and restart that VM before continuing.');
  const shares=directoryShares(p.args);
  if(shares.length>1||shares.some(share=>!repositories||share.path!==repositories))throw Error('A running Tart VM shares a folder that has not been selected here. Select your repositories folder, or remove the other shares and restart that VM.');
 }
}
export function checkIsolation(processes:ProcessRecord[],vmName:string,ssh:SSHSettings,hostIPs:string[],repositories?:string):{pid:number;softnetPid:number;policy:string}{
 checkHostConfigurationBoundary(processes,repositories);
 const candidates=processes.filter(p=>basename(p.executable)==='tart'&&p.args?.[1]==='run'&&p.args.includes(vmName));
 if(candidates.length!==1)throw Error('Cannot match this Vagrant VM to one running Tart process. Start it in Vagrant, then recheck.');
 const tart=candidates[0],config=options(tart.args!.slice(2),['--no-graphics','--no-audio','--no-clipboard','--net-softnet'],['--net-softnet-allow','--net-softnet-block','--dir']);
 if(config.positional.length!==1||config.positional[0]!==vmName)throw Error('Unexpected Tart launch arguments.');
 const share=directoryShares(tart.args!)[0];
 if(repositories&&(!share||share.path!==repositories||share.readOnly))throw Error('The selected repositories folder is not exposed read/write by this VM. Configure the single Tart volume shown below, restart the VM, then Recheck.');
 for(const flag of ['--no-graphics','--no-audio','--no-clipboard'])if(!config.out.has(flag))throw Error('Disable the Tart GUI, audio and clipboard in this Vagrant machine, then restart it.');
 const allow=config.out.get('--net-softnet-allow'),block=config.out.get('--net-softnet-block');
 if(!allow||!block)throw Error('This VM needs a default-deny Softnet policy. Default NAT or Softnet alone still permits access that Support cannot authorize.');
 const blocked=block.split(',').map(x=>x.trim()).sort();
 if(JSON.stringify(blocked)!==JSON.stringify(['in 0.0.0.0/0','out 0.0.0.0/0','out @host'].sort()))throw Error('Use the supported default-deny Softnet block rules shown below.');
 const rules=allow.split(',').map(x=>x.trim());
 if(rules.filter(x=>x===`in proto tcp @host port ${ssh.port}`).length!==1)throw Error('Allow only host-initiated SSH to this VM, with the SSH port discovered from Vagrant.');
 for(const rule of rules){
  if(rule===`in proto tcp @host port ${ssh.port}`)continue;
  const match=rule.match(/^out proto (tcp|udp) ([0-9.]+)\/32 port ([0-9]+)$/);
  if(!match||Number(match[3])<1||Number(match[3])>65535)throw Error('Infrastructure access must use individual IPv4 /32 addresses and ports. Broad networks, host aliases and inbound services are not accepted.');
  checkAddress(match[2],true,hostIPs);if(match[2]===ssh.host)throw Error('An egress rule points to the VM itself.');
 }
 if(new Set(rules).size!==rules.length||rules.length>129)throw Error('Duplicate or excessive Softnet rules.');
 const descendants=processes.filter(p=>{let id=p.ppid;for(let n=0;n<4;n++){if(id===tart.pid)return true;id=processes.find(x=>x.pid===id)?.ppid??0;}return false;});
 const children=descendants.filter(p=>basename(p.executable)==='softnet');
 if(children.length!==1||!children[0].args)throw Error('Cannot inspect the running Softnet process. Its actual rules must be readable; no administrator access is requested by Support.');
 const softnet=children[0],runtime=options(softnet.args!.slice(1),[],['--vm-fd','--vm-mac-address','--allow','--block']);
 if(runtime.positional.length||runtime.out.get('--vm-fd')!=='0'||!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(runtime.out.get('--vm-mac-address')??'')||runtime.out.get('--allow')!==allow||runtime.out.get('--block')!==block)throw Error('Running Softnet settings do not match this VM, or allow runtime policy changes. Restart the VM with the displayed policy.');
 checkAddress(ssh.host,true,hostIPs);
 return {pid:tart.pid,softnetPid:softnet.pid,policy:JSON.stringify({vmName,ssh,allow,block,share})};
}
export function isolationHelp(port:number,repositories?:string){return `Keep the Vagrant project, SSH keys and Support app outside VM shares. Disable default /vagrant and all other synced folders. ${repositories?'Only the selected repositories folder may be shared read/write.':'Select a repositories folder in this window if you need a writable share.'} Disable SSH agent forwarding.\n\nInside this machine's Tart provider block (named tart below), use these options. Add individual infrastructure IPv4 addresses and ports to the allow list. Restart the VM yourself, then Recheck. Softnet must support directional rules; older builds reject these options.`;}
export function isolationSnippet(port:number,repositories?:string){
 const volume=repositories ? "'"+(repositories+':tag=support-repos').replaceAll('\\','\\\\').replaceAll("'","\\'")+"'" : '';
 return `tart.gui = false\ntart.audio = false\ntart.clipboard = false\ntart.volumes = [${volume}]\ntart.extra_run_args = [\n  "--net-softnet-block=in 0.0.0.0/0,out 0.0.0.0/0,out @host",\n  "--net-softnet-allow=in proto tcp @host port ${port}"\n]\n# Append explicit infrastructure destinations to the allow string, e.g.\n# ,out proto tcp YOUR_SERVICE_IPV4/32 port 443\n# Outside the provider block, disable other synced folders:\n# config.vm.synced_folder ".", "/vagrant", disabled: true\n# config.ssh.forward_agent = false`;
}

import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';

export type NetworkPolicy={interface:string;guestIPv4:string;sshPort:number;egress:{address:string;port:number;protocol:'tcp'|'udp'}[]};
export type HostProfile={version:1;port:number;guestPort:number;sshUser:string;identityFile:string;knownHostsFile:string;network:NetworkPolicy};
const port=(v:unknown):v is number=>Number.isInteger(v)&&Number(v)>=1024&&Number(v)<=65535;
export function parseProfile(value:unknown):HostProfile {
 const p=value as HostProfile;
 if(!p||p.version!==1||!port(p.port)||!port(p.guestPort)||!/^[_a-zA-Z][_a-zA-Z0-9-]{0,63}$/.test(p.sshUser??''))throw Error('Invalid host profile.');
 for(const f of [p.identityFile,p.knownHostsFile])if(typeof f!=='string'||!f.startsWith('/')||/[\r\n\0]/.test(f))throw Error('SSH files must be absolute host paths.');
 validateNetwork(p.network);
 return p;
}
function unicastIPv4(address:string){
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return a!==0&&a!==127&&a<224&&!(a===169&&b===254);
}
export function validateNetwork(p:NetworkPolicy,hostAddresses=Object.values(networkInterfaces()).flatMap(v=>(v??[]).map(i=>i.address))){
 if(!p||!/^bridge[0-9]{1,4}$/.test(p.interface)||!unicastIPv4(p.guestIPv4)||!Number.isInteger(p.sshPort)||p.sshPort<1||p.sshPort>65535||!Array.isArray(p.egress)||p.egress.length>128)throw Error('Use a dedicated, verified host-filterable bridge, a static guest IPv4 and explicit egress rules. Native NAT is not assumed filterable.');
 if(hostAddresses.includes(p.guestIPv4))throw Error('Guest address belongs to the Mac.');
 for(const rule of p.egress){
  if(!rule||!unicastIPv4(rule.address)||hostAddresses.includes(rule.address)||rule.address===p.guestIPv4||!Number.isInteger(rule.port)||rule.port<1||rule.port>65535||!['tcp','udp'].includes(rule.protocol))throw Error('Egress must name an individual non-host IPv4 address, protocol and port.');
 }
}
/** Admin-owned, first filter anchor. No guest packets may establish a connection to self.
 * IPv6, source spoofing and unspecified egress are denied at the dedicated ingress interface.
 * Existing states must be absent when this policy is installed, with the VM powered off.
 */
export function renderPF(p:NetworkPolicy){
 validateNetwork(p);
 const dev=p.interface,ip=p.guestIPv4;
 return [
  '# Support VM: insert anchor "support_vm" quick as the FIRST filter rule in /etc/pf.conf.',
  `block drop in quick on ${dev} inet6 all`,
  `block drop in quick on ${dev} inet from ! ${ip} to any`,
  `block drop in quick on ${dev} inet from any to self`,
  `block drop in quick on ${dev} inet from any to { 0.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 224.0.0.0/4 }`,
  ...p.egress.map(r=>`pass in quick on ${dev} inet proto ${r.protocol} from ${ip} to ${r.address} port ${r.port}${r.protocol==='tcp'?' flags S/SA':''} keep state (if-bound)`),
  `block drop in quick on ${dev} all`,
  // Host-originated SSH is permitted, including only replies covered by its state.
  `pass out quick on ${dev} inet proto tcp from self to ${ip} port ${p.sshPort} flags S/SA keep state (if-bound)`,
  ''
 ].join('\n');
}
export function sshArguments(p:HostProfile,socket:string){
 if(!socket.startsWith('/')||socket.includes(':')||/[\r\n\0]/.test(socket))throw Error('Invalid private socket path.');
 return ['-F','/dev/null','-N','-T','-L',`${socket}:127.0.0.1:${p.guestPort}`,'-p',String(p.network.sshPort),'-i',p.identityFile,
  ...['BatchMode=yes','StrictHostKeyChecking=yes',`UserKnownHostsFile=${p.knownHostsFile}`,'GlobalKnownHostsFile=/dev/null','IdentitiesOnly=yes',
  'IdentityAgent=none','ForwardAgent=no','ForwardX11=no','ForwardX11Trusted=no','PermitLocalCommand=no','ProxyCommand=none','ProxyJump=none',
  'ControlMaster=no','ControlPath=none','Tunnel=no','RemoteCommand=none','RequestTTY=no','GatewayPorts=no','EscapeChar=none',
  'StreamLocalBindMask=0177','StreamLocalBindUnlink=no','ExitOnForwardFailure=yes','ConnectTimeout=10','ServerAliveInterval=15','ServerAliveCountMax=3'
  ].flatMap(o=>['-o',o]),`${p.sshUser}@${p.network.guestIPv4}`];
}

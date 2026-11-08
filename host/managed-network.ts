import {isIP,createServer,createConnection,type Socket} from 'node:net';
import {networkInterfaces} from 'node:os';
export type ManagedEndpoint={host:string;address:string;port:number;allowPrivate:boolean};
export type ManagedPolicy={version:1;endpoints:ManagedEndpoint[]};
const authorityHost=(host:string)=>host===host.toLowerCase()&&host.length<=253&&/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)&&!host.includes('..')&&!host.endsWith('.local')&&!host.endsWith('.localhost')&&host!=='localhost';
export function hostAddresses(){return Object.values(networkInterfaces()).flatMap(v=>(v??[]).map(n=>n.address.replace(/^::ffff:/,'')));}
export function checkAddress(address:string,allowPrivate:boolean,local=hostAddresses()){
 if(isIP(address)!==4)throw Error('Managed egress requires a pinned IPv4 address.');
 const [a,b]=address.split('.').map(Number);
 if(a===0||a===127||a>=224||a===169&&b===254||local.includes(address))throw Error('Mac, loopback, link-local and multicast destinations are forbidden.');
 if(!allowPrivate&&(a===10||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)))throw Error('Private infrastructure addresses need an explicit host-side grant.');
}
export function parseManagedPolicy(value:unknown):ManagedPolicy{
 const p=value as ManagedPolicy;
 if(!p||p.version!==1||Object.keys(p).some(k=>!['version','endpoints'].includes(k))||!Array.isArray(p.endpoints)||p.endpoints.length>128)throw Error('Invalid managed network policy.');
 const seen=new Set<string>();
 for(const e of p.endpoints){
  if(!e||Object.keys(e).some(k=>!['host','address','port','allowPrivate'].includes(k))||typeof e.host!=='string'||!authorityHost(e.host)||typeof e.allowPrivate!=='boolean'||!Number.isInteger(e.port)||e.port<1||e.port>65535)throw Error('Specify an exact hostname, IPv4, port and private-address grant.');
  checkAddress(e.address,e.allowPrivate);
  if(isIP(e.host)&&e.host!==e.address)throw Error('An IP authority must match its pinned address.');
  const key=e.host+':'+e.port;if(seen.has(key))throw Error('Duplicate network authority.');seen.add(key);
 }
 return Object.freeze({version:1,endpoints:Object.freeze(p.endpoints.map(e=>Object.freeze({...e})))}) as unknown as ManagedPolicy;
}
export function destination(policy:ManagedPolicy,value:unknown,local=hostAddresses()){
 const v=value as {version:number;host:string;port:number};
 if(!v||Object.keys(v).some(k=>!['version','host','port'].includes(k))||v.version!==1||typeof v.host!=='string'||!authorityHost(v.host)||!Number.isInteger(v.port))throw Error('Invalid egress request.');
 const endpoint=policy.endpoints.find(e=>e.host===v.host&&e.port===v.port);if(!endpoint)throw Error('Destination is not approved on the Mac.');
 checkAddress(endpoint.address,endpoint.allowPrivate,local);return endpoint;
}
/** Bound to an app-private UNIX socket. The only VZ guest listener forwards here.
 * Wire: one JSON line (<=1024 bytes), then OK\n or DENIED\n, then opaque TCP.
 * There is no DNS, URL fetch, filesystem, process or generic localhost operation.
 */
export function createManagedBroker(policy:ManagedPolicy,options:{localAddresses?:()=>string[];connect?:(endpoint:ManagedEndpoint)=>Socket;deadlineMs?:number;maxBytes?:number}={}){
 const clients=new Set<Socket>(),remotes=new Set<Socket>();
 const local=options.localAddresses??hostAddresses;
 const server=createServer({allowHalfOpen:true},client=>{
  if(clients.size>=8){client.destroy();return;}clients.add(client);
  let remote:Socket|undefined,header=Buffer.alloc(0),bytes=0,closed=false;
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);clearInterval(monitor);clients.delete(client);if(remote)remotes.delete(remote);client.destroy();remote?.destroy();};
  const timer=setTimeout(close,options.deadlineMs??600000);timer.unref();
  let endpoint:ManagedEndpoint|undefined;
  const monitor=setInterval(()=>{if(endpoint)try{checkAddress(endpoint.address,endpoint.allowPrivate,local());}catch{close();}},1000);monitor.unref();
  client.setTimeout(3000,close);client.on('error',close);client.on('close',close);
  const reject=()=>{client.pause();client.off('data',read);client.end('DENIED\n');setTimeout(close,20).unref();};
  const read=(chunk:Buffer)=>{
   if(header.length+chunk.length>1025){reject();return;}
   header=Buffer.concat([header,chunk]);const index=header.indexOf(10);
   if(index<0){if(header.length>1024)reject();return;}
   client.pause();client.off('data',read);
   // No pipelining before acceptance, including bytes after the first newline.
   if(index>1024||index!==header.length-1){reject();return;}
   try{endpoint=destination(policy,JSON.parse(header.subarray(0,index).toString()),local());}catch{reject();return;}
   remote=(options.connect??(e=>createConnection({host:e.address,port:e.port,family:4,allowHalfOpen:true})))(endpoint);remotes.add(remote);
   remote.setTimeout(5000,close);remote.on('error',reject);remote.on('close',close);
   remote.once('connect',()=>{
    if(closed)return;try{checkAddress(endpoint!.address,endpoint!.allowPrivate,local());}catch{reject();return;}
    client.setTimeout(60000,close);remote!.setTimeout(60000,close);client.write('OK\n');
    const count=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>(options.maxBytes??64*1024*1024))close();};
    client.on('data',count);remote!.on('data',count);client.pipe(remote!);remote!.pipe(client);client.resume();
   });
  };
  client.on('data',read);
 });
 return {server,close(){for(const c of clients)c.destroy();for(const r of remotes)r.destroy();server.close();}};
}

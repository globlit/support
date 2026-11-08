import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,createConnection,type Socket} from 'node:net';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseManagedPolicy,destination,checkAddress,createManagedBroker} from '../host/managed-network.js';
import {toolboxEnvironment} from '../server/toolbox.js';
import {cliEnvironment} from '../server/claude-cli.js';
const policy=parseManagedPolicy({version:1,endpoints:[{host:'gitlab.company.test',address:'198.51.100.31',port:443,allowPrivate:false}]});
test('managed policy pins exact authority/IP/port and forbids every host address form',()=>{
 assert.equal(destination(policy,{version:1,host:'gitlab.company.test',port:443},[]).address,'198.51.100.31');
 for(const address of ['127.0.0.1','0.0.0.0','169.254.1.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','192.168.1.10'])assert.throws(()=>checkAddress(address,true,['192.168.1.10']));
 for(const address of ['10.0.0.2','172.16.2.3','192.168.1.5','100.64.1.2']){assert.throws(()=>checkAddress(address,false,[]));checkAddress(address,true,[]);}
 for(const request of [{version:1,host:'localhost',port:443},{version:1,host:'gitlab.company.test',port:22},{version:1,host:'evil.test',port:443},{version:1,host:'gitlab.company.test',port:443,address:'127.0.0.1'},{version:1,host:'gitlab.company.test',port:443,command:'whoami'}])assert.throws(()=>destination(policy,request,[]));
 assert.throws(()=>destination(policy,{version:1,host:'gitlab.company.test',port:443},['198.51.100.31']));
 assert.throws(()=>parseManagedPolicy({version:1,endpoints:[{host:'127.0.0.1',address:'198.51.100.31',port:443,allowPrivate:false}]}));
 assert.throws(()=>parseManagedPolicy({version:1,endpoints:[...policy.endpoints,...policy.endpoints]}));
 assert.throws(()=>parseManagedPolicy({version:1,endpoints:[],allowAll:true}));
 assert.ok(Object.isFrozen(policy.endpoints[0]));
});
async function fixture(options:{maxBytes?:number;deadlineMs?:number}={}){
 const root=await mkdtemp(join(tmpdir(),'support-managed-net-')),path=join(root,'broker.sock');let connects=0,local:string[]=[];
 const sockets=new Set<Socket>();const echo=createServer({allowHalfOpen:true},socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.pipe(socket);});await new Promise<void>(r=>echo.listen(0,'127.0.0.1',r));const port=(echo.address() as {port:number}).port;
 const broker=createManagedBroker(policy,{...options,localAddresses:()=>local,connect:endpoint=>{connects++;assert.equal(endpoint.address,'198.51.100.31');assert.equal(endpoint.port,443);return createConnection({host:'127.0.0.1',port,allowHalfOpen:true});}});
 await new Promise<void>(r=>broker.server.listen(path,r));
 const client=()=>{const c=createConnection(path);sockets.add(c);c.on('close',()=>sockets.delete(c));c.on('error',()=>{});return c;};
 return {client,connects:()=>connects,local:(v:string[])=>local=v,async done(){broker.close();for(const s of sockets)s.destroy();await new Promise<void>(r=>echo.close(()=>r()));await rm(root,{recursive:true,force:true});}};
}
function exchange(client:Socket,text:string){return new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>{client.destroy();reject(Error('test deadline'));},2500);client.on('data',b=>output+=b);client.on('close',()=>{clearTimeout(timer);resolve(output);});client.write(text);});}
const request=JSON.stringify({version:1,host:'gitlab.company.test',port:443})+'\n';
test('guest cannot request a URL, command, alternate host, IP or pipelined payload',async()=>{
 const f=await fixture();try{
  for(const input of [JSON.stringify({version:1,host:'localhost',port:22})+'\n',JSON.stringify({version:1,url:'http://127.0.0.1:4173'})+'\n','garbage\n','x'.repeat(1026),request+'GET /\r\n'])assert.equal(await exchange(f.client(),input),'DENIED\n');
  assert.equal(f.connects(),0);
 }finally{await f.done();}
});
test('approved streams retain payload, half-close, deadlines and byte caps',async()=>{
 const f=await fixture();try{
  const c=f.client();const data=await new Promise<string>((resolve,reject)=>{let output='',sent=false;const timer=setTimeout(()=>reject(Error('deadline')),2000);c.on('data',b=>{output+=b;if(!sent&&output.startsWith('OK\n')){sent=true;c.end('approved payload');}});c.on('close',()=>{clearTimeout(timer);resolve(output);});c.write(request);});
  assert.equal(data,'OK\napproved payload');assert.equal(f.connects(),1);
 }finally{await f.done();}
 const bounded=await fixture({maxBytes:32,deadlineMs:500});try{
  const c=bounded.client();await new Promise<void>(r=>{c.on('data',()=>c.write('x'.repeat(100)));c.on('close',r);c.write(request);});
 }finally{await bounded.done();}
});
test('an established connection is revoked when its pinned IP becomes a Mac address',async()=>{
 const f=await fixture();try{
  const c=f.client();await new Promise<void>(r=>{c.once('data',()=>{f.local(['198.51.100.31']);});c.once('close',r);c.write(request);});
  assert.equal(f.connects(),1);assert.equal(await exchange(f.client(),request),'DENIED\n');assert.equal(f.connects(),1);
 }finally{await f.done();}
});
test('networkless guest tools retain explicit proxy settings without host agents or injection variables',()=>{
 const input={HTTP_PROXY:'http://127.0.0.1:18080',HTTPS_PROXY:'http://127.0.0.1:18080',NO_PROXY:'127.0.0.1,localhost',NODE_USE_ENV_PROXY:'1',SSH_AUTH_SOCK:'/host/agent',NODE_OPTIONS:'--require /host/payload',GIT_ASKPASS:'/host/command'};
 for(const env of [toolboxEnvironment(input),cliEnvironment(input)]){assert.equal(env.HTTPS_PROXY,input.HTTPS_PROXY);assert.equal(env.NODE_USE_ENV_PROXY,'1');assert.equal(env.SSH_AUTH_SOCK,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.GIT_ASKPASS,undefined);}
});
test('native managed device policy and install entitlement expose no NIC or directory sharing',async()=>{
 const source=await readFile('companion/macos/ManagedVM.swift','utf8');
 assert.match(source,/config.networkDevices = \[\]/);assert.match(source,/config.directorySharingDevices = \[\]/);
 assert.doesNotMatch(source,/VZNATNetworkDeviceAttachment|VZBridgedNetworkDeviceAttachment|VZVirtioFileSystemDeviceConfiguration|VZSharedDirectory/);
 assert.match(source,/url: input, readOnly: true/);assert.match(source,/forPort: 4174/);assert.match(source,/flock\(lockFD, LOCK_EX \| LOCK_NB\)/);
 const entitlements=await readFile('companion/macos/ManagedVM.entitlements','utf8');assert.match(entitlements,/com.apple.security.virtualization/);assert.doesNotMatch(entitlements,/com.apple.vm.networking|device-access/);
 const transport=await readFile('companion/macos/ManagedTransport.swift','utf8');assert.match(transport,/device.connect\(toPort: 4173\)/);assert.match(transport,/connection.destinationPort == 4174/);assert.doesNotMatch(transport,/AF_INET|\/usr\/bin\/ssh|Process\(/);
});

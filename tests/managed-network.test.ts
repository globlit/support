import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,createConnection,type Socket} from 'node:net';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseManagedPolicy,destination,checkAddress,createManagedBroker} from '../host/managed-network.js';
import {toolboxEnvironment} from '../server/toolbox.js';
import {cliEnvironment} from '../server/claude-cli.js';
import {managedLease} from '../host/managed-lease.js';
import {execFileSync} from 'node:child_process';
const policy=parseManagedPolicy({version:1,endpoints:[{host:'gitlab.company.test',address:'198.51.100.31',port:443,allowPrivate:false}]});
test('native control lease closes irreversibly on invalid messages, expiry or parent exit',()=>{
 for(const fail of ['eof','invalid','overflow','expiry','late-heartbeat']){
  let now=0,closed=0;const lease=managedLease(()=>closed++,()=>now);
  lease.write('BOOTING\n');assert.equal(lease.running,false);
  lease.write('RUN');assert.equal(lease.running,false);lease.write('NING\n');assert.equal(lease.running,true);
  now=5000;lease.write('RUNNING\n');now=10000;lease.tick();assert.equal(closed,0);
  if(fail==='eof')lease.close();
  if(fail==='invalid')lease.write('UNKNOWN\nRUNNING\n');
  if(fail==='overflow')lease.write('x'.repeat(1025));
  if(fail==='expiry'){now=11001;lease.tick();}
  if(fail==='late-heartbeat'){now=11001;lease.write('RUNNING\n');}
  assert.equal(closed,1);assert.equal(lease.running,false);lease.write('RUNNING\n');lease.tick();lease.close();assert.equal(closed,1);assert.equal(lease.running,false);
 }
});
test('guest proxy protocol and half-close regression suite',()=>{
 execFileSync('python3',['-B','-m','unittest','discover','-s','tests','-p','guest_bridge_test.py'],{timeout:20000,stdio:'pipe',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
});
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
test('broker caps pending clients and closes an idle approved stream at its absolute deadline',async()=>{
 const f=await fixture();try{
  for(let n=0;n<8;n++){const c=f.client();await new Promise<void>(r=>c.once('connect',r));}
  const excess=f.client();await new Promise<void>((r,j)=>{const timer=setTimeout(()=>j(Error('Connection cap did not close excess client')),1000);excess.once('close',()=>{clearTimeout(timer);r();});});
  assert.equal(f.connects(),0);
 }finally{await f.done();}
 const bounded=await fixture({deadlineMs:100});try{
  assert.equal(await exchange(bounded.client(),request),'OK\n');assert.equal(bounded.connects(),1);
 }finally{await bounded.done();}
});
test('networkless guest tools retain explicit proxy settings without host agents or injection variables',()=>{
 const input={HTTP_PROXY:'http://127.0.0.1:18080',HTTPS_PROXY:'http://127.0.0.1:18080',NO_PROXY:'127.0.0.1,localhost',NODE_USE_ENV_PROXY:'1',SSH_AUTH_SOCK:'/host/agent',NODE_OPTIONS:'--require /host/payload',GIT_ASKPASS:'/host/command'};
 for(const env of [toolboxEnvironment(input),cliEnvironment(input)]){assert.equal(env.HTTPS_PROXY,input.HTTPS_PROXY);assert.equal(env.NODE_USE_ENV_PROXY,'1');assert.equal(env.SSH_AUTH_SOCK,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.GIT_ASKPASS,undefined);}
});
test('the shipped native companion cannot create or provision a VM',async()=>{
 const app=await readFile('companion/macos/SupportCompanion.swift','utf8');
 const build=await readFile('companion/macos/build-app.sh','utf8');
 const connection=await readFile('companion/macos/ExistingVM.swift','utf8');
 assert.doesNotMatch(app,/ManagedVMModel|Create.*VM|VZVirtualMachine/);
 assert.doesNotMatch(build,/-framework Virtualization|--entitlements/);
 assert.doesNotMatch(connection,/vagrant.*up|tart.*run|VZVirtualMachine|rootfs.raw/);
 assert.match(connection,/vm-discover/);assert.match(connection,/vm-connect/);
 assert.doesNotMatch(connection,/Host gateway profile|Setup guide|hostProfile/);
});

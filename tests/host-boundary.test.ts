import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,chmod,readdir,symlink,link,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {SafeLink} from '../src/SafeLink.js';
import {parseProfile,renderPF,sshArguments,validateNetwork,type HostProfile} from '../host/policy.js';
import {checkLoadedPF,verifyPF} from '../host/firewall.js';
import {snapshot} from '../host/files.js';
import {createGateway} from '../host/gateway.js';
import {boundaryHref} from '../src/host-boundary.js';
const profile:HostProfile={version:1,port:4173,guestPort:4173,sshUser:'support-forward',identityFile:'/host/key',knownHostsFile:'/host/known',network:{interface:'bridge100',guestIPv4:'192.0.2.10',sshPort:22,egress:[{address:'198.51.100.20',port:443,protocol:'tcp'}]}};
async function cleanup(path:string){await chmod(path,0o700);for(const e of await readdir(path,{withFileTypes:true}))if(e.isDirectory())await cleanup(join(path,e.name));await rm(path,{recursive:true,force:true});}

test('host network rules reject Mac addresses, aliases, injection and broad permissions',()=>{
 assert.deepEqual(parseProfile(profile),profile);
 for(const patch of [{interface:'bridge100\npass all'},{interface:'en0'},{guestIPv4:'127.0.0.1'},{guestIPv4:'::ffff:127.0.0.1'}])assert.throws(()=>validateNetwork({...profile.network,...patch}));
 for(const address of ['127.0.0.1','169.254.169.254','0.0.0.0','224.0.0.1','::1','host.local','198.51.100.0/24','192.0.2.10','192.168.10.1'])assert.throws(()=>validateNetwork({...profile.network,egress:[{address,port:443,protocol:'tcp'}]},['192.168.10.1']));
 const rules=renderPF(profile.network);assert.match(rules,/inet6 all/);assert.match(rules,/from ! 192.0.2.10/);assert.ok(rules.indexOf('to self')<rules.indexOf('to 198.51.100.20'));assert.match(rules,/block drop in quick on bridge100 all/);assert.doesNotMatch(rules,/pass in.*to any/);
});
test('PF gate rejects disabled, shadowed, skipped, changed or missing interface policies',async()=>{
 const rules=renderPF(profile.network),ok={info:'Status: Enabled for 10 seconds',main:'anchor "support_vm" quick all\nanchor "com.apple/*" all',loaded:rules,expected:rules,interfaces:'bridge100: flags=UP',pfInterfaces:'bridge100'};
 checkLoadedPF(ok,profile.network);
 for(const patch of [{info:'Status: Disabled'},{main:'pass quick all\n'+ok.main},{main:'anchor "support_vm" all'},{loaded:rules+'pass all\n'},{interfaces:'en0: flags=UP'},{pfInterfaces:'bridge100 (skip)'}])assert.throws(()=>checkLoadedPF({...ok,...patch},profile.network));
 if(process.platform!=='darwin')await assert.rejects(verifyPF(profile.network),/requires macOS/);
});
test('SSH uses a private Unix socket, pinned keys, no host agent or command features',()=>{
 const args=sshArguments(profile,'/private/support/backend.sock');const policy=execFileSync('/usr/bin/ssh',['-G',...args],{encoding:'utf8'});
 assert.match(policy,/^localforward \/private\/support\/backend.sock \[127.0.0.1\]:4173$/m);
 for(const key of ['forwardagent','forwardx11','forwardx11trusted','permitlocalcommand','gatewayports','controlmaster'])assert.match(policy,new RegExp('^'+key+' (no|false)$','m'));
 assert.match(policy,/^identityagent none$/m);assert.match(policy,/^stricthostkeychecking (true|yes)$/m);assert.match(policy,/^streamlocalbindunlink (no|false)$/m);
 assert.doesNotMatch(policy,/^(remoteforward|dynamicforward) /m);assert.throws(()=>sshArguments(profile,'/bad:socket'));
});
test('snapshot copies regular files independently and omits host execution/configuration folders',async()=>{
 const root=await mkdtemp(join(tmpdir(),'support-copy-'));try{
  const src=join(root,'source'),out=join(root,'copy');await mkdir(src);await mkdir(join(src,'.git'));await writeFile(join(src,'.git','config'),'credential-helper');await writeFile(join(src,'.env'),'secret');await writeFile(join(src,'runbook.md'),'hello');await mkdir(join(src,'config'));await writeFile(join(src,'config','deployment.yaml'),'replicas: 2');
  const result=await snapshot(src,out);assert.equal(result.files,2);assert.equal(await readFile(join(out,'runbook.md'),'utf8'),'hello');assert.notEqual((await stat(join(out,'runbook.md'))).ino,(await stat(join(src,'runbook.md'))).ino);await assert.rejects(readFile(join(out,'.env')));await assert.rejects(readFile(join(out,'.git','config')));
  await writeFile(join(src,'runbook.md'),'changed');assert.equal(await readFile(join(out,'runbook.md'),'utf8'),'hello');assert.equal((await stat(join(out,'runbook.md'))).mode&0o222,0);
  await assert.rejects(snapshot(src,out));await assert.rejects(snapshot(src,join(root,'protected'),{protectedPaths:[src]}));
 }finally{await cleanup(root);}
});
test('snapshot fails atomically for symlinks, hard links, file limits and unsafe roots',async()=>{
 const root=await mkdtemp(join(tmpdir(),'support-copy-deny-'));try{
  const src=join(root,'source'),out=join(root,'copy'),secret=join(root,'host-secret');await mkdir(src);await writeFile(secret,'never copy');await symlink(secret,join(src,'escape'));await assert.rejects(snapshot(src,out),/symlink/);await assert.rejects(stat(out));await rm(join(src,'escape'));await link(secret,join(src,'escape'));await assert.rejects(snapshot(src,out),/hard link/);await rm(join(src,'escape'));await writeFile(join(src,'large'),'12345');await assert.rejects(snapshot(src,out,{maxBytes:4}),/limit/);await assert.rejects(snapshot(src,out,{maxFiles:0}),/limit/);await assert.rejects(snapshot(src,join(src,'nested')));await assert.rejects(snapshot('/',out));
 }finally{await cleanup(root);}
});
test('protected browser allows app routes but never guest-provided external destinations',()=>{
 for(const url of ['http://127.0.0.1:8080/','http://192.168.1.1','https://tool.company.test','javascript:alert(1)','//localhost','file:///etc/passwd','data:text/html,hi','/api/state','/assets/untrusted.js','blob:http://127.0.0.1/guest'])assert.equal(boundaryHref(url,true),undefined,url);
 assert.equal(boundaryHref('#/youtrack?issue=LAB-1',true),'#/youtrack?issue=LAB-1');assert.equal(boundaryHref('/downloads/support-companion.zip',true),'/downloads/support-companion.zip');assert.equal(boundaryHref('https://tool.test',false),'https://tool.test');
});

async function gatewayFixture(connectionId?:string){
 const root=await mkdtemp(join(tmpdir(),'support-gateway-')),ui=join(root,'public'),socket=join(root,'backend.sock'),key=randomBytes(32);await mkdir(ui);await mkdir(join(ui,'assets'));
 const docs={'/index.html':'<!doctype html><html><head></head><body>HOST UI</body></html>','/assets/app.js':'console.log("trusted host bundle")'};
 const manifest:Record<string,string>={};for(const [path,data] of Object.entries(docs)){await writeFile(join(ui,path),data);manifest[path]=createHash('sha256').update(data).digest('hex');}await writeFile(join(ui,'manifest.json'),JSON.stringify(manifest));
 let mode='json',hits=0,received:any,healthy=true;
 const backend=createServer(async(req,res)=>{hits++;const chunks=[];for await(const data of req)chunks.push(data);received={url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()};
  if(mode==='html'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<script>fetch("http://127.0.0.1:9999")</script>');return;}
  if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:9999','Content-Type':'application/json'});res.end('{}');return;}
  if(mode==='slow'){return;}
  if(mode==='large'){res.writeHead(200,{'Content-Type':'application/json'});res.end('"'+'x'.repeat(8*1024*1024)+'"');return;}
  if(mode==='callback'){res.writeHead(303,{Location:'http://127.0.0.1:9999'});res.end();return;}
  res.writeHead(200,{'Content-Type':'application/json','Content-Security-Policy':"default-src * 'unsafe-inline'",'Refresh':'0;url=http://127.0.0.1:9999','Service-Worker-Allowed':'/','Access-Control-Allow-Origin':'*','Set-Cookie':['support_session_4173='+'x'.repeat(43)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=600','admin=evil; Domain=localhost']});
  res.end(JSON.stringify({text:'<script>alert(1)</script>',url:'http://127.0.0.1:9999',ok:true}));});
 await new Promise<void>(r=>backend.listen(socket,r));
 const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
 const server=await createGateway({port,guestPort:4173,socketPath:socket,publicDirectory:ui,proofKey:key,healthy:()=>healthy,timeoutMs:100,connectionId});await new Promise<void>(r=>server.listen(port,'127.0.0.1',r));const origin=`http://127.0.0.1:${port}`;
 return {root,ui,origin,key,mode:(v:string)=>{mode=v;},health:(v:boolean)=>{healthy=v;},hits:()=>hits,received:()=>received,async done(){server.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>backend.close(()=>r()))]);await cleanup(root);}};
}
test('gateway serves only local verified assets and data, strips guest authority and requires correct browser origin',async()=>{
 const f=await gatewayFixture();try{
  const page=await fetch(f.origin+'/');assert.match(await page.text(),/HOST UI/);assert.equal(f.hits(),0);assert.match(page.headers.get('content-security-policy')!,/connect-src 'self'/);assert.match(page.headers.get('content-security-policy')!,/worker-src 'none'/);
  for(const path of ['/assets/guest.js','/guest.html','/__host/run','/foo'])assert.equal((await fetch(f.origin+path)).status,404);
  assert.equal((await fetch(f.origin+'/api/state',{headers:{Origin:'https://evil.test'}})).status,403);
  const navigation=await new Promise<number>((resolve,reject)=>{const r=request(f.origin+'/api/state',{headers:{'Sec-Fetch-Mode':'navigate'}},res=>{res.resume();resolve(res.statusCode!);});r.on('error',reject);r.end();});assert.equal(navigation,403);
  const r=await fetch(f.origin+'/api/vault',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','X-Support-CSRF':'c'.repeat(43),Cookie:'support_session_'+new URL(f.origin).port+'='+'s'.repeat(43)+'; host_secret=private','X-Forwarded-Host':'evil'},body:'{"action":"unlock"}'});
  assert.equal(r.status,200);assert.equal((await r.json()).ok,true);assert.equal(r.headers.get('refresh'),null);assert.equal(r.headers.get('service-worker-allowed'),null);assert.equal(r.headers.get('access-control-allow-origin'),null);assert.match(r.headers.get('content-security-policy')!,/default-src 'none'/);assert.doesNotMatch(r.headers.get('set-cookie')!,/admin/);
  assert.equal(f.received().headers.host,'127.0.0.1:4173');assert.equal(f.received().headers.origin,'http://127.0.0.1:4173');assert.equal(f.received().headers['x-forwarded-host'],undefined);assert.doesNotMatch(f.received().headers.cookie,/host_secret/);
  f.health(false);const before=f.hits();assert.equal((await fetch(f.origin+'/api/state')).status,503);assert.equal(f.hits(),before);
 }finally{await f.done();}
});
test('gateway rejects executable bodies, redirects, oversized and hung guest responses',async()=>{
 const f=await gatewayFixture();try{
  for(const mode of ['html','redirect','large','slow']){f.mode(mode);assert.equal((await fetch(f.origin+'/api/state',{redirect:'manual'})).status,502,mode);}
  f.mode('callback');const callback=await fetch(f.origin+'/auth/chatgpt/callback?state=x',{redirect:'manual'});assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/#/auth?result=error');
 }finally{await f.done();}
});
test('host proof is bound to a fresh challenge and asset modification fails closed',async()=>{
 const f=await gatewayFixture();try{
  const nonce=randomBytes(32).toString('hex');const response=await fetch(f.origin+'/__support/host?nonce='+nonce);assert.deepEqual(await response.json(),{version:1,proof:createHmac('sha256',f.key).update(nonce).digest('hex')});assert.equal(f.hits(),0);assert.equal((await fetch(f.origin+'/__support/host?nonce=bad')).status,400);
  await writeFile(join(f.ui,'assets','app.js'),'evil');await assert.rejects(createGateway({port:4173,guestPort:4173,publicDirectory:f.ui,socketPath:'/unused',proofKey:f.key,healthy:()=>true}),/integrity/);
  // Running process has captured the verified bytes, not a mutable on-disk passthrough.
  assert.match(await (await fetch(f.origin+'/assets/app.js')).text(),/trusted host/);
 }finally{await f.done();}
});

test('host-rendered links are inert text for VM-provided URLs, including context-menu navigation',()=>{
 const prior=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:{querySelector:()=>({})},configurable:true});
 try{assert.doesNotMatch(renderToStaticMarkup(createElement(SafeLink,{href:'http://127.0.0.1:9999'},'untrusted link')),/<a|href=/);assert.match(renderToStaticMarkup(createElement(SafeLink,{href:'#/youtrack?issue=LAB-1'},'review')),/href="#\/youtrack/);}finally{if(prior)Object.defineProperty(globalThis,'document',prior);else Reflect.deleteProperty(globalThis,'document');}
});

test('Vagrant validates the final merged configuration and rejects shares, ports, LAN and agent forwarding',{timeout:60000},async t=>{
 const {existsSync}=await import('node:fs');if(!existsSync('/usr/bin/vagrant')){t.skip('Vagrant is not installed on this test host.');return;}
 const root=await mkdtemp(join(tmpdir(),'support-vagrant-config-'));
 try{
  const {resolve}=await import('node:path');const fixture=resolve('tests/fixtures/vagrant-boundary.rb');await writeFile(join(root,'Vagrantfile'),`load ${JSON.stringify(fixture)}\n`);
  for(const scenario of ['safe','share','port','lan','agent']){
   let output='',status=0;try{output=execFileSync('/usr/bin/vagrant',['validate'],{cwd:root,timeout:10000,maxBuffer:128*1024,encoding:'utf8',env:{...process.env,VAGRANT_CWD:root,VAGRANT_VAGRANTFILE:'Vagrantfile',VAGRANT_HOME:join(root,'home'),VAGRANT_DEFAULT_PROVIDER:'support_validation',CHECKPOINT_DISABLE:'1',VAGRANT_CHECKPOINT_DISABLE:'1',SUPPORT_CONFIG_TEST:scenario},stdio:['ignore','pipe','pipe']});}catch(e){const error=e as {status:number;stdout:Buffer;stderr:Buffer};status=error.status;output=String(error.stdout)+String(error.stderr);}
   assert.equal(status,scenario==='safe'?0:1,output);assert.match(output,scenario==='safe'?/validated successfully/:/Support host boundary/);
  }
 }finally{await cleanup(root);}
});

test('unverified native provider cannot activate a tunnel from a generic firewall profile',async()=>{
 const {requireVerifiedNativeProvider}=await import('../host/provider.js');await assert.rejects(requireVerifiedNativeProvider(),/activation is gated/);
 const root=await mkdtemp(join(tmpdir(),'support-provider-gate-'));try{
  const file=join(root,'profile.json');await writeFile(file,JSON.stringify({...profile,verified:true}),{mode:0o600});
  let output='';try{execFileSync(process.execPath,['--import','tsx','host/main.ts','serve',file],{timeout:10000,encoding:'utf8',stdio:['ignore','pipe','pipe']});assert.fail('Unverified provider must not start');}catch(e){output=String((e as {stderr?:Buffer}).stderr??'');}
  assert.match(output,/activation is gated/);assert.deepEqual(await readdir(root),['profile.json']);
 }finally{await cleanup(root);}
});

test('VM identity binds gateway proof, browser cookies and notification credentials to the selected VM',async()=>{
 const id='a'.repeat(32),other='b'.repeat(32),f=await gatewayFixture(id);
 try{
  const nonce=randomBytes(32).toString('hex');
  assert.deepEqual(await (await fetch(f.origin+'/__support/host?nonce='+nonce)).json(),{version:2,connectionId:id,proof:createHmac('sha256',f.key).update(nonce+'\n'+id).digest('hex')});
  for(const binding of [undefined,other]){
   const before=f.hits(),headers:Record<string,string>={Authorization:'Bearer '+'s'.repeat(43)};if(binding)headers['X-Support-VM']=binding;
   assert.equal((await fetch(f.origin+'/api/companion/events',{headers})).status,409);assert.equal(f.hits(),before);
  }
  assert.equal((await fetch(f.origin+'/api/companion/events',{headers:{'X-Support-VM':id,Authorization:'Bearer '+'s'.repeat(43)}})).status,200);
  assert.equal(f.received().headers.authorization,'Bearer '+'s'.repeat(43));assert.equal(f.received().headers['x-support-vm'],undefined);
  const port=new URL(f.origin).port;
  await fetch(f.origin+'/api/state',{headers:{Cookie:`support_session_${port}_${other}=${'o'.repeat(43)}; support_session_${port}=${'l'.repeat(43)}`}});
  assert.equal(f.received().headers.cookie,undefined);
  const response=await fetch(f.origin+'/api/vault',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json',Cookie:`support_session_${port}_${id}=${'s'.repeat(43)}`},body:'{}'});
  assert.equal(f.received().headers.cookie,'support_session_4173='+'s'.repeat(43));assert.ok(response.headers.get('set-cookie')!.startsWith(`support_session_${port}_${id}=`));
 }finally{await f.done();}
});

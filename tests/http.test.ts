import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {Store} from '../server/store.js';
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return port;}
async function fixture(prepare?:(store:Store)=>void){
 const dir=mkdtempSync(join(tmpdir(),'support-session-http-')),port=await freePort(),origin=`http://127.0.0.1:${port}`;
 if(prepare){const store=new Store(dir);prepare(store);store.close();}
 const child=spawn(process.execPath,['--import','tsx','server/index.ts'],{env:{...process.env,SUPPORT_DEPLOYMENT:'local',SUPPORT_BIND_HOST:'127.0.0.1',SUPPORT_PUBLIC_ORIGIN:origin,SUPPORT_PORT:String(port),SUPPORT_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('Server startup timed out')),8000);child.stdout.on('data',chunk=>{out+=chunk;if(out.includes('Open: '+origin)){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Server exited before startup'));});});
 return {origin,client:()=>client(origin),async done(){child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});rmSync(dir,{recursive:true,force:true});}};
}
function client(origin:string){
 let cookie='',csrf='';
 const get=(path:string,headers:Record<string,string>={})=>fetch(origin+path,{headers:{Cookie:cookie,...headers}});
 async function post(path:string,data:unknown,headers:Record<string,string>={},method='POST'){
  const r=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,'X-Support-CSRF':csrf,...headers},body:JSON.stringify(data)});
  const set=r.headers.get('set-cookie');if(set){cookie=set.split(';')[0];const s=await (await get('/api/session')).json();csrf=s.csrf??'';}return r;
 }
 return {get,post};
}
const passphrase='HTTP fixture passphrase for Support';
test('local shell needs no startup token, but every workspace API requires a browser session',{timeout:15000},async()=>{
 const f=await fixture(),c=f.client();try{
  assert.equal((await fetch(f.origin+'/')).status,200);
  const status=await c.get('/api/session');assert.equal(status.status,200);assert.equal(status.headers.get('set-cookie'),null);assert.deepEqual(await status.json(),{authenticated:false,initialized:false});
  for(const path of ['/api/state','/api/logs','/api/dashboard','/api/config/export','/api/ai/activity','/api/companion/status'])assert.equal((await c.get(path)).status,401,path);
  assert.equal((await c.post('/api/chatgpt/start',{})).status,401);
  assert.equal((await c.post('/api/vault',{action:'initialize',passphrase},{Origin:'https://attacker.test'})).status,403);
  for(const headers of [{Origin:'https://attacker.test'},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':'same-site'}] as Record<string,string>[])assert.equal((await c.get('/api/session',headers)).status,403);
  const badHost=await new Promise<number>((resolve,reject)=>{const r=request(f.origin+'/api/session',{headers:{Host:'attacker.test','X-Forwarded-Host':new URL(f.origin).host}},res=>{res.resume();resolve(res.statusCode!)});r.on('error',reject);r.end()});assert.equal(badHost,403);
  const init=await c.post('/api/vault',{action:'initialize',passphrase});assert.equal(init.status,200);assert.match(init.headers.get('set-cookie')!,/HttpOnly; SameSite=Lax/);
  const snapshot=await (await c.get('/api/state')).json();assert.deepEqual(snapshot.tickets,[]);assert.equal(snapshot.vault.unlocked,true);assert.equal(snapshot.runtime.deployment,'local');assert.ok(snapshot.runtime.workspaceId);assert.equal(snapshot.runtime.principal.role,'owner');
  assert.equal((await fetch(f.origin+'/api/state',{headers:{'X-Forwarded-User':'admin','X-Support-CSRF':'forged'}})).status,401);
  assert.equal((await c.post('/api/chatgpt/cancel',{}, {'X-Support-CSRF':''})).status,403);
  assert.equal((await c.post('/api/chatgpt/cancel',{}, {'X-Support-CSRF':'a'.repeat(43)})).status,403);
  assert.equal((await c.post('/api/session/logout',{})).status,200);assert.equal((await c.get('/api/state')).status,401);
  assert.equal((await c.post('/api/vault',{action:'unlock',passphrase:'incorrect passphrase'})).status,401);
  assert.equal((await c.post('/api/vault',{action:'unlock',passphrase})).status,200);
  const session=await (await c.get('/api/session')).json();assert.deepEqual(session.principal,snapshot.runtime.principal);
  const callback=await fetch(f.origin+'/auth/chatgpt/callback?state=invalid&code=invalid',{redirect:'manual'});assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/#/auth?result=error');
 }finally{await f.done()}
});
test('offline takeover records the authenticated identity; editing the engineer name cannot impersonate approval',{timeout:15000},async()=>{
 const issue={connection:'offline-yt',id:'offline',key:'LAB-1',updated:10,sourceFingerprint:'original',title:'',description:'',resolved:false,status:'Open',severity:'High',assignee:'',project:'LAB',fields:{},url:''};let revision=0;
 const f=await fixture(s=>{s.unlock(passphrase,true);revision=s.workSession(issue).revision;}),c=f.client();try{
  const decision={connection:issue.connection,revision,sourceUpdated:10,mode:'human',reason:'Handling manually'};
  assert.equal((await c.post('/api/youtrack/issues/offline/handling',decision)).status,401);
  await c.post('/api/vault',{action:'unlock',passphrase});const state=await (await c.get('/api/state')).json();
  assert.equal((await c.post('/api/config',{config:{...state.config,engineer:'Impersonated admin'},revision:state.configRevision},{},'PUT')).status,200);
  const r=await c.post('/api/youtrack/issues/offline/handling',decision,{'X-Forwarded-User':'forged'});assert.equal(r.status,200);const work=(await r.json()).session;
  assert.equal(work.handling.actor,'Workspace owner');assert.equal(work.handling.actorId,state.runtime.principal.id);assert.equal(work.handling.workspaceId,state.runtime.workspaceId);assert.equal(work.approval,null);
  assert.equal((await c.post('/api/youtrack/issues/offline/handling',decision)).status,409);
  assert.equal((await c.post('/api/youtrack/issues/offline/handling',{...decision,revision:work.revision,actor:'forged'})).status,400);
  const other=f.client();assert.equal((await other.get('/api/state')).status,401);await other.post('/api/vault',{action:'unlock',passphrase});assert.equal((await c.get('/api/state')).status,200);
  await other.post('/api/vault',{action:'lock'});assert.equal((await c.get('/api/state')).status,401);assert.equal((await other.get('/api/state')).status,401);
 }finally{await f.done()}
});
test('notification credentials remain separate from browser sessions and keep polling while locked',{timeout:15000},async()=>{
 const f=await fixture(),c=f.client(),native=f.client();try{
  await c.post('/api/vault',{action:'initialize',passphrase});const pair=await (await c.post('/api/companion/pairing',{})).json();
  const result=await (await native.post('/api/companion/pair',{code:pair.code,name:'Mac'})).json();const headers={Authorization:'Bearer '+result.token};assert.ok(result.token);
  assert.equal((await native.post('/api/companion/pair',{code:pair.code,name:'Other Mac'})).status,401);
  for(const path of ['/api/state','/api/session'])assert.equal((await native.get(path,headers)).status,403);
  assert.equal((await native.post('/api/companion/devices/'+result.id+'/test',{},headers)).status,403);
  await c.post('/api/companion/devices/'+result.id+'/test',{});const events=await (await native.get('/api/companion/events',headers)).json();assert.equal(events.events.length,1);
  assert.equal((await native.post('/api/companion/ack',{ids:[events.events[0].id]},headers)).status,200);
  await c.post('/api/vault',{action:'lock'});assert.deepEqual(await (await native.get('/api/companion/events',headers)).json(),{paused:true,events:[]});
  assert.equal((await native.post('/api/vault',{action:'unlock',passphrase},headers)).status,403);
  await c.post('/api/vault',{action:'unlock',passphrase});await c.post('/api/companion/devices/'+result.id+'/revoke',{});assert.equal((await native.get('/api/companion/events',headers)).status,401);
 }finally{await f.done()}
});

test('host gateway preserves real Vault sessions, CSRF and trusted approval identity',{timeout:15000},async()=>{
 const {createGateway}=await import('../host/gateway.js'),{createHash,randomBytes}=await import('node:crypto'),fs=await import('node:fs/promises');
 const issue={connection:'gateway-fixture',id:'offline',key:'LAB-1',updated:1,sourceFingerprint:'gateway',title:'',description:'',resolved:false,status:'Open',severity:'High',assignee:'',project:'LAB',fields:{},url:''};let revision=0;
 const f=await fixture(store=>{store.unlock(passphrase,true);revision=store.workSession(issue).revision;}),dir=mkdtempSync(join(tmpdir(),'support-gateway-real-')),socket=join(dir,'upstream.sock'),publicDir=join(dir,'public');
 const bridge=(await import('node:http')).createServer((req,res)=>{const upstream=request(f.origin+(req.url??'/'),{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode!,response.headers);response.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);});
 let gateway:Awaited<ReturnType<typeof createGateway>>|undefined;
 try{
  await fs.mkdir(publicDir);const html='<html><head></head><body>Host UI</body></html>';await fs.writeFile(join(publicDir,'index.html'),html);await fs.writeFile(join(publicDir,'manifest.json'),JSON.stringify({'/index.html':createHash('sha256').update(html).digest('hex')}));
  await new Promise<void>(r=>bridge.listen(socket,r));const port=await freePort(),origin=`http://127.0.0.1:${port}`;gateway=await createGateway({port,guestPort:Number(new URL(f.origin).port),socketPath:socket,publicDirectory:publicDir,proofKey:randomBytes(32),healthy:()=>true});await new Promise<void>(r=>gateway!.listen(port,'127.0.0.1',r));const c=client(origin);
  assert.equal((await c.get('/api/state')).status,401);assert.equal((await c.post('/api/vault',{action:'unlock',passphrase})).status,200);
  const state=await (await c.get('/api/state')).json();assert.equal(state.vault.unlocked,true);
  const data={connection:issue.connection,revision,sourceUpdated:1,mode:'human',reason:'Host gateway integration fixture'};
  assert.equal((await c.post('/api/youtrack/issues/offline/handling',data,{'X-Support-CSRF':''})).status,403);
  const taken=await c.post('/api/youtrack/issues/offline/handling',data);assert.equal(taken.status,200);const session=(await taken.json()).session;assert.equal(session.handling.actorId,state.runtime.principal.id);
  assert.equal((await c.post('/api/session/logout',{})).status,200);assert.equal((await c.get('/api/state')).status,401);
  assert.equal((await c.post('/api/vault',{action:'unlock',passphrase})).status,200);assert.equal((await c.post('/api/vault',{action:'lock'})).status,200);assert.equal((await c.get('/api/state')).status,401);
 }finally{gateway?.closeAllConnections();if(gateway?.listening)await new Promise<void>(r=>gateway!.close(()=>r()));bridge.closeAllConnections();await new Promise<void>(r=>bridge.close(()=>r()));await f.done();rmSync(dir,{recursive:true,force:true});}
});

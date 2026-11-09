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
  for(const path of ['/api/state','/api/logs','/api/dashboard','/api/config/export','/api/ai/activity','/api/notifications'])assert.equal((await c.get(path)).status,401,path);
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
test('browser notifications require a session, deliver test events once per position and stop when locked',{timeout:15000},async()=>{
 const f=await fixture(),c=f.client(),other=f.client();try{
  await c.post('/api/vault',{action:'initialize',passphrase});
  for(const path of ['/api/notifications','/api/notifications?after=0'])assert.equal((await other.get(path)).status,401,path);
  assert.equal((await other.post('/api/notifications/test',{})).status,401);
  const base=await (await c.get('/api/notifications')).json();assert.deepEqual(base.events,[]);
  assert.equal((await c.post('/api/notifications/test',{})).status,200);assert.equal((await c.post('/api/notifications/test',{})).status,429);
  const page=await (await c.get('/api/notifications?after='+base.seq)).json();assert.equal(page.events.length,1);assert.equal(page.events[0].title,'Support notifications work');
  assert.equal((await (await c.get('/api/notifications?after='+page.seq)).json()).events.length,0);
  assert.equal((await c.get('/api/notifications?after=x')).status,400);
  await c.post('/api/vault',{action:'lock'});assert.equal((await c.get('/api/notifications?after=0')).status,401);
 }finally{await f.done()}
});
test('a saved connection test makes a network request and its result sets the connection health',{timeout:20000},async()=>{
 const f=await fixture(),c=f.client(),other=f.client();try{
  await c.post('/api/vault',{action:'initialize',passphrase});
  assert.equal((await other.get('/api/health')).status,401);
  const state=await (await c.get('/api/state')).json();
  assert.equal((await c.post('/api/config',{config:{...state.config,connections:{...state.config.connections,Outline:{...state.config.connections.Outline,enabled:true,endpoint:'http://127.0.0.1:9'}}},revision:state.configRevision},{},'PUT')).status,200);
  for(let n=0;n<2;n++){const r=await (await c.post('/api/connection/check',{name:'Outline'})).json();assert.equal(r.liveTest,true);assert.equal(r.checks[0].ok,false);assert.doesNotMatch(JSON.stringify(r),/No network request/);}
  const health=await (await c.get('/api/health')).json();assert.equal(health.tools.find((t:{name:string})=>t.name==='Outline').state,'red');
 }finally{await f.done()}
});
test('kubeconfig merging accepts more than 20 files',{timeout:20000},async()=>{
 const f=await fixture(),c=f.client();try{
  await c.post('/api/vault',{action:'initialize',passphrase});
  const files=Array.from({length:25},(_,n)=>({name:`cluster-${n}.yaml`,content:'not: [valid'}));
  const r=await c.post('/api/toolbox/kubeconfig/merge',{files});const text=await r.text();
  assert.doesNotMatch(text,/Too big/);assert.equal(r.status,process.platform==='linux'?400:403);
 }finally{await f.done()}
});

test('agent console routes require a session, and the kill switch blocks new runs until resumed',{timeout:15000},async()=>{
 const f=await fixture(),c=f.client(),other=f.client();try{
  await c.post('/api/vault',{action:'initialize',passphrase});
  for(const path of ['/api/agent/state','/api/agent/feed'])assert.equal((await other.get(path)).status,401,path);
  for(const path of ['/api/agent/halt','/api/agent/resume'])assert.equal((await other.post(path,{})).status,401,path);
  let state=await (await c.get('/api/agent/state')).json();assert.equal(state.halted,false);assert.deepEqual(state.running,[]);assert.equal(state.sandbox.configured,false);
  const feed=await c.get('/api/agent/feed');assert.equal(feed.status,200);assert.match(feed.headers.get('content-type')??'',/text\/event-stream/);
  const reader=feed.body!.getReader();const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/retry: 3000/);
  state=await (await c.post('/api/agent/halt',{})).json();assert.equal(state.halted,true);
  state=await (await c.post('/api/agent/resume',{})).json();assert.equal(state.halted,false);
  await reader.cancel();
 }finally{await f.done()}
});

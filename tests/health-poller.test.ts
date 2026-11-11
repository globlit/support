import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {defaults,type ConnectionName} from '../src/model.js';
import {HealthPoller,outlineCollectionRef,serviceProbe,testConnection} from '../server/health-poller.js';
import {toolHealth,healthTimeouts,type HealthResult} from '../server/tool-health.js';
import {loggedFetch,readLogs} from '../server/diagnostics.js';
function fixture(names:ConnectionName[]=['YouTrack']){const dir=mkdtempSync(join(tmpdir(),'support-health-')),store=new Store(dir);store.unlock('an isolated health passphrase',true);const config=structuredClone(defaults);for(const name of names){config.connections[name].enabled=true;config.connections[name].endpoint='https://'+name.toLowerCase()+'.internal';config.connections[name].scope='model';}store.config(config,1);const saved=store.snapshot().config;config.prometheusSources=saved.prometheusSources;config.connections.Prometheus=saved.connections.Prometheus;return {store,config,close(){store.close();rmSync(dir,{recursive:true,force:true})}}}
const state=(store:Store,name:ConnectionName='YouTrack')=>toolHealth(store).find(t=>t.name===name)!;
test('scheduled checks count consecutive failures, recover and do not depend on activity',async()=>{
 const f=fixture();let now=Date.now(),calls=0,ok=false;const p=new HealthPoller(f.store,async()=>{calls++;return {ok,detail:ok?'Available':'Unavailable'}},()=>now);
 try{await p.tick();assert.equal(state(f.store).label,'Stale');assert.equal(state(f.store).failures,1);await p.tick();assert.equal(calls,1);
 // A normal request must not reset or escalate scheduled health.
 await (await loggedFetch(f.store,async()=>Response.json({id:'me'}))('https://youtrack.internal/api/users/me')).json();assert.equal(state(f.store).label,'Stale');
 now+=60000;await p.tick();assert.equal(state(f.store).label,'Failed');assert.equal(state(f.store).failures,2);
 ok=true;now+=60000;await p.tick();assert.equal(state(f.store).state,'green');assert.equal(state(f.store).failures,0);
 const logs=readLogs(f.store).total;now+=60000;await p.tick();assert.equal(readLogs(f.store).total,logs);
 }finally{p.stop();f.close()}
});
test('timeout bounds a hanging probe; late completion cannot overwrite the failure',async()=>{
 const f=fixture();let resolve!:(r:HealthResult)=>void;let signal!:AbortSignal;const p=new HealthPoller(f.store,async(_n,_c,s)=>{signal=s;return new Promise(r=>resolve=r)},Date.now,{...healthTimeouts,YouTrack:15});
 try{await p.tick();assert.equal(signal.aborted,true);assert.equal(state(f.store).label,'Stale');assert.match(state(f.store).detail,/Timed out/);resolve({ok:true,detail:'Too late'});await Promise.resolve();assert.equal(state(f.store).label,'Stale');}finally{p.stop();f.close()}
});
test('locked and disabled services are skipped; obsolete credential results are discarded',async()=>{
 const f=fixture();let resolve!:(r:HealthResult)=>void,calls=0;const p=new HealthPoller(f.store,async()=>{calls++;return new Promise(r=>resolve=r)});
 try{const pending=p.tick();await p.tick();assert.equal(calls,1);f.store.credential('YouTrack','replacement');resolve({ok:true,detail:'Old credential'});await pending;assert.equal(state(f.store).label,'Checking');
 f.store.lock();await p.tick();assert.equal(calls,1);assert.equal(state(f.store).label,'Paused');assert.equal(state(f.store,'GitLab').state,'off');}finally{p.stop();f.close()}
});
test('probes never exceed two concurrent services and shutdown aborts pending checks',async()=>{
 const f=fixture(['YouTrack','GitLab','Prometheus']);let calls=0;const signals:AbortSignal[]=[];const p=new HealthPoller(f.store,async(_n,_c,s)=>{calls++;signals.push(s);return new Promise(()=>{})});
 try{const pending=p.tick();await p.tick();assert.equal(calls,2);p.stop();await pending;assert.ok(signals.every(s=>s.aborted));assert.equal(readLogs(f.store).total,0);}finally{p.stop();f.close()}
});
test('HTTP probes authenticate against real API paths, refuse redirects and log no bodies',async()=>{
 const f=fixture(['YouTrack','GitLab','Prometheus','Alertmanager','Outline','Slack','Model']);for(const name of ['YouTrack','GitLab','Model','Slack'])f.store.credential(name,'private-test-credential');
 const requests:{url:URL;init:RequestInit}[]=[];const probe=serviceProbe(f.store,async(input,init)=>{const url=new URL(String(input));requests.push({url,init:init!});return url.pathname.includes('/users/me')?Response.json({id:'me'}):url.pathname.includes('/projects')?Response.json([]):url.pathname.includes('/models/')?Response.json({id:'model'}):url.pathname.includes('auth.test')?Response.json({ok:true}):url.pathname==='/api/v2/status'?Response.json({versionInfo:{version:'0.28'}}):url.pathname==='/api/v1/status/buildinfo'?Response.json({status:'success'}):new Response('OK')});
 try{for(const name of ['YouTrack','GitLab','Prometheus','Alertmanager','Outline','Slack','Model'] as ConnectionName[]){const c=new AbortController();assert.equal((await probe(name,f.config,c.signal)).ok,true)}
 assert.ok(requests.every(r=>r.init.redirect==='manual'&&r.init.signal));
 for(const [path,method] of [['/api/v2/status','GET'],['/api/v1/status/buildinfo','GET'],['/_health','GET'],['/api/auth.test','POST']])assert.ok(requests.some(r=>r.url.pathname===path&&r.init.method===method),path);
 assert.equal((requests.find(r=>r.url.pathname==='/api/auth.test')!.init.headers as Record<string,string>).Authorization,'Bearer private-test-credential');
 assert.ok(requests.filter(r=>r.url.pathname!=='/api/auth.test').every(r=>r.init.method==='GET'));assert.ok(requests.some(r=>r.url.pathname==='/v1/models/model'));assert.equal(readLogs(f.store).total,0);
 const redirect=serviceProbe(f.store,async()=>new Response(null,{status:302,headers:{Location:'https://elsewhere.invalid'}}));assert.equal((await redirect('YouTrack',f.config,new AbortController().signal)).ok,false);
 const fake=serviceProbe(f.store,async()=>new Response('<html>Login</html>'));assert.equal((await fake('YouTrack',f.config,new AbortController().signal)).ok,false);
 }finally{f.close()}
});

test('model catalogs may exceed 128 KB; repo-scoped GitLab checks avoid instance metadata permissions',async()=>{
 const f=fixture(['Model','GitLab']);f.store.credential('Model','private-test-key');f.store.credential('GitLab','private-git-key');
 const urls:string[]=[];const probe=serviceProbe(f.store,async(input)=>{const url=String(input);urls.push(url);return url.includes('/api/v4/projects')?Response.json([{id:1}]):Response.json({id:'model',metadata:'x'.repeat(180000)})});
 try{assert.equal((await probe('Model',f.config,new AbortController().signal)).ok,true);assert.equal((await probe('GitLab',f.config,new AbortController().signal)).ok,true);assert.ok(urls.some(u=>u.endsWith('/api/v4/projects?membership=true&simple=true&per_page=1')));assert.ok(urls.every(u=>!u.endsWith('/version')));}finally{f.close()}
});
test('connection tests use unsaved settings with saved credentials and record no health state or logs',async()=>{
 const f=fixture(['YouTrack']);f.store.credential('YouTrack','private-test-credential');
 const draft=structuredClone(f.config);draft.connections.YouTrack.endpoint='https://draft-youtrack.internal';
 const seen:string[]=[];const probe=serviceProbe(f.store,async(input,init)=>{seen.push(new URL(String(input)).hostname+' '+(init?.headers as Record<string,string>).Authorization);return Response.json({id:'me'})});
 try{
  assert.deepEqual(await testConnection('YouTrack',draft,probe),{ok:true,code:200,detail:'YouTrack API responds and accepts the saved token.'});
  assert.deepEqual(seen,['draft-youtrack.internal Bearer private-test-credential']);
  assert.equal(f.store.snapshot().config.connections.YouTrack.endpoint,'https://youtrack.internal');
  assert.equal(readLogs(f.store).total,0);assert.equal(state(f.store).label,'Checking');
  const slow=await testConnection('YouTrack',draft,()=>new Promise(()=>{}),20);
  assert.deepEqual(slow,{ok:false,detail:'Timed out after 0.02s.'});
 }finally{f.close()}
});
test('an Outline token is checked by reading the configured collection, and service error codes reach the result',async()=>{
 const f=fixture(['Outline','Slack']);f.store.credential('Outline','private-outline-token');f.store.credential('Slack','private-slack-token');
 const requests:{path:string;body:any;init:RequestInit}[]=[];let documents:unknown[]=[{id:'d1'}],status=200;
 const probe=serviceProbe(f.store,async(input,init)=>{const url=new URL(String(input));requests.push({path:url.pathname,body:init?.body?JSON.parse(String(init.body)):null,init:init!});if(status!==200)return new Response('',{status});
  if(url.pathname==='/api/collections.list')return Response.json({data:[{id:'c1',urlId:'AbC123xyz9',name:'Model'},{id:'c2',urlId:'ZzZ987wvu1',name:'Other'}]});
  if(url.pathname==='/api/documents.list')return Response.json({data:documents});
  return Response.json({ok:false,error:'invalid_auth'});});
 const withScope=(scope:string)=>({...f.config,connections:{...f.config.connections,Outline:{...f.config.connections.Outline,scope}}});
 const run=(scope:string)=>probe('Outline',withScope(scope),new AbortController().signal);
 try{
  const named=await run('model');assert.equal(named.ok,true);assert.match(named.detail,/can read documents in the Outline collection "Model"/);
  const list=requests.find(r=>r.path==='/api/documents.list')!;assert.deepEqual(list.body,{collectionId:'c1',limit:1});assert.equal(list.init.method,'POST');assert.equal((list.init.headers as Record<string,string>).Authorization,'Bearer private-outline-token');
  assert.equal((await run('https://outline.internal/collection/other-ZzZ987wvu1')).detail,'The saved token can read documents in the Outline collection "Other".');
  documents=[];assert.match((await run('c2')).detail,/has no documents yet/);
  const missing=await run('Missing');assert.equal(missing.ok,false);assert.match(missing.detail,/cannot see an Outline collection matching "Missing"/);
  requests.length=0;assert.match((await run('')).detail,/No collection is set/);assert.deepEqual(requests.map(r=>r.path),['/api/documents.list']);
  requests.length=0;const uuid='3f1c2b7a-9d4e-4a10-b2c3-0123456789ab';assert.equal((await run(uuid)).ok,true);assert.deepEqual(requests.map(r=>[r.path,r.body.collectionId]),[['/api/documents.list',uuid]]);
  status=401;const refused=await testConnection('Outline',withScope('model'),probe);assert.equal(refused.ok,false);assert.equal(refused.detail,'Outline rejected the saved token: it is invalid, expired or revoked.');
  status=403;const scoped=await run('model');assert.equal(scoped.ok,false);assert.match(scoped.detail,/Add collections:read to the Outline API key, or set the collection ID/);
  const noDocs=await testConnection('Outline',withScope(uuid),probe);assert.equal(noDocs.ok,false);assert.equal(noDocs.detail,"The token's scopes do not allow documents.list. Add documents:read to the Outline API key.");status=200;
  const slack=await probe('Slack',f.config,new AbortController().signal);assert.equal(slack.ok,false);assert.equal(slack.detail,'Service reported: invalid_auth.');
 }finally{f.close()}
});

test('Outline collection references accept a name, an ID, a URL slug or a collection URL',()=>{
 assert.deepEqual(outlineCollectionRef(' DevOps '),{ref:'DevOps',urlId:undefined});
 assert.deepEqual(outlineCollectionRef('devops-AbC123xyz9'),{ref:'devops-AbC123xyz9',urlId:'AbC123xyz9'});
 assert.deepEqual(outlineCollectionRef('https://outline.example.com/collection/dev-ops-AbC123xyz9/recent'),{ref:'dev-ops-AbC123xyz9',urlId:'AbC123xyz9'});
 assert.equal(outlineCollectionRef('AbC123xyz9').urlId,'AbC123xyz9');
});

test('the Prometheus check names the failing server',async()=>{
 const f=fixture([]);
 try{
  f.config.connections.Prometheus.enabled=true;f.config.prometheusSources=[{id:'a',name:'cluster-a',kind:'url',endpoint:'https://a.internal'},{id:'b',name:'cluster-b',kind:'url',endpoint:'https://b.internal'}];
  const probe=serviceProbe(f.store,async input=>new URL(String(input)).hostname==='a.internal'?Response.json({status:'success'}):new Response('no',{status:401}));
  const r=await probe('Prometheus',f.config,new AbortController().signal);
  assert.equal(r.ok,false);assert.match(r.detail,/^cluster-b: authentication or access denied/);
 }finally{f.close()}
});

test('the GitLab check tells a rejected token from a token that cannot list projects',async()=>{
 const f=fixture(['GitLab']);f.store.credential('GitLab','glpat-x');
 const answer=(self:number,list:number)=>serviceProbe(f.store,async input=>{const p=new URL(String(input)).pathname;return p.endsWith('/personal_access_tokens/self')?(self===200?Response.json({name:'support',active:true,revoked:false,expires_at:new Date(Date.now()+5*86400000).toISOString().slice(0,10)}):new Response('',{status:self})):list===200?Response.json([]):new Response('',{status:list});});
 try{
  let r=await answer(200,200)('GitLab',f.config,new AbortController().signal);assert.equal(r.ok,true);assert.match(r.detail,/"support"/);assert.match(r.detail,/renew it/);
  r=await answer(401,401)('GitLab',f.config,new AbortController().signal);assert.equal(r.ok,false);assert.match(r.detail,/invalid, expired or revoked/);
  r=await answer(403,403)('GitLab',f.config,new AbortController().signal);assert.equal(r.ok,true);assert.match(r.detail,/cannot list projects/);
  r=await answer(404,200)('GitLab',f.config,new AbortController().signal);assert.equal(r.ok,true);assert.match(r.detail,/project API responds/);
 }finally{f.close()}
});

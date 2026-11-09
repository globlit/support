import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {defaults,type ConnectionName} from '../src/model.js';
import {HealthPoller,serviceProbe,testConnection} from '../server/health-poller.js';
import {toolHealth,healthTimeouts,type HealthResult} from '../server/tool-health.js';
import {loggedFetch,readLogs} from '../server/diagnostics.js';
function fixture(names:ConnectionName[]=['YouTrack']){const dir=mkdtempSync(join(tmpdir(),'support-health-')),store=new Store(dir);store.unlock('an isolated health passphrase',true);const config=structuredClone(defaults);for(const name of names){config.connections[name].enabled=true;config.connections[name].endpoint='https://'+name.toLowerCase()+'.internal';config.connections[name].scope='model';}store.config(config,1);return {store,config,close(){store.close();rmSync(dir,{recursive:true,force:true})}}}
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
test('an Outline token is checked with auth.info, and service error codes reach the result',async()=>{
 const f=fixture(['Outline','Slack']);f.store.credential('Outline','private-outline-token');f.store.credential('Slack','private-slack-token');
 const requests:{url:URL;init:RequestInit}[]=[];const probe=serviceProbe(f.store,async(input,init)=>{const url=new URL(String(input));requests.push({url,init:init!});return url.pathname==='/api/auth.info'?Response.json({data:{user:{id:'u'}}}):Response.json({ok:false,error:'invalid_auth'});});
 try{
  const outline=await probe('Outline',f.config,new AbortController().signal);assert.equal(outline.ok,true);assert.match(outline.detail,/accepts the saved token/);
  const call=requests.find(r=>r.url.pathname==='/api/auth.info')!;assert.equal(call.init.method,'POST');assert.equal((call.init.headers as Record<string,string>).Authorization,'Bearer private-outline-token');
  const slack=await probe('Slack',f.config,new AbortController().signal);assert.equal(slack.ok,false);assert.equal(slack.detail,'Service reported: invalid_auth.');
 }finally{f.close()}
});

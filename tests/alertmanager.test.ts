import {setHandling} from '../server/intake.js';
import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {Alertmanager} from '../server/alertmanager.js';
import {wireQueue} from './queue-fixture.js';
import {Claude} from '../server/claude.js';
import {YouTrack} from '../server/youtrack.js';

const sample=(patch:Record<string,unknown>={})=>({fingerprint:'abc',labels:{alertname:'PodCrashLoop',cluster:'dev',namespace:'apps',pod:'web-1',severity:'warning'},annotations:{summary:'Pod keeps restarting'},startsAt:'2026-11-07T09:00:00Z',endsAt:'2026-11-07T12:00:00Z',updatedAt:'2026-11-07T09:00:10Z',status:{state:'active'},...patch});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'support-alerts-'));let store=new Store(dir);store.unlock('temporary test passphrase',true);
 store.credential('Alertmanager','private-bearer');store.credential('Model','private-model-key');
 const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,Alertmanager:{enabled:true,endpoint:'https://alerts.internal/am',scope:'team="infra"\ncluster!="prod"',path:''},Model:{enabled:true,endpoint:'https://model.internal',scope:'test-model',path:''}}},s.configRevision);
 const remote:{body:unknown;status:number;delay?:()=>Promise<void>;calls:number}={body:[sample()],status:200,calls:0};
 const fetcher=(async(url,options)=>{remote.calls++;assert.equal(options?.method,'GET');assert.equal(options?.redirect,'manual');const u=new URL(String(url));assert.equal(u.origin,'https://alerts.internal');assert.equal(u.pathname,'/am/api/v2/alerts');assert.equal((options?.headers as Record<string,string>).Authorization,'Bearer private-bearer');assert.deepEqual(u.searchParams.getAll('filter'),['team="infra"','cluster!="prod"']);for(const key of ['active','silenced','inhibited','unprocessed'])assert.equal(u.searchParams.get(key),'true');await remote.delay?.();return Response.json(remote.body,{status:remote.status});}) as typeof fetch;
 let alerts=new Alertmanager(store,fetcher);
 return {get store(){return store},get alerts(){return alerts},remote,
  async allow(){for(const c of alerts.queue().cases){const d=await alerts.work(c.id);setHandling(store,d.issue,{mode:'investigate',reason:'',revision:d.session.revision,sourceUpdated:d.issue.updated});}},
  settings(patch:Partial<ReturnType<Store['snapshot']>['config']['alerting']>){const s=store.snapshot();store.config({...s.config,alerting:{...s.config.alerting,...patch}},s.configRevision);},
  restart(){store.close();store=new Store(dir);store.unlock('temporary test passphrase');alerts=new Alertmanager(store,fetcher);},
  done(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
async function wait(c:Claude,id:string){for(let i=0;i<200;i++){const r=c.status(id);if(r.state!=='running')return r;await new Promise(r=>setTimeout(r,5));}throw new Error('Analysis timeout');}
const plan=()=>Response.json({stop_reason:'tool_use',content:[{type:'tool_use',id:'plan',name:'prepare_plan',input:{plan:'1. Check workload status.\n2. Propose a Flux change.\n3. Verify recovery.',replyDraft:'Please confirm the intended namespace.'}}]});

test('repeated polls and notification timestamps produce one stable case, including after restart',async()=>{
 const f=fixture();try{await f.alerts.poll();const first=f.alerts.queue().cases[0];
  f.remote.body=[sample({endsAt:'2026-11-07T13:00:00Z',updatedAt:'2026-11-07T10:00:00Z'})];await f.alerts.poll();
  assert.equal(f.alerts.queue().cases.length,1);assert.equal(f.alerts.queue().cases[0].updated,first.updated);assert.equal(f.alerts.queue().cases[0].episodes,1);
  f.restart();await f.alerts.poll();assert.equal(f.alerts.queue().cases[0].id,first.id);assert.equal(f.alerts.queue().cases[0].episodes,1);
 }finally{f.done();}
});
test('severity escalation stays in one case; configured grouping combines instances but separates clusters',async()=>{
 const f=fixture();try{await f.alerts.poll();const id=f.alerts.queue().cases[0].id;const labels={...sample().labels,severity:'critical'};
  f.remote.body=[sample({fingerprint:'def',labels})];await f.alerts.poll();assert.equal(f.alerts.queue().cases[0].id,id);assert.equal(f.alerts.queue().cases[0].severity,'critical');
  f.settings({groupBy:'alertname, cluster, namespace'});f.remote.body=[sample(),sample({fingerprint:'two',labels:{...labels,pod:'web-2'}}),sample({fingerprint:'three',labels:{...labels,cluster:'preprod'}}),sample({fingerprint:'info',labels:{...labels,severity:'info'}})];
  await f.alerts.poll();const cases=f.alerts.queue().cases;assert.equal(cases.length,2);assert.equal(cases.find(c=>c.labels.cluster==='dev')?.members.length,2);
 }finally{f.done();}
});
test('suppression remains present; absence and recurrence revoke approvals without losing plans or notes',async()=>{
 const f=fixture();try{await f.alerts.poll();const id=f.alerts.queue().cases[0].id;await f.allow();let d=await f.alerts.work(id);
  d=await f.alerts.action(id,{action:'plan',text:'Investigate and propose a change',revision:d.session.revision,sourceUpdated:d.issue.updated});
  d=await f.alerts.action(id,{action:'approve',revision:d.session.revision,sourceUpdated:d.issue.updated});assert.ok(d.session.approval);
  f.remote.body=[sample({status:{state:'suppressed'}})];await f.alerts.poll();assert.ok(f.alerts.queue().cases[0].active);assert.ok(f.alerts.queue().cases[0].suppressed);assert.equal(f.alerts.queue().cases[0].session.approval,null);
  f.remote.body=[];await f.alerts.poll();assert.equal(f.alerts.queue().cases[0].active,false);
  f.remote.body=[sample()];await f.alerts.poll();const c=f.alerts.queue().cases[0];assert.equal(c.id,id);assert.equal(c.episodes,2);assert.equal(c.session.plans.length,1);
  f.remote.body=[sample({startsAt:'2026-11-07T11:00:00Z'})];await f.alerts.poll();assert.equal(f.alerts.queue().cases[0].episodes,3);
 }finally{f.done();}
});
for(const mode of ['unavailable','redirect','invalid','oversized'] as const)test(`poll ${mode} keeps previous cases and records a visible error`,async()=>{
 const f=fixture();try{await f.alerts.poll();const first=f.alerts.queue().cases[0];
  if(mode==='unavailable')f.remote.status=503;if(mode==='redirect')f.remote.status=302;
  if(mode==='invalid')f.remote.body=[{labels:{}}];if(mode==='oversized')f.remote.body='x'.repeat(2_000_001);
  await assert.rejects(f.alerts.poll());assert.ok(f.alerts.queue().error);const c=f.alerts.queue().cases[0];assert.equal(c.active,true);assert.equal(c.updated,first.updated);assert.equal(c.episodes,1);
 }finally{f.done();}
});
test('concurrent polls share one request and credential changes discard the response',async()=>{
 const f=fixture();try{let release!:()=>void;f.remote.delay=()=>new Promise<void>(r=>release=r);const a=f.alerts.poll(),b=f.alerts.poll();assert.equal(f.remote.calls,1);f.store.lock();release();await assert.rejects(a);await assert.rejects(b);assert.equal(f.store.alertCases().length,0);assert.equal(f.alerts.queue().paused,true);
 }finally{f.done();}
});
test('settings edits discard in-flight results; remote HTTP is rejected before credentials leave',async()=>{
 const f=fixture();try{let release!:()=>void;f.remote.delay=()=>new Promise<void>(r=>release=r);const pending=f.alerts.poll();f.settings({groupBy:'alertname,cluster'});release();await assert.rejects(pending);assert.equal(f.store.alertCases().length,0);
  const s=f.store.snapshot();f.store.config({...s.config,connections:{...s.config.connections,Alertmanager:{...s.config.connections.Alertmanager,endpoint:'http://alerts.internal'}}},s.configRevision);
  await assert.rejects(f.alerts.poll(),/HTTPS/);assert.equal(f.remote.calls,1);
 }finally{f.done();}
});
test('stored and model-visible alert content redacts vault values and sensitive labels',async()=>{
 const f=fixture();try{f.remote.body=[sample({labels:{...sample().labels,token:'sensitive-label'},annotations:{summary:'private-bearer token=plaintext'}})];await f.alerts.poll();
  const serialized=JSON.stringify(f.store.alertCases());assert.ok(!serialized.includes('private-bearer'));assert.ok(!serialized.includes('sensitive-label'));assert.ok(!serialized.includes('plaintext'));
 }finally{f.done();}
});
test('Claude investigates alerts with read tools, saves plans for review, and supports revisions',async()=>{
 const f=fixture();try{const s=f.store.snapshot();f.store.config({...s.config,connections:{...s.config.connections,Prometheus:{enabled:true,endpoint:'',scope:'',path:''}},prometheusSources:[{id:'legacy',name:'prometheus',kind:'url',endpoint:'https://metrics.internal'}]},s.configRevision);await f.alerts.poll();let turns=0,reads=0;
  const c=new Claude(f.store,new YouTrack(f.store),(async(url,options)=>{const u=new URL(String(url));if(u.hostname==='metrics.internal'){reads++;assert.equal(options?.method,'GET');return Response.json({status:'success',data:{result:[]}});}assert.equal(u.hostname,'model.internal');assert.ok(!String(options?.body).includes('private-bearer'));if(turns++===0)return Response.json({stop_reason:'tool_use',content:[{type:'tool_use',id:'read',name:'prometheus_query',input:{query:'up'}}]});return plan();}) as typeof fetch);
  await f.allow();let d=await f.alerts.work(f.alerts.queue().cases[0].id);const run=await f.alerts.analyze(d.issue.id,{revision:d.session.revision,sourceUpdated:d.issue.updated},c);assert.equal((await wait(c,run.id)).state,'ready');assert.equal(reads,1);
  d=await f.alerts.work(d.issue.id);assert.equal(d.session.plans.length,1);assert.equal(d.session.approval,null);
  d=await f.alerts.action(d.issue.id,{action:'approve',revision:d.session.revision,sourceUpdated:d.issue.updated});assert.ok(d.session.approval);
  d=await f.alerts.action(d.issue.id,{action:'revise',text:'Include rollback steps',revision:d.session.revision,sourceUpdated:d.issue.updated});assert.equal(d.session.approval,null);
  const revised=await f.alerts.analyze(d.issue.id,{revision:d.session.revision,sourceUpdated:d.issue.updated},c);assert.equal((await wait(c,revised.id)).state,'ready');assert.equal((await f.alerts.work(d.issue.id)).session.plans.length,2);
 }finally{f.done();}
});
test('alert changes during analysis discard the plan and stale approvals are rejected',async()=>{
 const f=fixture();try{let release!:()=>void;const c=new Claude(f.store,new YouTrack(f.store),(async()=>{await new Promise<void>(r=>release=r);return plan();}) as typeof fetch);await f.alerts.poll();await f.allow();const d=await f.alerts.work(f.alerts.queue().cases[0].id);
  const run=await f.alerts.analyze(d.issue.id,{revision:d.session.revision,sourceUpdated:d.issue.updated},c);f.remote.body=[];release();assert.equal((await wait(c,run.id)).state,'failed');assert.equal((await f.alerts.work(d.issue.id)).session.plans.length,0);
  await assert.rejects(f.alerts.action(d.issue.id,{action:'approve',revision:d.session.revision,sourceUpdated:d.issue.updated}),/changed/);
 }finally{f.done();}
});
test('automatic analysis is opt-in, once per occurrence, and failures never loop or write to tools',async()=>{
 const f=fixture();try{let calls=0;const c=new Claude(f.store,new YouTrack(f.store),(async()=>{calls++;return Response.json({stop_reason:'tool_use',content:[{type:'tool_use',id:'bad',name:'silence_alert',input:{}}]});}) as typeof fetch);const q=wireQueue(f.store,c,{alert:{load:id=>f.alerts.work(id),start:(id,e)=>f.alerts.analyze(id,e,c),onStartError:(id,e)=>f.alerts.recordStartFailure(id,e)}});const tick=async()=>{await f.alerts.tick(c,q);await q.tick();};
  await tick();assert.equal(calls,0);f.settings({autoInvestigate:true});await tick();assert.equal(calls,0);await f.allow();await tick();let item=f.alerts.queue(c).cases[0];assert.ok(item.run);assert.equal((await wait(c,item.run!.id)).state,'failed');
  await tick();assert.equal(calls,3);assert.equal(f.alerts.queue(c).cases[0].run?.state,'failed');
  f.remote.body=[];await f.alerts.poll();f.remote.body=[sample()];await f.alerts.poll();await tick();item=f.alerts.queue(c).cases[0];await wait(c,item.run!.id);assert.equal(calls,6);
 }finally{f.done();}
});
test('ticket links are read-only, survive restart and recurrence, and cannot be silently replaced',async()=>{
 const f=fixture();try{const s=f.store.snapshot();f.store.config({...s.config,connections:{...s.config.connections,YouTrack:{enabled:true,endpoint:'https://yt.internal',scope:'project: INFRA',path:''}}},s.configRevision);f.store.credential('YouTrack','private-yt');
  const yt=new YouTrack(f.store,(async(url,opts)=>{assert.equal(opts?.method,'GET');const other=String(url).includes('99');return Response.json({id:other?'2-99':'2-42',idReadable:other?'INFRA-99':'INFRA-42',summary:'Existing incident',updated:1000,resolved:null});}) as typeof fetch);
  await f.alerts.poll();const id=f.alerts.queue().cases[0].id;await f.alerts.link(id,'INFRA-42',yt);await assert.rejects(f.alerts.link(id,'INFRA-99',yt),/already linked/);
  f.restart();f.remote.body=[];await f.alerts.poll();f.remote.body=[sample()];await f.alerts.poll();assert.equal(f.alerts.queue().cases.length,1);assert.equal(f.alerts.queue().cases[0].ticket?.key,'INFRA-42');
 }finally{f.done();}
});
test('network failures name the underlying cause',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-alerts-net-'));const store=new Store(dir);store.unlock('temporary test passphrase',true);
 try{
  const set=(endpoint:string)=>{const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,Alertmanager:{enabled:true,endpoint,scope:'',path:''}}},s.configRevision);};
  set('https://alerts.internal');
  let failure:unknown=Object.assign(new TypeError('fetch failed'),{cause:{code:'ENOTFOUND'}});let calls=0;
  const alerts=new Alertmanager(store,(async()=>{calls++;throw failure;}) as typeof fetch);
  await assert.rejects(alerts.poll(),/Connection interrupted: Host not found \(DNS\)/);assert.match(alerts.queue().error??'',/Host not found/);
  failure=new DOMException('The operation was aborted due to timeout','TimeoutError');
  await assert.rejects(alerts.poll(),/No response before the timeout/);
  failure=Object.assign(new TypeError('fetch failed'),{cause:{code:'SELF_SIGNED_CERT_IN_CHAIN'}});
  await assert.rejects(alerts.poll(),/NODE_EXTRA_CA_CERTS/);
  assert.equal(calls,3);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('opening an alert reuses a recent poll, while a check before a write polls Alertmanager again',async()=>{
 const f=fixture();
 try{
  await f.alerts.poll();const id=f.alerts.queue().cases[0].id,after=f.remote.calls;
  await f.alerts.work(id);await f.alerts.work(id);
  assert.equal(f.remote.calls,after,'display reads use the poll of the last interval');
  await f.alerts.work(id,0);
  assert.equal(f.remote.calls,after+1,'a read before a write polls first');
 }finally{f.done()}
});

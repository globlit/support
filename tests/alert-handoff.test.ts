import {setHandling} from '../server/intake.js';
import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {Alertmanager} from '../server/alertmanager.js';
import {YouTrack} from '../server/youtrack.js';
import {AlertHandoffs} from '../server/alert-handoff.js';
import {Changes} from '../server/changes.js';
import {Claude} from '../server/claude.js';

async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'support-handoff-'));let store=new Store(dir);store.unlock('temporary test passphrase',true);
 for(const name of ['YouTrack','GitLab','Model'])store.credential(name,'fixture-key-'+name);
 const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,Alertmanager:{endpoint:'https://am.internal',scope:'',path:'',enabled:true},YouTrack:{endpoint:'https://yt.internal',scope:'project: INFRA',path:'',enabled:true},GitLab:{endpoint:'https://git.internal',scope:'',path:'',enabled:true},Model:{endpoint:'https://model.internal',scope:'fixture-model',path:'',enabled:true}}},s.configRevision);
 const remote={updated:1000,resolved:false,present:true,summary:'Restart detected',severity:'warning',gitReads:0,ytHook:undefined as undefined|(()=>void)};
 const fetcher=(async(url,opts)=>{assert.equal(opts?.method,'GET');const u=new URL(String(url));
  if(u.hostname==='am.internal')return Response.json(remote.present?[{fingerprint:'abc',labels:{alertname:'Payments restarts',cluster:'dev',severity:remote.severity},annotations:{summary:remote.summary},startsAt:'2026-11-07T10:00:00Z',status:{state:'active'}}]:[]);
  if(u.hostname==='git.internal'){remote.gitReads++;return Response.json({}, {status:404});}
  assert.equal(u.hostname,'yt.internal');remote.ytHook?.();return Response.json({id:'2-42',idReadable:'INFRA-42',summary:'Investigate payments deployment',description:'Use the development Flux repository.',updated:remote.updated,resolved:remote.resolved?2000:null});
 }) as typeof fetch;
 let am=new Alertmanager(store,fetcher),yt=new YouTrack(store,fetcher),handoff=new AlertHandoffs(store,am,yt);
 await am.poll();const id=am.queue().cases[0].id;const intake=await am.work(id);setHandling(store,intake.issue,{mode:'investigate',reason:'',revision:intake.session.revision,sourceUpdated:intake.issue.updated});await am.link(id,'2-42',yt);
 async function sourceAction(action:'plan'|'note'|'draft'|'revise'|'approve',text?:string){const d=await am.work(id);return am.action(id,{action,text,revision:d.session.revision,sourceUpdated:d.issue.updated});}
 await sourceAction('plan','1. Inspect development rollout.\n2. Prepare a Flux change.\n3. Validate and retain rollback.\n'+'Detailed check. '.repeat(700));
 await sourceAction('note','Keep the previous image tag.');await sourceAction('draft','Please confirm the intended image.');await sourceAction('approve');
 const source=await am.work(id);source.session.analysis={model:'fixture-model',events:[{at:new Date().toISOString(),text:'Read Prometheus restart rate'},{at:new Date().toISOString(),text:'Read scoped Kubernetes pod status'}]};store.saveWorkSession(source.session);
 return {id,remote,fetcher,sourceAction,get store(){return store},get am(){return am},get yt(){return yt},get handoff(){return handoff},
  restart(){store.close();store=new Store(dir);store.unlock('temporary test passphrase');am=new Alertmanager(store,fetcher);yt=new YouTrack(store,fetcher);handoff=new AlertHandoffs(store,am,yt);},
  done(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('handoff preserves the full plan and investigation, retains ticket work, and never transfers approval',async()=>{
 const f=await fixture();try{
  let t=await f.yt.work('2-42');for(const [action,text] of [['plan','Existing ticket plan'],['note','Existing ticket constraint'],['draft','Existing reply']] as const){t=await f.yt.action('2-42',{action,text,revision:t.session.revision,sourceUpdated:t.issue.updated});}
  t=await f.yt.action('2-42',{action:'approve',revision:t.session.revision,sourceUpdated:t.issue.updated});assert.ok(t.session.approval);
  const source=await f.am.work(f.id),review=await f.handoff.preview(f.id);assert.equal((await f.yt.work('2-42')).session.plans.length,1);
  const result=await f.handoff.carry(f.id,review.hash),w=result.detail.session;
  assert.equal(w.plans.length,2);assert.equal(w.plans[0].text,'Existing ticket plan');assert.equal(w.plans[1].text,source.session.plans[0].text);assert.equal(w.approval,null);
  assert.equal(w.draft,'Existing reply');assert.equal(w.notes[0].text,'Existing ticket constraint');assert.deepEqual(result.handoff.notes,source.session.notes);assert.deepEqual(result.handoff.analysis,source.session.analysis);assert.equal(result.handoff.replyDraft,source.session.draft);
  assert.ok((await f.am.work(f.id)).session.approval);assert.equal(result.handoff.targetPlanVersion,2);
 }finally{f.done();}
});
test('new ticket sessions receive the draft, and repeated requests across restart do not duplicate or clear later approval',async()=>{
 const f=await fixture();try{const preview=await f.handoff.preview(f.id);const first=await f.handoff.carry(f.id,preview.hash);assert.equal(first.detail.session.draft,'Please confirm the intended image.');
  const approved=await f.yt.action('2-42',{action:'approve',revision:first.detail.session.revision,sourceUpdated:first.detail.issue.updated});f.restart();
  const repeated=await f.handoff.carry(f.id,preview.hash);assert.equal(repeated.alreadyImported,true);assert.equal(repeated.detail.session.plans.length,1);assert.deepEqual(repeated.detail.session.approval,approved.session.approval);
  const fresh=await f.handoff.preview(f.id);assert.equal(fresh.alreadyImported,1);assert.equal((await f.handoff.carry(f.id,fresh.hash)).alreadyImported,true);
 }finally{f.done();}
});
test('GitLab preparation stays blocked until the current YouTrack plan receives fresh approval',async()=>{
 const f=await fixture();try{const preview=await f.handoff.preview(f.id),carried=await f.handoff.carry(f.id,preview.hash),changes=new Changes(f.store,f.yt,f.fetcher);
  const input={project:'infra/flux',paths:['deploy.yaml'],revision:carried.detail.session.revision,sourceUpdated:carried.detail.issue.updated};
  await assert.rejects(changes.prepare('2-42',input),/Approve the current plan/);assert.equal(f.remote.gitReads,0);
  const approved=await f.yt.action('2-42',{action:'approve',revision:input.revision,sourceUpdated:input.sourceUpdated});
  await assert.rejects(changes.prepare('2-42',{...input,revision:approved.session.revision}),/cannot access it/);assert.equal(f.remote.gitReads,1);
 }finally{f.done();}
});
for(const changed of ['alert','source-note','source-plan','ticket','target-note','settings','vault','resolved','revision'] as const)test(`stale ${changed} handoff cannot append a plan`,async()=>{
 const f=await fixture();try{const preview=await f.handoff.preview(f.id);
  if(changed==='alert')f.remote.severity='critical';
  if(changed==='source-note')await f.sourceAction('note','New source constraint');
  if(changed==='source-plan')await f.sourceAction('plan','Revised alert plan');
  if(changed==='ticket')f.remote.updated++;
  if(changed==='target-note'){const t=await f.yt.work('2-42');await f.yt.action('2-42',{action:'note',text:'New ticket constraint',revision:t.session.revision,sourceUpdated:t.issue.updated});}
  if(changed==='settings'){const s=f.store.snapshot();f.store.config({...s.config,engineer:'Changed'},s.configRevision);}
  if(changed==='vault')f.store.lock();if(changed==='resolved')f.remote.resolved=true;
  if(changed==='revision')await f.sourceAction('revise','Change the alert plan first');
  await assert.rejects(f.handoff.carry(f.id,preview.hash));assert.equal(f.store.getWorkSession(preview.target.connection,'2-42')?.plans.length??0,0);
 }finally{f.done();}
});
test('a new source revision appends a version while preserving an unresolved ticket revision request',async()=>{
 const f=await fixture();try{let review=await f.handoff.preview(f.id);const first=await f.handoff.carry(f.id,review.hash);
  await f.yt.action('2-42',{action:'revise',text:'Check ownership before changes',revision:first.detail.session.revision,sourceUpdated:first.detail.issue.updated});
  await f.sourceAction('plan','Updated source plan, awaiting ticket review');review=await f.handoff.preview(f.id);assert.equal(review.target.pendingRevision,true);
  const second=await f.handoff.carry(f.id,review.hash);assert.equal(second.detail.session.plans.length,2);assert.equal(second.detail.session.pendingRevision,true);assert.equal(second.detail.session.alertHandoffs?.length,2);
  await assert.rejects(f.yt.action('2-42',{action:'approve',revision:second.detail.session.revision,sourceUpdated:second.detail.issue.updated}),/revised plan/);
 }finally{f.done();}
});
test('concurrent local feedback during source reads is rejected instead of overwritten',async()=>{
 const f=await fixture();try{const review=await f.handoff.preview(f.id);f.remote.ytHook=()=>{const c=f.store.alert(f.id),w=f.store.getWorkSession(c.connection,f.id)!;w.notes.push({at:new Date().toISOString(),text:'During read'});w.revision++;f.store.saveWorkSession(w);};
  await assert.rejects(f.handoff.carry(f.id,review.hash),/changed/);assert.equal(f.store.getWorkSession(review.target.connection,'2-42')?.plans.length??0,0);
 }finally{f.done();}
});
test('missing plans and wrong linked instances block handoff',async()=>{
 const f=await fixture();try{const c=f.store.alert(f.id),w=f.store.getWorkSession(c.connection,f.id)!;w.plans=[];f.store.saveWorkSession(w);await assert.rejects(f.handoff.preview(f.id),/Prepare an alert plan/);
  await f.sourceAction('plan','New plan');c.ticket!.connection='different-instance';f.store.saveAlert(c);await assert.rejects(f.handoff.preview(f.id),/linked YouTrack instance/);
 }finally{f.done();}
});
test('Claude ticket revisions receive the imported investigation and feedback',async()=>{
 const f=await fixture();try{const review=await f.handoff.preview(f.id),r=await f.handoff.carry(f.id,review.hash);let called=false;
  const claude=new Claude(f.store,f.yt,(async(_url,options)=>{called=true;const body=JSON.parse(String(options?.body)),context=JSON.parse(body.messages[0].content);assert.equal(context.recentAlertHandoffs[0].notes[0].text,'Keep the previous image tag.');assert.equal(context.recentAlertHandoffs[0].analysis.events.length,2);assert.equal(context.previousPlan,r.detail.session.plans[0].text);
   return Response.json({stop_reason:'tool_use',content:[{type:'tool_use',id:'done',name:'prepare_plan',input:{plan:'Refined ticket plan using the imported investigation.',replyDraft:''}}]});}) as typeof fetch);
  const run=await claude.start('2-42',{revision:r.detail.session.revision,sourceUpdated:r.detail.issue.updated});for(let i=0;i<100&&claude.status(run.id).state==='running';i++)await new Promise(r=>setTimeout(r,5));assert.equal(claude.status(run.id).state,'ready');assert.ok(called);
  const w=(await f.yt.work('2-42')).session;assert.equal(w.plans.length,2);assert.equal(w.alertHandoffs?.length,1);assert.equal(w.approval,null);
 }finally{f.done();}
});

test('a pending GitLab write must be reconciled before a new plan is carried',async()=>{
 const f=await fixture();try{const review=await f.handoff.preview(f.id),now=new Date().toISOString();
  f.store.saveChange({id:'pending-branch',connection:review.target.connection,issueId:'2-42',planVersion:1,planApproval:'',sessionRevision:1,configRevision:2,sourceUpdated:1000,endpoint:'https://git.internal/',repositoryPath:'/workspace/flux',project:'infra/flux',target:'main',base:'a'.repeat(40),branch:'support/pending',files:[],diffs:[],title:'Pending branch',description:'',state:'branch_pending',message:'Check remote status',createdAt:now,updatedAt:now});
  await assert.rejects(f.handoff.carry(f.id,review.hash),/pending external operation/);assert.equal(f.store.getWorkSession(review.target.connection,'2-42')?.plans.length??0,0);
 }finally{f.done();}
});

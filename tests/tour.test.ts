import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {createTourFixture,tourReader} from '../src/tour-fixtures';
import {tourSteps} from '../src/tour-journey';
import {WorkspacePreviewProvider} from '../src/WorkspaceRuntime';
import {PlanReview} from '../src/PlanReview';
import {IssueList} from '../src/IssueList';
import {IntakeDecision} from '../src/IntakeDecision';

test('tour transport is isolated, rejects every write and unknown reads without fetch',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Network must not be used')};
 try{
  const read=tourReader({'/example':{items:['safe']}});
  const value=await read<{items:string[]}>('/example');value.items.push('changed');assert.deepEqual(await read('/example'),{items:['safe']});
  for(const method of ['POST','PUT','PATCH','DELETE','HEAD'])await assert.rejects(read('/example',method),/No workspace request/);
  await assert.rejects(read('/state'),/No workspace request/);assert.equal(calls,0);
 }finally{globalThis.fetch=original}
});
test('each tour ticket scene has a coherent production detail, read history and approvals',async()=>{
 for(const step of tourSteps){if(!step.scene)continue;const f=createTourFixture(step.scene),p=f.preview.route;
  if(step.scene==='ai'||step.scene==='dashboard'){assert.ok(await f.preview.request(step.scene==='ai'?'/ai/activity':'/dashboard?days=7&interval=day'));continue;}
  if(['queue','list','board'].includes(step.scene)){const q=await f.preview.request<{issues:unknown[]}>('/youtrack/issues?offset=0');assert.equal(q.issues.length,1);continue;}
  const prefix=p.page==='alerts'?'/alerts':p.page==='slack'?'/slack':'/youtrack/issues';
  const detail=await f.preview.request<typeof f.detail>(prefix+'/'+p.issue);assert.equal(detail.issue.id,p.issue);assert.equal(detail.session.issueId,detail.issue.id);assert.equal(detail.session.connection,detail.issue.connection);
  assert.deepEqual(await f.preview.request(prefix+'/'+p.issue+'/changes'),f.changes);
  assert.deepEqual(await f.preview.request(prefix+'/'+p.issue+'/investigations'),f.run?[f.run]:[]);
  if(['diff','mr','pipeline','reply'].includes(step.scene)){assert.equal(detail.session.approval?.version,2);assert.equal(f.changes[0].planVersion,2);}
  if(step.scene==='reply'){assert.equal(f.changes[0].tracking?.state,'merged');assert.equal(f.changes[0].tracking?.pipeline?.status,'success');assert.equal(f.changes[0].resolution?.state,'draft');}
 }
});
function render(scene:Parameters<typeof createTourFixture>[0],child:(f:ReturnType<typeof createTourFixture>)=>ReturnType<typeof createElement>){const f=createTourFixture(scene);return renderToStaticMarkup(createElement(WorkspacePreviewProvider,{value:f.preview,children:child(f)}));}
test('preview renders real list columns without reading browser storage',()=>{
 const html=render('list',f=>createElement(IssueList,{issues:[f.detail.issue],scope:'live-filter-scope',open:()=>{}}));
 for(const column of ['Issue','Request','Status','Priority','Assignee'])assert.match(html,new RegExp(column));
 assert.match(html,/status-pill pending/);assert.match(html,/compact-queue/);assert.match(html,/EXAMPLE-1/);
});
test('plan preview renders production approval, version controls, annotations and queued comments',()=>{
 const html=render('comment',f=>createElement(PlanReview,{detail:f.detail,busy:false,running:false,action:async()=>false,investigate:()=>{}}));
 assert.match(html,/Plan version/);assert.match(html,/Version 1/);assert.match(html,/comment to address/);assert.match(html,/Send for revision/);assert.match(html,/Include the exact endpoint/);assert.match(html,/comment-highlight/);
 const approve=render('approve',f=>createElement(PlanReview,{detail:f.detail,busy:false,running:false,action:async()=>false}));assert.match(approve,/Approve plan version 2/);assert.deepEqual(createTourFixture('approve').detail.session.plans.map(p=>p.version),[1,2]);assert.match(approve,/Version 2/);
});
test('ownership and ignore scenes use the real handling form and scope controls',()=>{
 const ownership=render('ownership',f=>createElement(IntakeDecision,{detail:f.detail,changed:()=>{}}));assert.match(ownership,/Take over/);assert.match(ownership,/Reason \(required\)/);assert.match(ownership,/Confirm/);
 const ignored=render('ignore',f=>createElement(IntakeDecision,{detail:f.alert!,alert:f.alert!.alert,changed:()=>{}}));for(const label of ['Production scope','eu-west','eu-central','Add ignore rule','1 hour'])assert.ok(ignored.includes(label));
});
test('preview transport does not replace the live workspace transport outside its provider',async()=>{
 const {useWorkspaceApi,useWorkspaceNavigation}=await import('../src/WorkspaceRuntime');
 const {api}=await import('../src/api');const {navigate}=await import('../src/navigation');
 let request:typeof api|undefined,go:typeof navigate|undefined;
 function Probe(){request=useWorkspaceApi();go=useWorkspaceNavigation().navigate;return null;}
 const fixture=createTourFixture('plan');
 renderToStaticMarkup(createElement(WorkspacePreviewProvider,{value:fixture.preview,children:createElement(Probe)}));assert.equal(request,fixture.preview.request);assert.notEqual(go,navigate);
 renderToStaticMarkup(createElement(Probe));assert.equal(request,api);assert.equal(go,navigate);
});

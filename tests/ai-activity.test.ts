import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {YouTrack} from '../server/youtrack.js';
import {Claude} from '../server/claude.js';
import {aiOverview,summarizeRun,workflowState,type SessionSummary,type ChangeSummary} from '../server/ai-activity.js';
import type {AnalysisRun,WorkSession} from '../src/model.js';
const at='2026-11-07T12:00:00Z',later='2026-11-07T12:01:00Z';
const session:SessionSummary={connection:'yt',issueId:'1',updatedAt:at,planAt:at,planVersion:1};
const change:ChangeSummary={connection:'yt',issueId:'1',updatedAt:later,planVersion:1,state:'created',message:'Created',trackingState:'opened'};
test('workflow states distinguish real work, review waits, external waits and unresolved writes',()=>{
 assert.deepEqual(workflowState(session,undefined,undefined),{state:'waiting',stage:'Plan approval',reason:'Review plan v1.'});
 assert.equal(workflowState({...session,pendingRevision:1},undefined,undefined).stage,'Plan revision');
 assert.equal(workflowState(session,{...change,state:'review'},undefined).stage,'Diff approval');
 assert.equal(workflowState(session,{...change,pipeline:'running'},undefined).stage,'Pipeline');
 assert.equal(workflowState(session,{...change,pipeline:'running'},undefined).state,'waiting');
 assert.equal(workflowState(session,{...change,fix:'proposed'},undefined).stage,'Fix approval');
 assert.equal(workflowState(session,{...change,state:'mr_pending'},undefined).state,'blocked');
 assert.equal(workflowState(session,{...change,resolution:'closed'},undefined).state,'completed');
 assert.equal(workflowState(session,{...change,trackingState:'closed'},undefined).state,'stopped');
 assert.equal(workflowState({...session,sourceChangedAt:later},{...change,resolution:'closed'},undefined).stage,'Request review');
});
test('repeat warnings use identical tool arguments, not repeated progress wording',()=>{
 const run:AnalysisRun={id:'r',connection:'yt',issueId:'1',state:'running',startedAt:at,events:Array.from({length:3},()=>({at,text:'Model is preparing the plan'}))};
 assert.equal(summarizeRun(run,Date.parse(later)).repeating,false);
 run.events=Array.from({length:3},()=>({at,text:'Read',tool:'prometheus_query',input:'{"query":"up"}',status:'complete'}));
 assert.equal(summarizeRun(run,Date.parse(later)).repeating,true);run.events[2].input='{"query":"rate(errors[5m])"}';assert.equal(summarizeRun(run).repeating,false);
 assert.equal(summarizeRun(run,Date.parse(later)+1000).quiet,true);
 run.state='ready';assert.equal(summarizeRun(run,Date.parse(later)+1000).quiet,false);
});
test('overview is vault-gated, excludes bodies and respects active non-investigation runs',()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-activity-')),store=new Store(dir),claude=new Claude(store,new YouTrack(store));
 try{
  assert.throws(()=>aiOverview(store,claude),/Unlock/);store.unlock('long fixture passphrase',true);
  const work:WorkSession={connection:'yt',issueId:'1',revision:1,sourceUpdated:1,updatedAt:at,plans:[{version:1,text:'PRIVATE PLAN BODY',at}],notes:[{at,text:'PRIVATE NOTE BODY'}],draft:'PRIVATE REPLY',approval:null};store.saveWorkSession(work);
  const release=store.claimWork(),tracked=store.trackRun('diagnosis','yt','1','fixture-model');tracked.event('Reading failed jobs');
  let data=aiOverview(store,claude);assert.equal(data.runs[0].kind,'diagnosis');assert.equal(data.workflows[0].state,'running');assert.equal(data.agent.active,true);assert.doesNotMatch(JSON.stringify(data),/PRIVATE PLAN|PRIVATE NOTE|PRIVATE REPLY/);
  tracked.finish();release();data=aiOverview(store,claude);assert.equal(data.runs[0].state,'completed');assert.equal(data.agent.active,false);assert.equal(data.workflows[0].state,'waiting');
  const another=store.claimWork();store.trackRun('changes','yt','1');another();data=aiOverview(store,claude);assert.equal(data.runs[0].state,'blocked');assert.match(data.runs[0].error??'',/interrupted/);
  store.lock();assert.throws(()=>aiOverview(store,claude),/Unlock/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});
test('old failures do not override newer revision feedback',()=>{
 const run=summarizeRun({id:'r',connection:'yt',issueId:'1',state:'failed',startedAt:at,finishedAt:at,error:'Failed',events:[]});
 assert.equal(workflowState({...session,pendingRevision:1,noteAt:later},undefined,run).stage,'Plan revision');
 assert.equal(workflowState({...session,planAt:'2026-11-07T11:00:00Z'},undefined,run).state,'blocked');
});

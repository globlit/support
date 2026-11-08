import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {YouTrack} from '../server/youtrack.js';
import {Claude} from '../server/claude.js';
import {aiOverview} from '../server/ai-activity.js';
import {updateDispositions} from '../server/ai-dispositions.js';
import {dashboardSummary} from '../server/dashboard.js';
test('bulk dispositions persist, adjust counts without rewriting outcomes, restore and reject stale batches atomically',()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-triage-'));const store=new Store(dir);store.unlock('fixture passphrase',true);const agent=new Claude(store,new YouTrack(store));
 try{
  const at=new Date().toISOString();for(const id of ['a','b'])store.saveInvestigation({id,connection:'yt',issueId:id,state:'failed',startedAt:at,finishedAt:at,events:[],error:'Failed'});
  let view=aiOverview(store,agent);const targets=view.runs.map(r=>({kind:'run' as const,id:r.id,signature:r.signature!}));
  assert.throws(()=>updateDispositions(store,view,{action:'resolved',targets:[targets[0],{...targets[1],signature:'0'.repeat(64)}]}),/changed/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM ai_dispositions').get()!.n,0);
  updateDispositions(store,view,{action:'resolved',targets});view=aiOverview(store,agent);
  assert.equal(view.runs.filter(r=>r.disposition).length,2);assert.equal(store.investigation('a').state,'failed');
  assert.equal(dashboardSummary(view,7,'UTC',30).failedRuns,0);assert.equal(dashboardSummary(view,7,'UTC',30).completedRuns,0);
  updateDispositions(store,view,{action:'restore',targets});assert.equal(dashboardSummary(aiOverview(store,agent),7,'UTC',30).failedRuns,2);
  view=aiOverview(store,agent);const workflow=view.workflows[0];updateDispositions(store,view,{action:'dropped',targets:[{kind:'workflow',id:workflow.id,signature:workflow.signature!}]});
  assert.equal(dashboardSummary(aiOverview(store,agent),7,'UTC',30).workflows.blocked,1);
  store.saveInvestigation({id:'new',connection:workflow.connection,issueId:workflow.issueId,state:'failed',startedAt:new Date(Date.now()+1).toISOString(),events:[],error:'New failure'});
  assert.equal(aiOverview(store,agent).workflows.find(w=>w.id===workflow.id)?.disposition,undefined);
  store.lock();assert.throws(()=>updateDispositions(store,view,{action:'resolved',targets}),/Unlock/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});
test('investigation capacity defaults to two, rejects duplicate scopes and excludes write operations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-slots-'));const store=new Store(dir);
 try{
  assert.equal(store.snapshot().config.maxRuns,2);
  const first=store.claimAnalysis('yt:a','a');assert.throws(()=>store.claimAnalysis('yt:a','duplicate'),/Another analysis/);
  const second=store.claimAnalysis('yt:b','b');assert.throws(()=>store.claimAnalysis('yt:c','c'),/slots/);assert.throws(()=>store.claimWork(),/Another analysis/);
  first();assert.equal(store.canAnalyze(),true);second();const write=store.claimWork();assert.throws(()=>store.claimAnalysis('yt:c','c'),/Another analysis/);write();assert.equal(store.canAnalyze(),true);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

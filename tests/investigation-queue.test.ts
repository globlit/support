import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {YouTrack} from '../server/youtrack.js';
import {Claude} from '../server/claude.js';
import {InvestigationQueue} from '../server/investigation-queue.js';
import {wireQueue} from './queue-fixture.js';
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'support-intake-'));const store=new Store(dir);store.unlock('fixture passphrase',true);store.credential('YouTrack','fixture');store.credential('Model','fixture');
 const config=store.snapshot();store.config({...config.config,connections:{...config.config.connections,YouTrack:{endpoint:'https://yt.test',enabled:true,scope:'project: LAB',path:''},Model:{endpoint:'https://model.test',scope:'fixture',enabled:true,path:''}}},config.configRevision);
 const items=[{id:'a',idReadable:'LAB-1',summary:'Runbook',description:'Original',updated:10,resolved:null}];
 const yt=new YouTrack(store,(async(url)=>Response.json(String(url).includes('/issues?')?items:items.find(i=>String(url).includes('/issues/'+i.id)))) as typeof fetch);
 return {store,yt,items,done(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
async function settle(agent:Claude,store:Store){for(let i=0;i<200;i++){const rows=store.db.prepare('SELECT id FROM investigations').all();if(rows.length&&rows.every(r=>agent.status(String(r.id)).state!=='running'))return;await new Promise(r=>setTimeout(r,5))}throw new Error('run did not finish')}
test('automatic intake runs once per source version, catches edited descriptions, preserves reviews, and never approves',async()=>{
 const f=setup();let calls=0;const agent=new Claude(f.store,f.yt,(async()=>{calls++;return Response.json({stop_reason:'tool_use',content:[{type:'tool_use',id:'p',name:'prepare_plan',input:{plan:'Check the runbook',replyDraft:''}}]})}) as typeof fetch);const q=wireQueue(f.store,agent,{youtrack:{load:id=>f.yt.work(id),start:(id,e)=>agent.start(id,e)}}),intake=new InvestigationQueue(f.store,f.yt,q);const queue={tick:async(t:number)=>{await intake.tick(t);await q.tick();}};
 try{
  await queue.tick(100000);await settle(agent,f.store);assert.equal(calls,1);let d=await f.yt.work('a');assert.equal(d.session.plans.length,1);assert.equal(d.session.approval,null);
  await queue.tick(160001);assert.equal(calls,1);
  f.items[0].description='Changed without timestamp change';await queue.tick(220002);await settle(agent,f.store);assert.equal(calls,2);d=await f.yt.work('a');assert.equal(d.session.plans.length,2);assert.equal(d.session.approval,null);
  await queue.tick(280003);assert.equal(calls,2);
  f.store.lock();await queue.tick(340004);assert.equal(calls,2);
 }finally{f.done()}
});
test('a failed automatic investigation is retried once after a minute, then moves to the dead letter; manual retry remains possible',async()=>{
 const f=setup();let calls=0,clock=1_000_000;const agent=new Claude(f.store,f.yt,(async()=>{calls++;return new Response('',{status:503})}) as typeof fetch);
 try{
  const q=wireQueue(f.store,agent,{youtrack:{load:id=>f.yt.work(id),start:(id,e)=>agent.start(id,e)}},()=>clock);const intake=new InvestigationQueue(f.store,f.yt,q);
  await intake.tick(100000);await q.tick();await settle(agent,f.store);assert.equal(calls,1);
  let e=q.list()[0];assert.equal(e.state,'queued');assert.equal(e.attempts,1);assert.ok(e.lastError);
  await q.tick();assert.equal(calls,1,'no retry before the delay');
  clock+=61_000;await q.tick();await settle(agent,f.store);assert.equal(calls,2);
  e=q.list()[0];assert.equal(e.state,'dead');assert.equal(e.attempts,2);
  clock+=600_000;await intake.tick(160001);await q.tick();await new InvestigationQueue(f.store,f.yt,q).tick(220002);await q.tick();assert.equal(calls,2);
  q.retry(e.scope);assert.equal(q.list()[0].state,'queued');await q.tick();await settle(agent,f.store);assert.equal(calls,3);
  q.discard(e.scope);assert.equal(q.list().length,0);
  const d=await f.yt.work('a');await agent.start('a',{revision:d.session.revision,sourceUpdated:d.issue.updated});await settle(agent,f.store);assert.equal(calls,4);
 }finally{f.done()}
});
test('two separate investigations run concurrently, third and duplicate reject, cancelling one preserves the other',async()=>{
 const f=setup();f.items.push({...f.items[0],id:'b',idReadable:'LAB-2'},{...f.items[0],id:'c',idReadable:'LAB-3'});let release!:()=>void;const blocked=new Promise<void>(r=>release=r);
 const agent=new Claude(f.store,f.yt,(async()=>{await blocked;return Response.json({stop_reason:'tool_use',content:[{type:'tool_use',id:'p',name:'prepare_plan',input:{plan:'Proposal',replyDraft:''}}]})}) as typeof fetch);
 try{
  const [a,b]=await Promise.all([agent.start('a',{revision:1,sourceUpdated:10}),agent.start('b',{revision:1,sourceUpdated:10})]);
  assert.equal(agent.status(a.id).state,'running');assert.equal(agent.status(b.id).state,'running');
  await assert.rejects(agent.start('c',{revision:1,sourceUpdated:10}),/slots/);await assert.rejects(agent.start('a',{revision:1,sourceUpdated:10}),/Another analysis/);
  agent.cancel(a.id);release();await settle(agent,f.store);assert.equal(agent.status(a.id).state,'cancelled');assert.equal(agent.status(b.id).state,'ready');assert.equal((await f.yt.work('b')).session.approval,null);
 }finally{release();f.done()}
});

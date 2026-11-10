import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppError} from '../server/store.js';
import {TestStore as Store} from './authenticated-fixture.js';
import {AgentQueue} from '../server/agent-queue.js';
import {setAgentHalted} from '../server/agent-feed.js';
import {setHandling} from '../server/intake.js';
import type {SourceIssue} from '../src/model.js';

const issue=(id:string,fingerprint='f1'):SourceIssue=>({id,connection:'yt',key:'LAB-'+id,title:'Ticket '+id,description:'',updated:10,sourceFingerprint:fingerprint,resolved:false,status:'Open',severity:'Low',assignee:'',project:'LAB',fields:{},url:''});
function setup(patch:Record<string,unknown>={}){
 const dir=mkdtempSync(join(tmpdir(),'support-queue-'));const store=new Store(dir);store.unlock('queue test passphrase',true);
 const s=store.snapshot();store.config({...s.config,maxRuns:2,...patch},s.configRevision);
 const releases=new Map<string,()=>void>();let clock=1_000_000,seq=0;const started:string[]=[],active=new Set<string>();let failStart:Error|undefined;
 const issues=new Map<string,SourceIssue>();
 const queue=new AgentQueue(store,id=>active.has(id),()=>clock);
 queue.register('youtrack',{
  load:async id=>{const i=issues.get(id)!;return {issue:i,session:store.workSession(i)};},
  start:async id=>{if(failStart)throw failStart;const runId='run-'+(++seq);releases.set(runId,store.claimAnalysis('yt:'+id,runId));active.add(runId);started.push(id);queue.started({runId,connection:'yt',id,title:'Ticket '+id});return runId;},
 });
 const add=(id:string,fingerprint='f1')=>{const i=issue(id,fingerprint);issues.set(id,i);setHandling(store,i,{mode:'investigate',reason:'',revision:store.workSession(i).revision,sourceUpdated:i.updated});queue.offer({connection:'yt',id,title:'Ticket '+id,fingerprint});return i;};

 const finish=(runId:string,state:'ready'|'failed'|'cancelled',error?:string)=>{active.delete(runId);releases.get(runId)?.();queue.finished(runId,state,error);};
 return {store,queue,started,add,finish,issues,tick:()=>queue.tick(),advance(ms:number){clock+=ms},failWith(e?:Error){failStart=e},done(){store.close();rmSync(dir,{recursive:true,force:true})}};
}

test('offers are deduplicated, and a changed source is queued again',async()=>{
 const f=setup();try{
  f.add('a');f.queue.offer({connection:'yt',id:'a',title:'Ticket a',fingerprint:'f1'});assert.equal(f.queue.list().length,1);
  await f.tick();assert.deepEqual(f.started,['a']);assert.equal(f.queue.get('yt:a')?.state,'running');
  f.queue.offer({connection:'yt',id:'a',title:'Ticket a',fingerprint:'f2'});assert.equal(f.queue.get('yt:a')?.state,'running');
  f.finish('run-1','ready');assert.equal(f.queue.get('yt:a')?.state,'review');
  f.queue.offer({connection:'yt',id:'a',title:'Ticket a',fingerprint:'f1'});assert.equal(f.queue.get('yt:a')?.state,'review');
  f.queue.offer({connection:'yt',id:'a',title:'Ticket a',fingerprint:'f2'});assert.equal(f.queue.get('yt:a')?.state,'queued');
 }finally{f.done()}
});

test('with parallel review on, new tickets start as soon as plans are ready',async()=>{
 const f=setup({parallelReview:true});try{
  for(const id of ['a','b','c','d'])f.add(id);
  await f.tick();assert.deepEqual(f.started,['a','b']);
  f.finish('run-1','ready');f.finish('run-2','ready');
  await f.tick();assert.deepEqual(f.started,['a','b','c','d']);
  assert.equal(f.queue.counts().budgetFull,false);
 }finally{f.done()}
});

test('with parallel review off, plans waiting for review keep their slots until approved, ignored or discarded',async()=>{
 const f=setup({parallelReview:false});try{
  const [a,b]=[f.add('a'),f.add('b')];f.add('c');
  await f.tick();f.finish('run-1','ready');f.finish('run-2','ready');
  await f.tick();assert.deepEqual(f.started,['a','b']);assert.equal(f.queue.counts().budgetFull,true);
  const w=f.store.workSession(b);f.store.saveWorkSession({...w,pendingRevision:true,revision:w.revision+1});
  await f.tick();assert.deepEqual(f.started,['a','b'],'a revision request keeps the slot');
  const wa=f.store.workSession(a);f.store.saveWorkSession({...wa,approval:{by:'engineer',at:new Date().toISOString(),version:1} as never,revision:wa.revision+1});
  await f.tick();assert.equal(f.queue.get('yt:a')?.state,'done');assert.deepEqual(f.started,['a','b','c']);
 }finally{f.done()}
});

test('a failed run is retried once after a minute, then dead-lettered; a stop is dead-lettered; busy stays queued',async()=>{
 const f=setup();try{
  f.add('a');await f.tick();f.finish('run-1','failed','Model unavailable');
  let e=f.queue.get('yt:a')!;assert.equal(e.state,'queued');assert.equal(e.attempts,1);assert.equal(e.lastError,'Model unavailable');
  await f.tick();assert.equal(f.started.length,1);f.advance(60_001);await f.tick();assert.equal(f.started.length,2);
  f.finish('run-2','failed','Model unavailable');e=f.queue.get('yt:a')!;assert.equal(e.state,'dead');assert.equal(e.attempts,2);
  f.advance(600_000);await f.tick();assert.equal(f.started.length,2);
  f.queue.retry('yt:a');await f.tick();assert.equal(f.started.length,3);f.finish('run-3','cancelled');
  assert.equal(f.queue.get('yt:a')?.state,'dead');assert.equal(f.queue.get('yt:a')?.lastError,'Stopped by the engineer.');
  f.queue.discard('yt:a');assert.equal(f.queue.list().length,0);
  f.add('b');f.failWith(new AppError(409,'busy'));await f.tick();assert.equal(f.queue.get('yt:b')?.state,'queued');assert.equal(f.queue.get('yt:b')?.attempts,0);
  f.failWith(new AppError(502,'Model refused'));await f.tick();assert.equal(f.queue.get('yt:b')?.attempts,1);
 }finally{f.done()}
});

test('manual runs use a slot and are not retried; the kill switch and a locked Vault stop dispatch; restarts requeue interrupted runs',async()=>{
 const f=setup({parallelReview:false});try{
  f.queue.started({runId:'manual-1',connection:'yt',id:'m',title:'Manual'});assert.equal(f.queue.get('yt:m')?.origin,'manual');
  f.queue.finished('manual-1','failed','boom');assert.equal(f.queue.get('yt:m')?.state,'done');
  f.add('a');setAgentHalted(f.store,true);await f.tick();assert.equal(f.started.length,0);setAgentHalted(f.store,false);
  await f.tick();assert.deepEqual(f.started,['a']);
  const again=new AgentQueue(f.store,()=>false);assert.equal(again.get('yt:a')?.state,'queued');assert.equal(again.get('yt:a')?.attempts,0);
 }finally{f.done()}
});

test('queue retries, dead letters and engineer actions are logged with their reason',async()=>{
 const f=setup();try{
  const {readLogs}=await import('../server/diagnostics.js');
  f.add('a');await f.tick();f.finish('run-1','failed','Model unavailable');
  f.advance(60_001);await f.tick();f.finish('run-2','failed','Model unavailable');
  f.queue.retry('yt:a');await f.tick();f.finish('run-3','cancelled','Stopped by the kill switch (Stop all).');
  assert.equal(f.queue.get('yt:a')?.lastError,'Stopped by the kill switch (Stop all).');
  const ops=readLogs(f.store,{tool:'Agent'}).entries.map(e=>e.operation).reverse();
  assert.deepEqual(ops,['Retry in 60 s: Ticket a','Moved to dead letter: Ticket a','Retried by engineer: Ticket a']);
  const dead=readLogs(f.store,{tool:'Agent',query:'dead letter'}).entries[0];assert.match(dead.output,/^2 attempts failed\. Last error: Model unavailable\nTicket: Ticket a$/);
 }finally{f.done()}
});

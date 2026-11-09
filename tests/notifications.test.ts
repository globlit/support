import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {Notifications,notificationQuery} from '../server/notifications.js';
import type {AIWorkflow} from '../src/ai-model.js';
const workflow:AIWorkflow={id:'yt:1',connection:'yt',issueId:'1',source:'youtrack',title:'Scale payments deployment',key:'LAB-1',state:'running',stage:'Investigation',reason:'SECRET REASON',updatedAt:'2026-11-08T10:00:00Z',runCount:1,repeating:false,quiet:false};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-notifications-')),store=new Store(dir);let now=Date.now(),workflows=[{...workflow}];store.unlock('notification test passphrase',true);const notifications=new Notifications(store,()=>workflows,()=>now);return {store,notifications,advance:(n=1000)=>now+=n,change:(patch:Partial<AIWorkflow>)=>{workflows=[{...workflows[0],...patch,updatedAt:new Date(now+=1000).toISOString()}]},clear:()=>workflows=[],close:()=>{store.close();rmSync(dir,{recursive:true,force:true})}}}
/** Returns a function that reads the next page the way one browser does. */
function reader(n:Notifications){let seq=n.list().seq;return ()=>{const page=n.list(seq);seq=page.seq;return page;};}
const history=(store:Store)=>JSON.parse(store.decrypt(store.get<string>('notifications.history')!,store.key!));
test('workflow transitions create private notifications once; each browser reads them from its own position',()=>{const f=fixture(),c=f.notifications;try{
 c.capture();const a=reader(c),b=reader(c);assert.equal(a().events.length,0);
 f.change({state:'waiting',stage:'Plan approval'});c.capture();c.capture();const first=a();assert.equal(first.events.length,1);const e=first.events[0];assert.equal(e.title,'Plan ready for approval');assert.equal(e.body,'YouTrack ticket · Open Support to review the next step.');assert.equal(e.route,'#/youtrack?issue=1&connection=yt');assert.doesNotMatch(JSON.stringify(first),/SECRET|LAB-1|Scale payments/);
 assert.equal(a().events.length,0);assert.equal(b().events[0].id,e.id);
 assert.doesNotMatch(f.store.get<string>('notifications.history')!,/LAB-1|Plan approval|yt:1/);
 const restored=new Notifications(f.store,()=>[]);assert.equal(restored.list(0).events[0].id,e.id);
}finally{f.close()}});
test('a new browser and a sequence number above the latest one receive no old events',()=>{const f=fixture(),c=f.notifications;try{
 c.capture();f.change({state:'blocked',stage:'Investigation'});c.capture();
 const fresh=c.list();assert.deepEqual(fresh.events,[]);assert.equal(fresh.seq,1);
 assert.deepEqual(c.list(99),{seq:1,paused:false,events:[]});
 assert.equal(notificationQuery.parse({after:'3'}).after,3);assert.throws(()=>notificationQuery.parse({after:'-1'}));assert.throws(()=>notificationQuery.parse({after:'x'}));assert.throws(()=>notificationQuery.parse({other:'1'}));
}finally{f.close()}});
test('no historical flood, no obsolete review after approval or takeover, no alert for ordinary pipeline waits',()=>{const f=fixture(),c=f.notifications;try{
 f.change({state:'waiting',stage:'Plan approval'});c.capture();const r=reader(c);assert.equal(r().events.length,0);
 f.change({state:'waiting',stage:'Diff approval'});c.capture();assert.equal(r().events.length,1);
 f.change({state:'waiting',stage:'Merge request'});c.capture();assert.equal(r().events.length,0);
 f.change({state:'blocked',stage:'Pipeline failed'});c.capture();assert.equal(r().events.length,1);
 f.change({state:'stopped',stage:'Engineer handling'});c.capture();assert.equal(r().events.length,0);
 f.change({state:'waiting',stage:'Pipeline'});c.capture();assert.equal(r().events.length,0);
}finally{f.close()}});
test('preferences suppress disabled kinds and reveal only constrained references when opted in',()=>{const f=fixture(),c=f.notifications;try{
 c.capture();const r=reader(c);f.change({state:'blocked',stage:'Investigation'});c.capture();
 let s=f.store.snapshot();f.store.config({...s.config,notifications:{...s.config.notifications,blocked:false}},s.configRevision);c.capture();assert.equal(r().events.length,0);
 s=f.store.snapshot();f.store.config({...s.config,notifications:{...s.config.notifications,blocked:true,privatePreview:false}},s.configRevision);assert.equal(r().events.length,0);
 f.change({state:'waiting',stage:'Plan approval'});c.capture();assert.equal(r().events[0].body,'LAB-1 · Scale payments deployment\nYouTrack ticket · Open Support to review the next step.');
 f.change({key:'credential=SECRET',stage:'Diff approval'});c.capture();assert.doesNotMatch(JSON.stringify(r()),/SECRET/);
}finally{f.close()}});
test('reopened and completion preferences use workflow state, not model run completion',()=>{const f=fixture(),c=f.notifications;try{
 c.capture();const r=reader(c);const s=f.store.snapshot();f.store.config({...s.config,notifications:{...s.config.notifications,completion:true}},s.configRevision);
 f.change({state:'completed',stage:'Resolved'});c.capture();assert.equal(r().events[0].title,'Work completed');
 f.change({state:'waiting',stage:'Request review'});c.capture();assert.equal(r().events[0].title,'Work reopened');
 f.clear();c.capture();assert.equal(r().events.length,0);
}finally{f.close()}});
test('history is bounded, expires, and test notifications are rate limited',()=>{const f=fixture(),c=f.notifications;try{
 const r=reader(c);c.test();const page=r();assert.equal(page.events.length,1);assert.equal(page.events[0].title,'Support notifications work');assert.throws(()=>c.test(),/Wait/);
 f.advance(31*86400000);assert.equal(c.list(0).events.length,0);c.capture();assert.equal(history(f.store).events.length,0);
 for(let n=0;n<510;n++){f.advance(11000);c.test()}
 assert.equal(history(f.store).events.length,500);
}finally{f.close()}});
test('pages hold at most 20 events and continue from the returned sequence number',()=>{const f=fixture(),c=f.notifications;try{
 for(let n=0;n<25;n++){f.advance(11000);c.test()}
 const first=c.list(0);assert.equal(first.events.length,20);assert.equal(first.seq,first.events[19].seq);
 const second=c.list(first.seq);assert.equal(second.events.length,5);assert.equal(second.seq,25);assert.equal(c.list(second.seq).events.length,0);
}finally{f.close()}});
test('capture errors pause delivery without exposing the error and recover on the next successful tick',()=>{const f=fixture();try{
 let fail=false;const c=new Notifications(f.store,()=>{if(fail)throw new Error('private exception');return [workflow]});c.capture();c.test();
 fail=true;c.tick();const paused=c.list(0);assert.equal(paused.paused,true);assert.match(paused.reason??'',/could not be prepared/);assert.equal(paused.events.length,0);assert.doesNotMatch(JSON.stringify(paused),/private exception/);
 fail=false;c.tick();assert.equal(c.list(0).events.length,1);
}finally{f.close()}});
test('a locked Vault rejects reads and tests without losing history',()=>{const f=fixture(),c=f.notifications;try{
 c.test();f.store.lock();assert.throws(()=>c.list(0),/Unlock/);assert.throws(()=>c.test(),/Unlock/);c.tick();
 f.store.unlock('notification test passphrase');assert.equal(c.list(0).events.length,1);
}finally{f.close()}});
test('blocked work names the stopped stage, and long or multi-line titles are shortened',()=>{const f=fixture(),c=f.notifications;try{
 c.capture();const r=reader(c);const s=f.store.snapshot();f.store.config({...s.config,notifications:{...s.config.notifications,privatePreview:false}},s.configRevision);
 f.change({state:'blocked',stage:'Pipeline failed',title:'Line one\n\tline two '+'x'.repeat(200)});c.capture();const e=r().events[0];
 assert.equal(e.title,'Work stopped at Pipeline failed');const [reference,detail]=e.body.split('\n');
 assert.ok(reference.startsWith('LAB-1 · Line one line two x'));assert.ok(reference.endsWith('…'));assert.equal(reference.length,'LAB-1 · '.length+100);
 assert.equal(detail,'YouTrack ticket · Open Support to check what is blocking progress.');
 f.change({state:'waiting',stage:'Intake decision',source:'slack',key:'SLACK-0123abcd'});c.capture();const slack=r().events[0];assert.equal(slack.title,'New request needs a decision');assert.match(slack.body,/^SLACK-0123abcd · .*\nSlack request · /);
}finally{f.close()}});

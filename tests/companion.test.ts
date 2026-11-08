import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {Companion,companionScope,pairInput} from '../server/companion.js';
import type {AIWorkflow} from '../src/ai-model.js';
const workflow:AIWorkflow={id:'yt:1',connection:'yt',issueId:'1',source:'youtrack',title:'SECRET TITLE',key:'LAB-1',state:'running',stage:'Investigation',reason:'SECRET REASON',updatedAt:'2026-11-08T10:00:00Z',runCount:1,repeating:false,quiet:false};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-companion-')),store=new Store(dir);let now=Date.now(),workflows=[{...workflow}];store.unlock('companion test passphrase',true);const companion=new Companion(store,()=>workflows,()=>now);return {store,companion,advance:(n=1000)=>now+=n,change:(patch:Partial<AIWorkflow>)=>{workflows=[{...workflows[0],...patch,updatedAt:new Date(now+=1000).toISOString()}]},clear:()=>workflows=[],close:()=>{store.close();rmSync(dir,{recursive:true,force:true})}}}
function pair(c:Companion){const p=c.pair({...c.begin(),name:'Test Mac'});return {...p,authorization:'Bearer '+p.token};}
test('pairing is single-use, expires, stores hashes only and is revocable',()=>{const f=fixture(),c=f.companion;try{
 const initial=c.begin();const replaced=c.begin();assert.throws(()=>c.pair({code:initial.code,name:'Mac'}),/expired or invalid/);
 const p=c.pair({code:replaced.code,name:'Mac'});assert.throws(()=>c.pair({code:replaced.code,name:'Mac'}),/expired or invalid/);
 const state=JSON.stringify(f.store.get('companion.devices'));assert.ok(!state.includes(p.token));assert.ok(!JSON.stringify(c.status()).includes('hash'));
 assert.equal(c.poll('Bearer '+p.token).paused,false);c.revoke(p.id);assert.equal(f.store.get('companion.history'),null);assert.throws(()=>c.poll('Bearer '+p.token),/Pair this Mac/);
 const expired=c.begin();f.advance(300001);assert.throws(()=>c.pair({code:expired.code,name:'Mac'}),/expired or invalid/);
 c.cancel();assert.equal(c.status().pairingExpiresAt,null);assert.throws(()=>pairInput.parse({code:'x',name:'Mac'}));
}finally{f.close()}});
test('locked Vault pauses delivery without losing pairing or exposing payloads',()=>{const f=fixture(),c=f.companion;try{
 const p=pair(c);c.test(p.id);f.store.lock();assert.throws(()=>c.begin(),/Unlock/);assert.throws(()=>c.status(),/Unlock/);assert.throws(()=>c.test(p.id),/Unlock/);assert.deepEqual(c.poll(p.authorization),{paused:true,events:[]});
 f.store.unlock('companion test passphrase');assert.equal(c.poll(p.authorization).events.length,1);
}finally{f.close()}});
test('native token is scoped to notification delivery, including unknown routes and management',()=>{
 for(const path of ['/api/state','/api/vault','/api/companion/status','/api/companion/pairing','/api/companion/devices/id/revoke','/api/youtrack/issues/1/action','/api/config'])assert.throws(()=>companionScope(path,'Bearer fake'),/only allow/);
 for(const path of ['/api/companion/events','/api/companion/ack'])assert.doesNotThrow(()=>companionScope(path,'Bearer fake'));
 assert.doesNotThrow(()=>companionScope('/api/state',undefined));
});
test('workflow transitions create private notifications once; acknowledgement is per Mac and replay-safe',()=>{const f=fixture(),c=f.companion;try{
 const a=pair(c),b=pair(c);assert.equal(c.poll(a.authorization).events.length,0);
 f.change({state:'waiting',stage:'Plan approval'});c.capture();c.capture();const first=c.poll(a.authorization);assert.equal(first.events.length,1);const e=first.events[0];assert.match(e.title,/Review/);assert.equal(e.route,'#/youtrack?issue=1&connection=yt');assert.doesNotMatch(JSON.stringify(first),/SECRET|LAB-1/);
 assert.equal(c.poll(a.authorization).events[0].id,e.id);c.ack(a.authorization,[e.id]);c.ack(a.authorization,[e.id]);assert.equal(c.poll(a.authorization).events.length,0);assert.equal(c.poll(b.authorization).events[0].id,e.id);
 assert.throws(()=>c.ack(a.authorization,['00000000-0000-4000-8000-000000000000']),/Only delivered/);
 assert.doesNotMatch(f.store.get<string>('companion.history')!,/LAB-1|Plan approval|yt:1/);
 const restored=new Companion(f.store,()=>[]);assert.equal(restored.poll(b.authorization).events[0].id,e.id);
}finally{f.close()}});
test('no historical flood, no obsolete review after approval or takeover, no alert for ordinary pipeline waits',()=>{const f=fixture(),c=f.companion;try{
 f.change({state:'waiting',stage:'Plan approval'});const p=pair(c);assert.equal(c.poll(p.authorization).events.length,0);
 f.change({state:'waiting',stage:'Diff approval'});c.capture();assert.equal(c.poll(p.authorization).events.length,1);
 f.change({state:'waiting',stage:'Merge request'});c.capture();assert.equal(c.poll(p.authorization).events.length,0);
 f.change({state:'blocked',stage:'Pipeline failed'});c.capture();assert.equal(c.poll(p.authorization).events.length,1);
 f.change({state:'stopped',stage:'Engineer handling'});c.capture();assert.equal(c.poll(p.authorization).events.length,0);
 f.change({state:'waiting',stage:'Pipeline'});c.capture();assert.equal(c.poll(p.authorization).events.length,0);
}finally{f.close()}});
test('preferences suppress disabled kinds and reveal only constrained references when opted in',()=>{const f=fixture(),c=f.companion;try{
 const p=pair(c);f.change({state:'blocked',stage:'Investigation'});c.capture();
 let s=f.store.snapshot();f.store.config({...s.config,notifications:{...s.config.notifications,blocked:false}},s.configRevision);c.capture();assert.equal(c.poll(p.authorization).events.length,0);
 s=f.store.snapshot();f.store.config({...s.config,notifications:{...s.config.notifications,blocked:true,privatePreview:false}},s.configRevision);assert.equal(c.poll(p.authorization).events.length,0);
 f.change({state:'waiting',stage:'Plan approval'});c.capture();assert.match(c.poll(p.authorization).events[0].body,/LAB-1/);
 f.change({key:'credential=SECRET',stage:'Diff approval'});c.capture();assert.doesNotMatch(JSON.stringify(c.poll(p.authorization)),/SECRET/);
}finally{f.close()}});
test('reopened and completion preferences use workflow state, not model run completion',()=>{const f=fixture(),c=f.companion;try{
 const p=pair(c);const s=f.store.snapshot();f.store.config({...s.config,notifications:{...s.config.notifications,completion:true}},s.configRevision);
 f.change({state:'completed',stage:'Resolved'});c.capture();assert.equal(c.poll(p.authorization).events[0].title,'Work completed');
 f.change({state:'waiting',stage:'Request review'});c.capture();assert.equal(c.poll(p.authorization).events[0].title,'Work reopened');
 f.clear();c.capture();assert.equal(c.poll(p.authorization).events.length,0);
}finally{f.close()}});
test('outbox is bounded, expires, and a test notification targets only the selected Mac',()=>{const f=fixture(),c=f.companion;try{
 const a=pair(c),b=pair(c);c.test(a.id);assert.equal(c.poll(a.authorization).events.length,1);assert.equal(c.poll(b.authorization).events.length,0);assert.throws(()=>c.test(a.id),/Wait/);
 f.advance(31*86400000);assert.equal(c.poll(a.authorization).events.length,0);c.capture();assert.equal(JSON.parse(f.store.decrypt(f.store.get<string>('companion.history')!,f.store.key!)).events.length,0);
 for(let n=0;n<510;n++){f.advance(11000);c.test(a.id)}
 assert.equal(JSON.parse(f.store.decrypt(f.store.get<string>('companion.history')!,f.store.key!)).events.length,500);
}finally{f.close()}});
test('device limit and pairing attempt limit are enforced',()=>{const f=fixture(),c=f.companion;try{
 for(let n=0;n<5;n++)pair(c);assert.throws(()=>c.begin(),/maximum 5/);
 for(const d of c.status().devices)c.revoke(d.id);
 f.advance(61000);for(let n=0;n<10;n++)assert.throws(()=>c.pair({code:'a'.repeat(43),name:'Mac'}),/expired or invalid/);
 assert.throws(()=>c.pair({code:'a'.repeat(43),name:'Mac'}),/Too many/);
}finally{f.close()}});
test('capture errors pause stale delivery and recover on the next successful tick',()=>{const f=fixture();try{
 let fail=false;const c=new Companion(f.store,()=>{if(fail)throw new Error('private exception');return [workflow]});const p=pair(c);c.test(p.id);fail=true;c.tick();assert.match(c.status().queueError??'',/could not be prepared/);assert.equal(c.poll(p.authorization).events.length,0);assert.doesNotMatch(JSON.stringify(c.status()),/private exception/);
 fail=false;c.tick();assert.equal(c.status().queueError,null);assert.equal(c.poll(p.authorization).events.length,1);
}finally{f.close()}});

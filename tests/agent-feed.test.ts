import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {AgentFeed,agentHalted,assertAgentRunning,setAgentHalted} from '../server/agent-feed.js';
import {mergeEntries} from '../src/AgentConsole.js';

test('the feed keeps the latest entries, replays after a sequence number and tracks running runs',()=>{
 const feed=new AgentFeed(),seen:number[]=[];let states=0;feed.on('entry',e=>seen.push(e.seq));feed.on('state',()=>states++);
 feed.start({runId:'r1',title:'INFRA-1 · Disk full',route:{page:'youtrack',issue:'2-1'},startedAt:'2026-01-01T00:00:00Z'});
 feed.publish('r1','command','df -h');feed.publish('r1','output','x'.repeat(5000));
 assert.equal(feed.running.get('r1')?.lastStep,'df -h');
 const all=feed.since();assert.deepEqual(all.map(e=>e.kind),['run-start','command','output']);assert.equal(all[2].text.length,4001);assert.deepEqual(all[1].route,{page:'youtrack',issue:'2-1'});
 assert.deepEqual(feed.since(all[1].seq).map(e=>e.kind),['output']);assert.deepEqual(feed.since(all[2].seq),[]);
 feed.end('r1','Stopped');assert.equal(feed.running.size,0);assert.equal(states,2);assert.equal(seen.length,4);
 for(let i=0;i<2100;i++)feed.publish('r2','step',String(i));
 assert.equal(feed.since(undefined,5000).length,2000);assert.equal(feed.since(1).length,2000);
});

test('the kill switch is stored and blocks agent work',()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-feed-')),store=new Store(dir);
 try{
  assert.equal(agentHalted(store),false);assert.doesNotThrow(()=>assertAgentRunning(store));
  setAgentHalted(store,true);assert.throws(()=>assertAgentRunning(store),/agent is stopped/);
  store.close();const again=new Store(dir);assert.equal(agentHalted(again),true);setAgentHalted(again,false);assert.equal(agentHalted(again),false);again.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('the console merges entries by sequence and drops duplicates',()=>{
 const e=(seq:number)=>({seq,at:'',runId:'r',title:'t',kind:'step' as const,text:String(seq)});
 assert.deepEqual(mergeEntries([e(1),e(3)],[e(2),e(3)]).map(x=>x.seq),[1,2,3]);
 assert.equal(mergeEntries([],Array.from({length:1600},(_,i)=>e(i))).length,1500);
});

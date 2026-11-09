import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryPlan,gapElapsed,markShown,minimumGapMs} from '../src/browser-notifications.js';

const event=(n:number,title:string,body=`LAB-${n} · Secret ticket title`)=>({id:'id-'+n,seq:n,at:n,title,body,route:'#/youtrack?issue='+n});

test('up to three events are shown one by one',()=>{
 assert.deepEqual(deliveryPlan([]),[]);
 const one=deliveryPlan([event(1,'Plan ready for approval')]);
 assert.deepEqual(one,[{title:'Plan ready for approval',body:'LAB-1 · Secret ticket title',tag:'id-1',route:'#/youtrack?issue=1'}]);
 assert.equal(deliveryPlan([1,2,3].map(n=>event(n,'Plan ready for approval'))).length,3);
});

test('a burst becomes one summary that counts events per title without ticket details',()=>{
 const events=[...Array.from({length:12},(_,i)=>event(i,'New request needs a decision')),event(20,'Plan ready for approval'),event(21,'Plan ready for approval'),event(22,'Work stopped at Pipeline failed')];
 const [summary,...rest]=deliveryPlan(events);
 assert.equal(rest.length,0);
 assert.equal(summary.title,'15 updates in Support');
 assert.equal(summary.body,'12 · New request needs a decision\n2 · Plan ready for approval\n1 · Work stopped at Pipeline failed');
 assert.equal(summary.tag,'support-summary');assert.equal(summary.route,'#/ai?step=waiting');
 assert.doesNotMatch(summary.body+summary.title,/LAB-|Secret/);
});

test('a summary lists at most four titles and marks an incomplete backlog',()=>{
 const titles=['A','B','C','D','E','F'];
 const summary=deliveryPlan(titles.map((t,i)=>event(i,t)))[0];
 assert.equal(summary.body.split('\n').length,5);assert.equal(summary.body.split('\n')[4],'and 2 more types');
 assert.equal(deliveryPlan(Array.from({length:500},(_,i)=>event(i,'A')),true)[0].title,'500+ updates in Support');
 assert.equal(deliveryPlan([event(1,'A')],true)[0].tag,'support-summary');
});

test('notifications wait one minute after the last one shown in any tab',()=>{
 const values=new Map<string,string>(),previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>void values.set(k,v),removeItem:(k:string)=>void values.delete(k)}});
 try{
  assert.equal(gapElapsed(1_000_000),true);
  markShown(1_000_000);
  assert.equal(gapElapsed(1_000_000+minimumGapMs-1),false);
  assert.equal(gapElapsed(1_000_000+minimumGapMs),true);
 }finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');}
});

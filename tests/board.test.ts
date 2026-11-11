import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {workflowPlacement,alertPlacement,sortCards,recentDone,age,type BoardCard} from '../src/board-model.js';
import {WorkBoard} from '../src/WorkBoard.js';
import type {AIWorkflow} from '../src/ai-model.js';

const wf=(state:AIWorkflow['state'],stage:string,extra:Partial<AIWorkflow>={}):AIWorkflow=>({id:'c:1',connection:'c',issueId:'1',source:'youtrack',title:'t',key:'K-1',state,stage,reason:'',updatedAt:'2026-11-11T10:00:00.000Z',runCount:1,repeating:false,quiet:false,...extra});

test('workflows land in the column of what they need',()=>{
 const col=(w?:AIWorkflow)=>workflowPlacement(w).column;
 assert.equal(col(undefined),'triage');assert.equal(col(wf('waiting','Investigation')),'triage');
 assert.equal(col(wf('running','Investigation',{reason:'Reading pods'})),'working');assert.equal(workflowPlacement(wf('running','Investigation',{reason:'Reading pods'})).state,'Running · Reading pods');
 for(const stage of ['Plan approval','Diff approval','Fix approval','Summary approval','Request review','Plan revision','Implementation','Resolution summary'])assert.equal(col(wf('waiting',stage)),'you',stage);
 assert.equal(workflowPlacement(wf('waiting','Plan approval')).state,'Plan to review');
 for(const stage of ['Pipeline','Merge request','Merged pipeline'])assert.equal(col(wf('waiting',stage)),'others',stage);
 assert.equal(col(wf('waiting','Plan approval',{linkedTicket:{connection:'y',id:'2',key:'INFRA-2'}})),'others');
 assert.equal(col(wf('blocked','Pipeline failed')),'you');assert.equal(workflowPlacement(wf('blocked','Pipeline failed')).tone,'failed');
 assert.equal(col(wf('stopped','Investigation stopped')),'you');assert.equal(col(wf('stopped','Engineer handling')),'others');assert.equal(col(wf('stopped','Ignored')),'done');assert.equal(col(wf('completed','Resolved')),'done');
});

test('alert states map to the same columns',()=>{
 const c={session:{plans:[{version:2}],approval:null}};
 assert.equal(alertPlacement('Choose next step',c).column,'triage');assert.equal(alertPlacement('Investigating',c).column,'working');
 assert.deepEqual(alertPlacement('Review',c),{column:'you',state:'Plan v2 to review',tone:'attention'});
 assert.equal(alertPlacement('Engineer handling',c).column,'others');assert.equal(alertPlacement('Not firing',c).column,'done');
 assert.equal(alertPlacement('Review',{...c,ticket:{key:'INFRA-9'}}).state,'Continue in INFRA-9');
});

test('cards are ordered by severity then waiting time, and old done cards are hidden',()=>{
 const card=(id:string,severity:string,since:string,column:BoardCard['column']='you'):BoardCard=>({id,key:id,title:id,severity,since,column,state:'',tone:'idle'});
 assert.deepEqual(sortCards([card('a','Normal','2026-11-11T09:00:00Z'),card('b','Critical','2026-11-11T10:00:00Z'),card('c','Critical','2026-11-10T10:00:00Z')]).map(c=>c.id),['c','b','a']);
 const now=Date.parse('2026-11-11T12:00:00Z');
 assert.deepEqual(recentDone([card('old','x','2026-11-01T00:00:00Z','done'),card('new','x','2026-11-10T00:00:00Z','done'),card('open','x','2026-01-01T00:00:00Z')],now).map(c=>c.id),['new','open']);
 assert.equal(age('2026-11-11T11:55:00Z',now),'5 min');assert.equal(age('2026-11-11T09:00:00Z',now),'3 h');assert.equal(age('2026-11-08T12:00:00Z',now),'3 d');
});

test('the board shows five columns, cards with their next step, and Done collapsed',()=>{
 const html=renderToStaticMarkup(createElement(WorkBoard,{open:()=>{},cards:[{id:'1',key:'INFRA-1',title:'Ingress down',severity:'Critical',since:new Date().toISOString(),column:'you',state:'Plan to review',tone:'attention'},{id:'2',key:'INFRA-2',title:'Old',severity:'',since:new Date().toISOString(),column:'done',state:'Resolved',tone:'done'}]}));
 for(const t of ['To triage','Agent working','Needs you','Waiting on others','Done'])assert.match(html,new RegExp(`<h2>${t}</h2>`));
 assert.match(html,/INFRA-1/);assert.match(html,/Plan to review/);assert.doesNotMatch(html,/INFRA-2/);assert.match(html,/1 finished in the last 7 days/);
});

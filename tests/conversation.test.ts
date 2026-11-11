import test from 'node:test';
import assert from 'node:assert/strict';
import {branches,parentOf,turnText} from '../src/conversation-model.js';
import type {AnalysisRun} from '../src/model.js';

const run=(id:string,minute:number,basedOn?:AnalysisRun['basedOn'],planVersion?:number):AnalysisRun=>({id,issueId:'1',state:'ready',events:[],startedAt:`2026-11-11T10:${String(minute).padStart(2,'0')}:00.000Z`,...(basedOn?{basedOn}:{}),...(planVersion?{planVersion}:{})});

test('continuations, restarts and fresh starts form branches, newest first',()=>{
 const runs=[run('a',0,{kind:'start'},1),run('b',10,{kind:'continue',runId:'a'},2),run('c',20,{kind:'restart',planVersion:1}),run('d',30,{kind:'continue',runId:'c'},3),run('e',40,{kind:'over'})];
 const plans=[{version:1,text:'p1',at:'',runId:'a'},{version:2,text:'p2',at:'',runId:'b'},{version:3,text:'p3',at:'',runId:'d'}];
 assert.equal(parentOf(runs[2],runs,plans),'a');
 const b=branches(runs,plans);
 assert.deepEqual(b.map(x=>x.runs.map(r=>r.id).join('>')),['e','a>c>d','a>b']);
 assert.match(b[0].label,/^Started over/);assert.match(b[1].label,/^From plan v1/);assert.equal(b[2].label,'From the start');
});

test('runs recorded before bases existed form one linear branch',()=>{
 const b=branches([run('x',0),run('y',5),run('z',9)],[]);
 assert.deepEqual(b.map(x=>x.runs.map(r=>r.id).join('>')),['x>y>z']);
});

test('the engineer turn describes what started a run',()=>{
 assert.equal(turnText(run('a',0,{kind:'restart',planVersion:2})),'Restart from plan v2');
 assert.equal(turnText(run('a',0,{kind:'continue',runId:'x',text:'Use the prod-eu1 context'})),'Use the prod-eu1 context');
 assert.equal(turnText(run('a',0)),'Investigation started');
 assert.equal(turnText(run('a',0,{kind:'implement',planVersion:3})),'Implement plan v3');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {ToolUsageChart} from '../src/ToolUsageChart.js';
import {Conversation} from '../src/Conversation.js';
import type {AnalysisRun,LiveDetail} from '../src/model.js';

test('the tool chart shows the ten most used tools, folds the rest, and offers exact counts',()=>{
 const counts=Array.from({length:12},(_,i)=>({label:'tool'+i,total:20-i,failed:i===0?2:0}));
 const html=renderToStaticMarkup(createElement(ToolUsageChart,{counts}));
 assert.equal((html.match(/class="tool-bar-label"/g)??[]).length,11);
 assert.match(html,/other \(2\)/);assert.match(html,/2 failed/);assert.match(html,/<summary>Exact counts<\/summary>/);
 assert.match(renderToStaticMarkup(createElement(ToolUsageChart,{counts:[]})),/No tool calls recorded/);
});

test('the conversation shows the engineer turn, the work block and a plan card with approval',()=>{
 const run:AnalysisRun={id:'r1',issueId:'1',connection:'yt',state:'ready',startedAt:'2026-11-11T10:00:00.000Z',finishedAt:'2026-11-11T10:04:00.000Z',events:[],basedOn:{kind:'start',by:'Engineer'},planVersion:1,outcome:'plan',sessionId:'s'};
 const detail={issue:{id:'1',key:'INFRA-1',title:'t',description:'',updated:1,resolved:false,status:'',severity:'',assignee:'',project:'',fields:{},url:'',connection:'yt'},session:{connection:'yt',issueId:'1',revision:3,sourceUpdated:1,updatedAt:'',notes:[],draft:'',plans:[{version:1,text:'## Fix\nAllow ingress.',at:'',runId:'r1'}],approval:null}} as unknown as LiveDetail;
 const html=renderToStaticMarkup(createElement(Conversation,{detail,run,running:false,error:'',disabled:false,start:()=>{},cancel:()=>{},refresh:()=>{}}));
 assert.match(html,/Investigation started/);assert.match(html,/Worked 4 min/);assert.match(html,/Plan v1/);assert.match(html,/Review plan →/);assert.doesNotMatch(html,/>Approve</);assert.match(html,/Message the agent/);
 assert.doesNotMatch(html,/Restart from this version/,'the current version offers no restart');
});

test('steps render closed, with a one-line preview of what ran',async()=>{
 const {InvestigationTimeline}=await import('../src/InvestigationTimeline.js');
 const html=renderToStaticMarkup(createElement(InvestigationTimeline,{events:[{at:'2026-11-11T10:00:00.000Z',text:'Bash',tool:'Bash',input:JSON.stringify({command:'kubectl get netpol -n app'}),result:'ok',status:'complete'},{at:'2026-11-11T10:00:01.000Z',text:'Agent note',tool:'note',result:'The policy blocks ingress.',status:'complete'}],run:null}));
 assert.doesNotMatch(html,/<details open/);
 assert.match(html,/\$ kubectl get netpol -n app/);assert.match(html,/The policy blocks ingress\./);
});

test('the conversation grid lets long content shrink instead of widening the column',async()=>{
 const {readFileSync}=await import('node:fs');
 const css=readFileSync(new URL('../src/workspace.css',import.meta.url),'utf8');
 assert.match(css,/\.conversation-scroll\{grid-template-columns:minmax\(0,1fr\);overflow-x:hidden\}/);
 assert.match(css,/\.investigation-check-preview\{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
});

test('agent questions show prepared answers as buttons and are answered in place',()=>{
 const run:AnalysisRun={id:'r2',issueId:'1',connection:'yt',state:'ready',startedAt:'2026-11-11T10:00:00.000Z',finishedAt:'2026-11-11T10:02:00.000Z',events:[],basedOn:{kind:'start'},outcome:'needs_input',sessionId:'s',
  questions:[{id:'q1',text:'Which cluster runs netpol.sahar.fr?',at:'',options:['prod-eu1','prod-eu2']},{id:'q2',text:'Was it working last week?',at:''},{id:'q3',text:'Old question',at:'',answer:{text:'Yes',at:'',by:'me'}}]};
 const detail={issue:{id:'1',key:'INFRA-1',title:'t',description:'',updated:1,resolved:false,status:'',severity:'',assignee:'',project:'',fields:{},url:'',connection:'yt'},session:{connection:'yt',issueId:'1',revision:3,sourceUpdated:1,updatedAt:'',notes:[],draft:'',plans:[],approval:null}} as unknown as LiveDetail;
 const html=renderToStaticMarkup(createElement(Conversation,{detail,run,running:false,error:'',disabled:false,start:()=>{},cancel:()=>{},refresh:()=>{}}));
 assert.match(html,/<button type="button" aria-pressed="false">prod-eu1<\/button>/);assert.match(html,/Something else…/);
 assert.match(html,/Answer this question/);assert.match(html,/Your answer<\/span>Yes/);
 assert.match(html,/Show steps|Hide steps/);
 assert.doesNotMatch(html,/Send answers/,'nothing to send before an answer is chosen');
});

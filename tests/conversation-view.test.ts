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
 assert.match(html,/Investigation started/);assert.match(html,/Worked 4 min/);assert.match(html,/Plan v1/);assert.match(html,/Approve/);assert.match(html,/Message the agent/);
 assert.doesNotMatch(html,/Restart from this version/,'the current version offers no restart');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PlanComment} from '../src/PlanComment.js';
import {PlanReview} from '../src/PlanReview.js';
import type {LiveDetail} from '../src/model.js';
test('plan history stays in selector; only latest body and approval are shown',()=>{
 const detail={issue:{resolved:false},session:{notes:[],revision:3,plans:[{version:1,text:'OLD BODY',at:''},{version:2,text:'CURRENT BODY',at:''}],approval:null}} as unknown as LiveDetail;
 const html=renderToStaticMarkup(createElement(PlanReview,{detail,busy:false,running:false,action:async()=>true}));
 assert.match(html,/aria-label="Plan version"/);assert.match(html,/role="combobox"/);assert.match(html,/CURRENT BODY/);assert.doesNotMatch(html,/OLD BODY/);assert.equal((html.match(/>Approve<\/button>/g)??[]).length,2);assert.ok(html.indexOf('>Approve</button>')<html.indexOf('aria-label="Plan version"'));assert.match(html,/Edit plan/);
});

test('selected passages use compact rich previews instead of manufactured blockquotes',()=>{
 const html=renderToStaticMarkup(createElement(PlanComment,{note:{id:'note-1',at:'2026-11-07T12:00:00Z',text:'Revision requested: [Plan v1]\nRequested change:\nCheck this',annotation:{version:1,kind:'comment',quote:'Service health checks',markdown:'**Service** *health* `checks`\n\n- [x] Ready\n- Check logs\n\n```sh\nkubectl get pods\n```'}},queued:true,disabled:false,onDelete:()=>{}}));
 assert.match(html,/<strong>Service<\/strong>/);assert.match(html,/<em>health<\/em>/);assert.match(html,/<code>checks<\/code>/);assert.match(html,/type="checkbox"/);assert.match(html,/language-sh/);assert.doesNotMatch(html,/<blockquote/);assert.match(html,/Delete plan comment/);
});

test('both plan approval controls honor pending revisions, editing and existing approval guards',()=>{
 for(const sessionState of [{pendingRevision:true},{approval:{version:1}}]){
  const detail={issue:{resolved:false},session:{notes:[],revision:1,plans:[{version:1,text:'Plan',at:''}],approval:null,...sessionState}} as unknown as LiveDetail;
  const html=renderToStaticMarkup(createElement(PlanReview,{detail,busy:false,running:false,action:async()=>true}));
  const buttons=html.match(/<button class="approve-button"[^>]*>/g)??[];
  assert.equal(buttons.length,2);assert.ok(buttons.every(b=>b.includes('disabled')));
 }
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {IssueFlow} from '../src/IssueFlow.js';
import type {LiveDetail} from '../src/model.js';
test('previous workflow steps are selectable and no unrecorded work is marked complete',()=>{
 const detail={issue:{connection:'youtrack-test',status:'Open',updated:1},session:{plans:[{version:1,at:'2026-11-07T12:00:00Z'}],draft:'A reply',analysis:{events:[{at:'2026-11-07T11:59:00Z',text:'Read source'}]}}} as unknown as LiveDetail;
 const html=renderToStaticMarkup(createElement(IssueFlow,{detail,changes:[],loaded:true,error:'',running:false,selected:'plan',onSelect:()=>{},disabled:false}));
 assert.equal((html.match(/<button/g)??[]).length,5);assert.match(html,/Investigation/);assert.match(html,/Recorded activity/);assert.match(html,/Not started/);assert.match(html,/>Reply</);assert.match(html,/Waiting for implementation/);assert.doesNotMatch(html,/Draft · not sent|Ready for review/);assert.equal((html.match(/aria-current="step"/g)??[]).length,1);assert.doesNotMatch(html,/Agent waiting|Your next step/);
});

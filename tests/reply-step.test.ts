import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {replyStatus,latestChange} from '../src/reply-state.js';
import {ChangesPanel} from '../src/ChangesPanel.js';
import {ResolutionPanel} from '../src/ResolutionPanel.js';
import {defaults,type ChangeSet,type LiveDetail,type Snapshot} from '../src/model.js';

test('an investigation draft never becomes a reply before implementation',()=>{
 const html=renderToStaticMarkup(createElement(ChangesPanel,{view:'reply',detail:{issue:{id:'1'},session:{draft:'Pretend work is done',approval:null}} as LiveDetail,data:{config:defaults,vault:{unlocked:true}} as Snapshot,refresh:()=>{}}));
 assert.match(html,/Waiting for implementation/);
 assert.doesNotMatch(html,/Pretend work is done|textarea|Approve.*post|Prepare changes/);
});

test('merge alone is not reply readiness; delivery uncertainty is not sent',()=>{
 const change={tracking:{state:'merged',pipeline:{status:'success'}}} as ChangeSet;
 assert.equal(replyStatus(change),'Verify implementation');
 const withState=(state:string)=>({...change,resolution:{state}} as ChangeSet);
 assert.equal(replyStatus(withState('draft')),'Ready for review');
 assert.equal(replyStatus(withState('posting')),'Confirming delivery');
 assert.equal(replyStatus(withState('posted')),'Sent');
 assert.equal(replyStatus(withState('closed')),'Sent · ticket closed');
 assert.equal(replyStatus(withState('reopened')),'Sent · ticket reopened');
 const newer={id:'new',createdAt:'2026-11-08'} as ChangeSet;
 assert.equal(latestChange([{...withState('posted'),id:'old',createdAt:'2026-11-07'},newer])?.id,'new');
 assert.equal(replyStatus(latestChange([{...withState('posted'),id:'old',createdAt:'2026-11-07'},newer])),'Waiting for implementation');
});

test('verified reply exposes exact-text approval; sent reply cannot be posted again',()=>{
 const c={id:'change',tracking:{state:'merged'},resolution:{id:'resolution',state:'draft',text:'Verified result',hash:'hash',message:'Prepared locally',proof:{mergeSha:'abc',pipelineId:1,target:'main'}}} as ChangeSet;
 let invoked=false;
 const run=async()=>{invoked=true};
 const draft=renderToStaticMarkup(createElement(ResolutionPanel,{c,busy:false,run}));
 assert.match(draft,/Approve &amp; post to YouTrack/);
 assert.match(draft,/Verified result/);
 const sent=renderToStaticMarkup(createElement(ResolutionPanel,{c:{...c,resolution:{...c.resolution!,state:'posted'}},busy:false,run}));
 assert.doesNotMatch(sent,/Approve &amp; post to YouTrack/);
 assert.match(sent,/Load closing states/);
 assert.equal(invoked,false);
});

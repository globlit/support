import test from 'node:test';
import assert from 'node:assert/strict';
import {currentStage} from '../src/IssueFlow.js';
import type {ChangeSet,LiveDetail} from '../src/model.js';

const ticket=(connection:string,session:Partial<LiveDetail['session']>={})=>({issue:{id:'1',connection,updated:1},session:{revision:1,plans:[],notes:[],draft:'',approval:null,...session}}) as unknown as LiveDetail;
const change=(patch:Partial<ChangeSet>)=>({id:'c',createdAt:'2026-11-09T10:00:00Z',state:'review',...patch}) as ChangeSet;
const plan={version:1,text:'Plan',at:'2026-11-09T10:00:00Z'};
const approval={version:1,sourceUpdated:1,configRevision:1,actor:'me',at:'2026-11-09T10:00:00Z'};

test('a YouTrack ticket opens at the latest step with recorded work',()=>{
 assert.equal(currentStage(ticket('yt'),[]),'request');
 assert.equal(currentStage(ticket('yt'),[],true),'investigation');
 assert.equal(currentStage(ticket('yt',{analysis:{model:'m',events:[]}}),[]),'investigation');
 assert.equal(currentStage(ticket('yt',{plans:[plan]}),[]),'plan');
 assert.equal(currentStage(ticket('yt',{plans:[plan],approval}),[]),'implementation');
 assert.equal(currentStage(ticket('yt',{plans:[plan]}),[change({})]),'implementation');
 assert.equal(currentStage(ticket('yt',{plans:[plan]}),[change({tracking:{state:'merged'} as ChangeSet['tracking']})]),'message');
 assert.equal(currentStage(ticket('yt',{plans:[plan],replyState:'draft'}),[]),'message');
 assert.equal(currentStage(ticket('yt',{plans:[plan],handling:{mode:'human'} as LiveDetail['session']['handling']}),[]),'request');
});

test('alerts and Slack requests wait on the request step until a handling decision exists',()=>{
 assert.equal(currentStage(ticket('alertmanager:prod',{plans:[plan]}),[]),'request');
 assert.equal(currentStage(ticket('slack:support',{handling:{mode:'ticket'} as LiveDetail['session']['handling']}),[]),'ticket');
 assert.equal(currentStage(ticket('slack:support',{handling:{mode:'reply'} as LiveDetail['session']['handling']}),[]),'message');
 assert.equal(currentStage(ticket('alertmanager:prod',{plans:[plan],handling:{mode:'investigate'} as LiveDetail['session']['handling']}),[]),'plan');
});

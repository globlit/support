import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {saveSettingsAndCredentials} from '../src/settings-state.js';
import {ConnectionCredential} from '../src/ConnectionCredential.js';
import type {Snapshot} from '../src/model.js';

test('Save settings stores the configuration before pending credentials',async()=>{
 const calls:string[]=[];
 const stored=await saveSettingsAndCredentials(true,async()=>{calls.push('config')},{YouTrack:{name:'YouTrack',value:'a'},Model:{name:'Model',value:'b'}},async body=>{calls.push('credential '+(body as {name:string}).name)},name=>calls.push('stored '+name));
 assert.deepEqual(calls,['config','credential YouTrack','stored YouTrack','credential Model','stored Model']);
 assert.deepEqual(stored,['YouTrack','Model']);
});
test('Save settings stores pending credentials without a configuration change',async()=>{
 const calls:string[]=[];
 await saveSettingsAndCredentials(false,async()=>{calls.push('config')},{GitLab:{name:'GitLab',value:'a'}},async()=>{calls.push('credential')},()=>{});
 assert.deepEqual(calls,['credential']);
 assert.deepEqual(await saveSettingsAndCredentials(false,async()=>{calls.push('config')},{},async()=>{calls.push('credential')},()=>{}),[]);
 assert.deepEqual(calls,['credential']);
});
test('a failed save keeps later credentials pending and a failed configuration save stores no credential',async()=>{
 const stored:string[]=[];
 await assert.rejects(saveSettingsAndCredentials(false,async()=>{},{YouTrack:1,GitLab:2,Slack:3},async body=>{if(body===2)throw new Error('rejected')},name=>stored.push(name)),/rejected/);
 assert.deepEqual(stored,['YouTrack']);
 let credentialCalls=0;
 await assert.rejects(saveSettingsAndCredentials(true,async()=>{throw new Error('conflict')},{YouTrack:1},async()=>{credentialCalls++},()=>{}),/conflict/);
 assert.equal(credentialCalls,0);
});
test('a pending credential is shown on its connection without a separate save button',()=>{
 const data={config:{},configRevision:1,tickets:[],vault:{initialized:true,unlocked:true,credentials:['YouTrack']},runtime:{mode:'Test',platform:'linux',liveExecution:false}} as unknown as Snapshot;
 const props={name:'YouTrack' as const,data,run:async()=>{},reload:async()=>data,busy:false,dirty:true,setPending:()=>{}};
 const pending=renderToStaticMarkup(createElement(ConnectionCredential,{...props,pending:true}));
 assert.match(pending,/Change pending until you save settings/);
 const idle=renderToStaticMarkup(createElement(ConnectionCredential,{...props,pending:false}));
 assert.doesNotMatch(idle,/Change pending/);assert.match(idle,/Token saved/);assert.doesNotMatch(idle,/disabled/);
});

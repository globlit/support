import test from 'node:test';
import assert from 'node:assert/strict';
import {Sources,type RequestSource} from '../server/sources.js';
import type {SourceIssue} from '../src/model.js';

const fake=(kind:RequestSource['kind']):RequestSource=>({kind,issue:async id=>({id:`${kind}:${id}`} as SourceIssue),work:async()=>{throw new Error('unused');},start:async()=>kind});
const sources=new Sources().register(fake('youtrack')).register(fake('alert')).register(fake('slack'));

test('a reference selects the source by its prefix and strips it',async()=>{
 assert.equal((await sources.issue(Sources.reference('alert','abc'))).id,'alert:abc');
 assert.equal((await sources.issue(Sources.reference('slack','abc'))).id,'slack:abc');
});
test('a bare ID uses the kind of its connection, and YouTrack without one',async()=>{
 assert.equal((await sources.issue('2-42','alertmanager:https://am.example')).id,'alert:2-42');
 assert.equal((await sources.issue('2-42','slack:C1')).id,'slack:2-42');
 assert.equal((await sources.issue('2-42','youtrack:https://yt.example')).id,'youtrack:2-42');
 assert.equal((await sources.issue('2-42')).id,'youtrack:2-42');
});
test('an unregistered kind is an error',()=>{
 assert.throws(()=>new Sources().get('slack'),/No request source/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {lineDiff} from '../src/ProposalList.js';
import {AgentComposer} from '../src/AgentComposer.js';
import {repoSlug} from '../server/repo-tools.js';
import {credentialFile} from '../server/changes.js';

test('line diffs show changes with three lines of context',()=>{
 const before=['a','b','c','d','e','f','g','h','i'].join('\n'),after=before.replace('e','E');
 assert.deepEqual(lineDiff(before,after),['…',' b',' c',' d','-e','+E',' f',' g',' h','…']);
 assert.deepEqual(lineDiff(null,'x\ny'),['+x','+y']);assert.deepEqual(lineDiff('x',null),['-x']);
});

test('checkout folders and credential paths',()=>{
 assert.equal(repoSlug('Team/Sub/Service'),'team--sub--service');
 assert.ok(credentialFile('deploy/.env'));assert.ok(credentialFile('certs/tls.key'));assert.ok(!credentialFile('deploy/values.yaml'));
});

test('the composer is disabled without a running run and shows the reply target',()=>{
 const off=renderToStaticMarkup(createElement(AgentComposer,{targets:[]}));
 assert.match(off,/placeholder="No investigation is running\."/);assert.match(off,/disabled=""/);
 const on=renderToStaticMarkup(createElement(AgentComposer,{targets:[{runId:'r1',key:'INFRA-1'},{runId:'r2',key:'INFRA-2'}],reply:{id:'q',text:'Which namespace?'}}));
 assert.match(on,/Replying to: <em>Which namespace\?<\/em>/);assert.match(on,/<option value="r2">To INFRA-2<\/option>/);
});

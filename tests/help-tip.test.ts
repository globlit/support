import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {Field} from '../src/Field.js';
import {credentialHelp,endpointHelp,scopeHelp} from '../src/field-help.js';
import {connectionNames} from '../src/model.js';

test('a field with help shows a labelled "?" button outside its label, and stays unchanged without help',()=>{
 const html=renderToStaticMarkup(createElement(Field,{label:'Service URL',help:'Explanation',children:createElement('input')}));
 assert.match(html,/^<div class="field-with-help"><label>Service URL<input\/><\/label><div class="help-tip"><button type="button" class="help-tip-button" aria-label="Help: Service URL" aria-expanded="false"/);
 assert.doesNotMatch(html,/Explanation/);
 assert.equal(renderToStaticMarkup(createElement(Field,{label:'Name',hint:'Hint',children:createElement('input')})),'<label>Name<input/><small>Hint</small></label>');
});

test('every connection with a credential explains how to create it',()=>{
 for(const name of ['YouTrack','GitLab','Slack','Outline','Alertmanager','Prometheus','Kubernetes'] as const)assert.ok(credentialHelp(name),name);
 for(const name of connectionNames.filter(n=>!['Model','Kubernetes'].includes(n)))assert.ok(endpointHelp(name),name);
 for(const name of ['YouTrack','Outline','Slack','Alertmanager'] as const)assert.ok(scopeHelp(name),name);
});

test('help texts are short and describe only the field',()=>{
 const text=(node:unknown)=>renderToStaticMarkup(createElement('div',null,node as never)).replace(/<[^>]+>/g,'');
 for(const name of connectionNames)for(const [help,max] of [[endpointHelp(name),260],[scopeHelp(name),260],[credentialHelp(name),name==='GitLab'?420:260]] as const){
  if(!help)continue;
  const t=text(help);
  assert.ok(t.length<=max,`${name}: ${t.length} characters: ${t}`);
  assert.doesNotMatch(t,/\bTest\b/,name);
 }
});

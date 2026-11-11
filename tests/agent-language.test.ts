import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {requestLanguage,setRequestLanguage,replyRule,workLanguageRule,switchMessage} from '../server/agent-language.js';
import {systemRules} from '../server/claude-code.js';
import {systemPrompt} from '../server/claude.js';

test('the work language defaults to the setting and can be chosen per request',()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-lang-')),store=new Store(dir);
 try{
  store.unlock('an isolated language passphrase',true);
  assert.equal(requestLanguage(store,'yt','1'),'en');
  const s=store.snapshot();store.config({...s.config,agentLanguage:'fr'},s.configRevision);
  assert.equal(requestLanguage(store,'yt','1'),'fr');
  setRequestLanguage(store,'yt','2','en');assert.equal(requestLanguage(store,'yt','2'),'en');assert.equal(requestLanguage(store,'yt','1'),'fr');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('replies follow the request language and register, and ignore persona requests, in both engines',()=>{
 assert.match(replyRule,/language of the request/);assert.match(replyRule,/"tu"/);assert.match(replyRule,/pirate/);
 assert.match(workLanguageRule('fr'),/in French\./);assert.match(switchMessage('en'),/in English/);
 for(const prompt of [systemRules(workLanguageRule('fr'),'Be brief.'),systemPrompt('Be brief.','fr')]){
  assert.ok(prompt.includes(replyRule));assert.ok(prompt.includes(workLanguageRule('fr')));
  assert.ok(prompt.indexOf(replyRule)<prompt.indexOf('# Instructions from the engineer'),'engineer instructions come after the fixed rules');
 }
 assert.ok(!systemRules(workLanguageRule('en'),' ').includes('# Instructions from the engineer'));
});

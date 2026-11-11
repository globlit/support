import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeLoginStatus,loginStatusCommand,claudeConfigFolder,type LoginRunner} from '../server/claude-login.js';
import {configSchema,defaults} from '../src/model.js';
import {modelKey,configuredModelFetch} from '../server/model-api.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';

const run=(output:string,code:number|null=0):LoginRunner=>async()=>({output,code});
test('the login status runs in the configured folder without loading its settings',async()=>{
 let seen='';
 await claudeLoginStatus(async c=>{seen=c;return {output:'{"loggedIn":true,"authMethod":"claude.ai"}',code:0};},undefined,'/data/claude access/.claude');
 assert.match(seen,/^CLAUDE_CONFIG_DIR='\/data\/claude access\/\.claude' claude --safe-mode --restricted /);
 assert.match(seen,/auth status$/);
 assert.match(loginStatusCommand("/a'b"),/CLAUDE_CONFIG_DIR='\/a'\\''b'/);
 assert.equal(claudeConfigFolder('/x/'),'/x/.claude');
});
test('the Claude configuration folder is inside the agent volume',()=>{
 assert.equal(claudeConfigFolder(),'/home/admin/agent/.claude');
 assert.equal(claudeConfigFolder('/data/agent'),'/data/agent/.claude');
});
test('a signed-in subscription is connected and other states are not',async()=>{
 assert.deepEqual(await claudeLoginStatus(run('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'),undefined,'/f'),{connected:true,method:'claude.ai',plan:'max'});
 assert.equal((await claudeLoginStatus(run('{"loggedIn":true,"authMethod":"api_key"}',0),undefined,'/f')).connected,false);
 assert.deepEqual(await claudeLoginStatus(run('{"loggedIn":false}',1),undefined,'/f'),{connected:false,method:'none',plan:undefined});
});
test('warnings around the JSON are ignored, and output without a status is an error',async()=>{
 assert.equal((await claudeLoginStatus(run('warning\n{"loggedIn":true,"authMethod":"claude.ai"}\n'),undefined,'/f')).connected,true);
 await assert.rejects(claudeLoginStatus(run('bash: claude: command not found',127),undefined,'/f'),/did not report a login status/);
 await assert.rejects(claudeLoginStatus(run('{"x":1}'),undefined,'/f'),/unexpected login status/);
});
test('the model mode accepts the Claude subscription and rejects the removed claude_cli',()=>{
 assert.equal(configSchema.parse({...defaults,modelAuth:'claude_subscription'}).modelAuth,'claude_subscription');
 assert.equal(configSchema.parse({...defaults,modelAuth:'api_key'}).modelAuth,'api_key');
 assert.throws(()=>configSchema.parse({...defaults,modelAuth:'claude_cli'}));
});
test('the built-in loop refuses the Claude subscription',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-login-'));const store=new Store(dir);
 try{store.unlock('a long test passphrase',true);const s=store.snapshot();store.config({...s.config,modelAuth:'claude_subscription'},s.configRevision);
  await assert.rejects(modelKey(store),/runs in the sandbox/);
  assert.throws(()=>configuredModelFetch(store),/runs in the sandbox/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeCliFetch,claudeCliStatus,cliEnvironment,runCli,type CliRunner} from '../server/claude-cli.js';
import {modelFetch} from '../server/model-api.js';
import {boundedJSON} from '../server/gitlab.js';
import {AppError} from '../server/store.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const tools=[{name:'prepare_plan',description:'Draft only',input_schema:{type:'object',properties:{plan:{type:'string'}},required:['plan'],additionalProperties:false}}];
const body={model:'sonnet',system:'Never write',messages:[{role:'user',content:'Sensitive ticket context'}],tools};
const request={method:'POST',body:JSON.stringify(body)};
test('local Claude receives only structured proposals with native tools and customization disabled',async()=>{
 const runner:CliRunner=async(path,args,input)=>{
  assert.equal(path,'/opt/claude');for(const flag of ['--safe-mode','--restricted','--no-session-persistence','--strict-mcp-config','--disable-slash-commands'])assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools')+1],'');assert.equal(args[args.indexOf('--disallowedTools')+1],'mcp__*');assert.equal(args[args.indexOf('--permission-mode')+1],'dontAsk');assert.equal(args[args.indexOf('--setting-sources')+1],'');assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');assert.equal(JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks,true);
  assert.ok(!args.join(' ').includes('Sensitive ticket context'));assert.ok(input.includes('Sensitive ticket context'));
  return {code:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{action:{name:'prepare_plan',input:{plan:'Review this'}}}})};
 };
 const output=await (await claudeCliFetch('/opt/claude',runner)('https://api.anthropic.com/v1/messages',request)).json();assert.equal(output.stop_reason,'tool_use');assert.equal(output.content[0].name,'prepare_plan');assert.equal(output.content[0].input.plan,'Review this');
});
test('local Claude accepts a JSON array of messages and null optional fields',async()=>{
 const result={type:'result',subtype:'success',is_error:false,result:null,errors:null,structured_output:{action:{name:'prepare_plan',input:{plan:'From array'}}}};
 const stdout=JSON.stringify([{type:'system',subtype:'init'},{type:'assistant'},{type:'user'},{type:'rate_limit_event'},result]);
 const output=await (await claudeCliFetch('/opt/claude',async()=>({code:0,stdout}))('https://api.anthropic.com/v1/messages',request)).json();
 assert.equal(output.content[0].name,'prepare_plan');assert.equal(output.content[0].input.plan,'From array');
 await assert.rejects(claudeCliFetch('/opt/claude',async()=>({code:0,stdout:JSON.stringify([{type:'system',subtype:'init'}])}))('https://api.anthropic.com/v1/messages',request),/unsupported result/);
});
test('local Claude rejects failures, partial text and unavailable actions',async()=>{
 for(const value of [{type:'result',subtype:'error_max_turns',is_error:true,result:'Partial plan'},{type:'result',subtype:'success',result:'plain text only'},{type:'result',subtype:'success',structured_output:{action:{name:'Bash',input:{command:'no'}}}}]){
  await assert.rejects(claudeCliFetch('/opt/claude',async()=>({code:0,stdout:JSON.stringify(value)}))('https://api.anthropic.com/v1/messages',request),/No result was applied/);
 }
 await assert.rejects(claudeCliFetch('/opt/claude',async()=>({code:1,stdout:JSON.stringify({type:'result',subtype:'error',is_error:true,result:'Bearer private-token'})}))('https://api.anthropic.com/v1/messages',request),e=>!String(e).includes('private-token'));
});
test('CLI auth only accepts a subscription login and exposes no raw identity fields',async()=>{
 for(const method of ['claude.ai','api_key','none','oauth_token']){
  const status=await claudeCliStatus('/opt/claude',async(_p,args)=>{assert.deepEqual(args.slice(-2),['auth','status']);return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:method,email:'private@example.test',accessToken:'private'})}});
  assert.equal(status.connected,method==='claude.ai');assert.ok(!JSON.stringify(status).includes('private'));
 }
});
test('CLI environment excludes API billing overrides, OAuth tokens and arbitrary runtime injection',()=>{
 const env=cliEnvironment({HOME:'/home/support',PATH:'/bin',ANTHROPIC_API_KEY:'secret',CLAUDE_CODE_OAUTH_TOKEN:'secret',ANTHROPIC_BASE_URL:'https://other',NODE_OPTIONS:'--require /tmp/hook',BASH_ENV:'/tmp/hook',CLAUDE_CONFIG_DIR:'/other'});
 assert.equal(env.HOME,'/home/support');assert.equal(env.ANTHROPIC_API_KEY,undefined);assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.ANTHROPIC_BASE_URL,undefined);assert.equal(env.CLAUDE_CONFIG_DIR,undefined);
});
test('local runner uses an empty temporary cwd and terminates on cancellation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'support-cli-test-')),script=join(dir,'fixture');
 try{
  await writeFile(script,'#!/bin/sh\npwd\ncat\n',{mode:0o700});const result=await runCli(script,[],'fixture stdin');const [cwd]=result.stdout.split('\n');assert.match(cwd,/support-claude-/);assert.ok(result.stdout.includes('fixture stdin'));
  const {stat}=await import('node:fs/promises');await assert.rejects(stat(cwd));
  await writeFile(script,'#!/bin/sh\nsleep 30\n',{mode:0o700});const controller=new AbortController();const pending=runCli(script,[],'',controller.signal);setTimeout(()=>controller.abort(),30);await assert.rejects(pending,/cancelled/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('Claude API errors preserve error type, request ID and key redaction',async()=>{
 const transport=modelFetch('anthropic',async()=>Response.json({type:'error',error:{type:'rate_limit_error',message:'Try later private-key'},request_id:'req-claude'},{status:429}));
 await assert.rejects(transport('https://api.anthropic.com/v1/messages',{headers:{'x-api-key':'private-key'}}),e=>{assert.match(String(e),/rate_limit_error/);assert.match(String(e),/req-claude/);assert.ok(!String(e).includes('private-key'));return true;});
 const fetcher:typeof fetch=async()=>{throw new AppError(502,'Provider failure details')};await assert.rejects(boundedJSON(fetcher,new URL('https://model/v1/messages'),{},{}),/Provider failure details/);
});

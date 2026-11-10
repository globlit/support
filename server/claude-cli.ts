import {tokenUsage} from './model-telemetry.js';
import type {TokenUsage} from '../src/telemetry-model.js';
import {spawn} from 'node:child_process';
import {access,mkdtemp,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError} from './store.js';
import {redactDiagnostic} from './diagnostics.js';

export type CliRunner=(path:string,args:string[],input:string,signal?:AbortSignal|null)=>Promise<{stdout:string;code:number|null}>;
export const isolationArgs=['--safe-mode','--restricted','--setting-sources','','--settings','{"disableAllHooks":true}'];
export function cliEnvironment(source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const env:NodeJS.ProcessEnv={};
 for(const key of ['HOME','PATH','LANG','LC_ALL','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','NODE_USE_ENV_PROXY'])if(source[key])env[key]=source[key];
 return {...env,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
}
export const runCli:CliRunner=async(path,args,input,signal)=>{
 if(process.platform!=='linux')throw new AppError(400,'The local Claude connection requires Support to run on Linux.');
 if(!isAbsolute(path))throw new AppError(400,'Set the absolute path to the Claude executable in Settings → Model.');
 await access(path,constants.X_OK).catch(()=>{throw new AppError(400,'Claude executable is missing or not executable. Check its path in Settings → Model.');});
 if(signal?.aborted)throw new AppError(409,'Claude request cancelled.');
 const cwd=await mkdtemp(join(tmpdir(),'support-claude-'));
 try{return await new Promise((resolve,reject)=>{
  const child=spawn(path,args,{cwd,env:cliEnvironment(),shell:false,detached:true,stdio:['pipe','pipe','pipe']});
  const chunks:Buffer[]=[];let size=0,failure:Error|undefined;
  const stop=(message:string)=>{failure??=new AppError(502,message);try{if(child.pid)process.kill(-child.pid,'SIGKILL')}catch{child.kill('SIGKILL')}};
  const cancel=()=>stop('Claude request cancelled. No result was applied.');
  const timer=setTimeout(()=>stop('Claude CLI did not finish within 60 seconds. Check the CLI where Support runs before retrying.'),60000);
  signal?.addEventListener('abort',cancel,{once:true});
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1_000_000)stop('Claude CLI output exceeded its size limit. No result was applied.');else chunks.push(chunk)});
  // Discard stderr.
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.on('error',()=>{failure=new AppError(502,'Could not start Claude CLI. Check its executable path and installation.');});
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(failure)reject(failure);else resolve({stdout:Buffer.concat(chunks).toString('utf8'),code});});
  child.stdin.end(input);if(signal?.aborted)cancel();
 });}finally{await rm(cwd,{recursive:true,force:true});}
};

export async function claudeCliStatus(path:string,runner:CliRunner=runCli,signal?:AbortSignal){
 const result=await runner(path,[...isolationArgs,'auth','status'],'',signal);
 let data:unknown;try{data=JSON.parse(result.stdout)}catch{throw new AppError(502,'Claude CLI could not report login status. Check that your installed CLI supports --safe-mode and --restricted.');}
 const status=z.object({loggedIn:z.boolean(),authMethod:z.string().optional(),subscriptionType:z.string().nullable().optional()}).parse(data);
 return {connected:result.code===0&&status.loggedIn&&status.authMethod==='claude.ai',method:status.authMethod??'none',plan:status.subscriptionType??undefined};
}

const request=z.object({model:z.string().min(1).max(200),system:z.string().max(32000),messages:z.array(z.unknown()).max(256),tools:z.array(z.object({name:z.string(),description:z.string(),input_schema:z.unknown()})).min(1).max(64)});
export function claudeCliFetch(path:string,runner:CliRunner=runCli,secrets:string[]=[],onUsage?:(usage:TokenUsage|undefined)=>void):typeof fetch{
 return async(_url,init)=>{
  if(init?.method!=='POST'||!String(_url).endsWith('/v1/messages'))throw new AppError(400,'Unsupported local Claude request.');
  const body=request.parse(JSON.parse(String(init.body)));
  const schema={type:'object',additionalProperties:false,required:['action'],properties:{action:{anyOf:body.tools.map(tool=>({type:'object',additionalProperties:false,required:['name','input'],properties:{name:{const:tool.name,type:'string'},input:tool.input_schema}}))}}};
  const args=[...isolationArgs,'--print','--output-format','json','--no-session-persistence','--tools','','--disallowedTools','mcp__*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--permission-mode','dontAsk','--max-turns','3','--model',body.model,'--system-prompt',body.system,'--json-schema',JSON.stringify(schema)];
  const prompt=JSON.stringify({instruction:'Return the next proposed action as structured output. These are descriptions of Support app actions, not CLI tools. Support validates and handles the action. Do not execute anything yourself.',tools:body.tools,messages:body.messages});
  const result=await runner(path,args,prompt,init.signal);
  let raw:unknown;try{raw=JSON.parse(result.stdout)}catch{throw new AppError(502,'Claude CLI returned no structured result. Check its login and supported flags where Support runs. No result was applied.');}
  // Some CLI versions print every message as a JSON array. Use the final result message.
  if(Array.isArray(raw))raw=raw.findLast(m=>(m as {type?:unknown})?.type==='result');
  const value=z.object({type:z.literal('result'),subtype:z.string(),is_error:z.boolean().nullish(),result:z.string().nullish(),errors:z.array(z.string()).nullish(),structured_output:z.unknown().optional()}).safeParse(raw);
  if(!value.success)throw new AppError(502,'Claude CLI returned an unsupported result. No result was applied.');
  const output=value.data;
  if(result.code!==0||output.is_error||output.subtype!=='success'){
   const detail=redactDiagnostic([output.subtype,...(output.errors??[]),output.result??''].join(' · '),secrets).slice(0,1500);
   throw new AppError(502,'Claude CLI could not complete the request. '+detail+' No result was applied. Check login or usage in Claude Code; Support has kept your configuration.');
  }
  onUsage?.(tokenUsage((raw as {usage?:unknown})?.usage,'anthropic'));
  const parsed=z.object({action:z.object({name:z.string(),input:z.unknown()}).strict()}).strict().safeParse(output.structured_output);
  if(!parsed.success||!body.tools.some(t=>t.name===parsed.data.action.name))throw new AppError(502,'Claude CLI returned an invalid or unavailable action. No result was applied.');
  return Response.json({stop_reason:'tool_use',content:[{type:'tool_use',id:randomUUID(),...parsed.data.action}]});
 };
}

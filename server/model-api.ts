import {tokenUsage,rateLimits} from './model-telemetry.js';
import type {TokenUsage,RateLimit} from '../src/telemetry-model.js';
import {claudeCliFetch,claudeCliStatus} from './claude-cli.js';
import {recordDiagnostic} from './diagnostics.js';
import {responseFailure,readFailureBody,type ResponseFailure} from './model-errors.js';
import {chatGPT} from './chatgpt.js';
import {z} from 'zod';
import {Store,AppError} from './store.js';
export type ModelProvider='anthropic'|'openai';
export async function modelKey(store:Store){
 const c=store.snapshot().config;if(c.modelAuth==='claude_cli'){if(!store.key)throw new AppError(423,'Unlock the Vault first.');if(c.modelProvider!=='anthropic')throw new AppError(400,'Local Claude requires the Claude provider.');const status=await claudeCliStatus(c.connections.Model.path);if(!status.connected)throw new AppError(401,'Sign in to Claude Code where Support runs, with your Claude subscription, then check the connection in Settings → Model.');return 'local-cli-no-api-token';}if(c.modelAuth==='chatgpt'){if(c.modelProvider!=='openai'||c.connections.Model.endpoint!=='https://api.openai.com')throw new AppError(400,'ChatGPT sign-in requires OpenAI at https://api.openai.com.');return chatGPT(store).access();}
 const provider=store.snapshot().config.modelProvider;
 if((store.get<string>('modelCredentialProvider')??'anthropic')!==provider)throw new AppError(400,'Save an API key for the selected model provider first.');
 return store.readCredential('Model');
}
const requestSchema=z.object({model:z.string(),max_tokens:z.number(),system:z.string(),messages:z.array(z.object({role:z.enum(['user','assistant']),content:z.union([z.string(),z.array(z.record(z.string(),z.unknown()))])})),tools:z.array(z.object({name:z.string(),description:z.string(),input_schema:z.unknown()}))});
const outputSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('function_call'),call_id:z.string(),name:z.string(),arguments:z.string()}).passthrough(),
 z.object({type:z.literal('reasoning'),id:z.string(),encrypted_content:z.string().optional()}).passthrough(),
 z.object({type:z.literal('message'),content:z.array(z.object({type:z.string(),text:z.string().optional()}))}).passthrough(),
]);
// Provider history stays in memory.
export function modelFetch(provider:ModelProvider,fetcher:typeof fetch=fetch,subscription=false,options:{secrets?:string[];onUsage?:(usage:TokenUsage|undefined,limits:RateLimit[])=>void;onFailure?:(failure:ResponseFailure)=>void}={}):typeof fetch{
 if(provider==='anthropic')return async(url,init)=>{const response=await fetcher(url,init);if(response.status>=400){const key=new Headers(init?.headers).get('x-api-key');const result=responseFailure(await readFailureBody(response),response,undefined,[...(key?[key]:[]),...(options.secrets??[])]);options.onFailure?.(result);throw new AppError(502,result.summary);}const limits=rateLimits(response.headers,'anthropic');if(options.onUsage&&response.ok){const chunks:Uint8Array[]=[];let bytes=0;if(response.body)for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){bytes+=chunk.length;if(bytes>2_000_000)throw new AppError(502,'Model response too large.');chunks.push(chunk);}const text=Buffer.concat(chunks).toString();let usage:TokenUsage|undefined;try{usage=tokenUsage(JSON.parse(text).usage,'anthropic')}catch{}options.onUsage(usage,limits);return new Response(text,{status:response.status,headers:response.headers});}return response;};
 const history=new Map<string,unknown[]>();
 return async(url,init)=>{
  const target=new URL(String(url));
  if(!target.pathname.endsWith('/v1/messages')||init?.method!=='POST')throw new AppError(400,'Unsupported model request.');
  const body=requestSchema.parse(JSON.parse(String(init.body)));
  const input:unknown[]=[];
  for(const message of body.messages){
   if(typeof message.content==='string'){input.push({role:message.role,content:message.content});continue;}
   if(message.role==='assistant'){
    const first=message.content.find(b=>b.type==='tool_use');
    const output=first&&history.get(String(first.id));
    if(!output)throw new AppError(502,'Model tool history is incomplete.');
    input.push(...output);
   }else for(const block of message.content){
    if(block.type!=='tool_result'||typeof block.tool_use_id!=='string')throw new AppError(502,'Unsupported model tool result.');
    input.push({type:'function_call_output',...(subscription?{namespace:'support'}:{}),call_id:block.tool_use_id,output:typeof block.content==='string'?block.content:JSON.stringify(block.content)});
   }
  }
  target.pathname=target.pathname.replace(/\/v1\/messages$/,'/v1/responses');
  const key=new Headers(init.headers).get('x-api-key');if(!key)throw new AppError(400,'Model API key missing.');
  if(subscription&&target.href!=='https://api.openai.com/v1/responses')throw new AppError(400,'Subscription credentials may only be sent to OpenAI.');
  const tools=body.tools.map(t=>({type:'function',name:t.name,description:t.description,parameters:t.input_schema,strict:true}));
  const response=await fetcher(target,{...init,redirect:'manual',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({model:body.model,instructions:body.system,input,...(subscription?{stream:true}:{max_output_tokens:body.max_tokens}),store:false,include:['reasoning.encrypted_content'],parallel_tool_calls:false,tools:subscription?[{type:'namespace',name:'support',description:'Approved support-app custom tools only.',tools}]:tools})});
  const failure=(payload:unknown,event?:string)=>{const result=responseFailure(payload,response,event,[key,...(options.secrets??[])]);options.onFailure?.(result);return new AppError(502,result.summary);};
  if(!response.ok){if(response.status>=400)throw failure(await readFailureBody(response));return response;}
  let payload:unknown;
  if(subscription)payload=await completedStream(response,failure);
  else {const chunks:Uint8Array[]=[];let size=0;if(!response.body)throw new AppError(502,'Empty model response.');for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){size+=chunk.length;if(size>2_000_000)throw new AppError(502,'Model response too large.');chunks.push(chunk);}payload=JSON.parse(Buffer.concat(chunks).toString());}
  options.onUsage?.(tokenUsage((payload as {usage?:unknown})?.usage,'openai'),rateLimits(response.headers,'openai'));
  const raw=z.object({status:z.string(),output:z.array(outputSchema).max(32)}).parse(payload);
  if(raw.status!=='completed')return Response.json({stop_reason:'max_tokens',content:[]});
  const content:unknown[]=[];const ids=new Set<string>();
  for(const item of raw.output){
   if(item.type==='function_call'){
    if(subscription&&item.namespace!=='support')throw new AppError(502,'Unexpected tool namespace.');
    if(ids.has(item.call_id))throw new AppError(502,'Repeated model tool call ID.');ids.add(item.call_id);
    content.push({type:'tool_use',id:item.call_id,name:item.name,input:JSON.parse(item.arguments)});
   }else if(item.type==='message')for(const b of item.content)if(b.type==='output_text'&&b.text)content.push({type:'text',text:b.text});
  }
  const first=raw.output.find(o=>o.type==='function_call');if(first?.type==='function_call')history.set(first.call_id,raw.output);
  return Response.json({stop_reason:ids.size?'tool_use':'end_turn',content});
 };
}

export function configuredModelFetch(store:Store,fetcher:typeof fetch=fetch):typeof fetch{
 const snapshot=store.snapshot(),c=snapshot.config,epoch=store.vaultEpoch,credentialEpoch=store.credentialEpoch,secrets=store.secretValues();
 const onUsage=(usage:TokenUsage|undefined,limits:RateLimit[])=>{if(store.vaultEpoch!==epoch||store.credentialEpoch!==credentialEpoch||store.snapshot().configRevision!==snapshot.configRevision)return;recordDiagnostic(store,{tool:'Model',operation:'Model usage',status:'ok',durationMs:0,output:usage?'Provider-reported token counts. No prompt or response text retained.':'Token usage not reported.',telemetry:{usage,limits,provider:c.modelProvider,auth:c.modelAuth,model:c.connections.Model.scope}},secrets);};
 if(c.modelAuth==='claude_cli'){if(c.modelProvider!=='anthropic')throw new AppError(400,'Local Claude requires the Claude provider.');const transport=claudeCliFetch(c.connections.Model.path,undefined,secrets,usage=>{onUsage(usage,[]);});return async(url,init)=>{try{return await transport(url,init)}catch(e){if(store.vaultEpoch===epoch)recordDiagnostic(store,{tool:'Model',operation:'Claude CLI failure',status:'error',durationMs:0,output:e instanceof AppError?e.message:'Local Claude request failed.'},secrets);throw e;}};}
 return modelFetch(c.modelProvider,fetcher,c.modelAuth==='chatgpt',{secrets,onUsage,onFailure:failure=>{
  if(store.vaultEpoch===epoch)recordDiagnostic(store,{tool:'Model',operation:c.modelProvider==='anthropic'?'Claude API failure':'Responses failure',status:'error',durationMs:0,code:failure.httpStatus,output:JSON.stringify(failure)},secrets);
 }});
}
export async function completedStream(response:Response,failure=(payload:unknown,event?:string)=>new AppError(502,responseFailure(payload,response,event).summary)){
 if(!response.body)throw new AppError(502,'Empty subscription stream.');
 const decoder=new TextDecoder();let buffer='',bytes=0;let completed:unknown;
 const event=(block:string)=>{const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')return;const e=JSON.parse(data);if(['response.failed','response.incomplete','error'].includes(e.type))throw failure(e,e.type);if(e.type==='response.completed'){if(completed)throw new AppError(502,'Repeated completion event.');completed=e.response;}};
 for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){bytes+=chunk.length;if(bytes>4_000_000)throw new AppError(502,'Subscription stream exceeded its size limit.');buffer+=decoder.decode(chunk,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let i;while((i=buffer.indexOf('\n\n'))>=0){event(buffer.slice(0,i));buffer=buffer.slice(i+2);}}
 buffer+=decoder.decode();if(buffer.trim())event(buffer);if(!completed)throw new AppError(502,'Subscription stream ended without completion. No result was applied.');return completed;
}

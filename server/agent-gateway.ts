import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {AppError,type Store} from './store.js';
import {modelKey} from './model-api.js';
import {recordDiagnostic} from './diagnostics.js';
import type {AgentToolset} from './agent-toolset.js';

/** One agent session known to the gateway. */
export type GatewaySession={
 runId:string;
 toolset:AgentToolset;
 /** Called with each tool call made through MCP or the HTTP tool API, and its outcome. */
 onTool?(name:string,input:unknown,result:{ok:boolean;text:string}):void;
 /** Called when the model provider refuses a request for rate or usage limits. `resetAt` is an ISO time when known. */
 onLimit?(resetAt?:string):void;
};
const maxBody=32*1024*1024;
const tokenPattern=/^[A-Za-z0-9_-]{32,64}$/;
/** Request headers never forwarded to the model provider. The credential headers are replaced. */
const dropped=new Set(['host','connection','content-length','authorization','x-api-key','accept-encoding','transfer-encoding','keep-alive','proxy-authorization']);

async function readBody(req:IncomingMessage,limit=maxBody){
 const chunks:Buffer[]=[];let size=0;
 for await(const c of req){size+=c.length;if(size>limit)throw new AppError(413,'Request too large.');chunks.push(c);}
 return Buffer.concat(chunks);
}
const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
/** Text sent back to the agent for a tool result: strings as they are, other values as JSON, at most 60,000 characters. */
export const resultText=(value:unknown)=>{const t=typeof value==='string'?value:JSON.stringify(value,null,1)??'';return t.length>60000?t.slice(0,60000)+`\n… [truncated: ${t.length} characters. Narrow the request.]`:t;};

/**
 * HTTP server on the relay address, reachable from the agent sandbox only. Each path starts with a session token
 * that is valid while its session runs:
 * - `/<token>/v1/messages`: model proxy. The placeholder credential of the sandbox is replaced by the real one.
 * - `/<token>/mcp`: Support tools over MCP (streamable HTTP, JSON responses).
 * - `/<token>/tools` and `/<token>/tools/<name>`: the same tools as plain HTTP, for scripts.
 * - `/<token>/kubectl`: read-only kubectl through Toolbox.
 */
export class AgentGateway {
 private sessions=new Map<string,GatewaySession>();private server?:Server;private address?:string;private port?:number;
 constructor(private store:Store,private fetcher:typeof fetch=fetch,private tokenFile=process.env.SUPPORT_CLAUDE_TOKEN_FILE){}
 get listening(){return !!this.port;}
 listen(address:string,port=7072){
  return new Promise<number>((resolve,reject)=>{
   const server=createServer((req,res)=>void this.handle(req,res));
   server.requestTimeout=0;server.headersTimeout=30000;
   server.once('error',reject);
   server.listen(port,address,()=>{this.server=server;this.address=address;this.port=(server.address() as {port:number}).port;resolve(this.port);});
  });
 }
 close(){this.server?.close();this.server=undefined;this.port=undefined;}
 /** Registers a session and returns its base URL for the sandbox. */
 register(session:GatewaySession){
  if(!this.port)throw new AppError(503,'The agent gateway is not listening. Set SUPPORT_RELAY_BIND.');
  const token=randomBytes(24).toString('base64url');this.sessions.set(token,session);
  return {token,url:`http://${this.address}:${this.port}/${token}`};
 }
 release(token:string){this.sessions.delete(token);}
 /** Credential header for the model provider, by connection mode. */
 private async credential():Promise<{upstream:URL;headers:Record<string,string>}>{
  const c=this.store.snapshot().config;
  if(c.modelProvider!=='anthropic')throw new AppError(400,'The agent engine requires the Claude provider.');
  if(c.modelAuth==='api_key'){const base=new URL(c.connections.Model.endpoint.replace(/\/+$/,'')+'/');return {upstream:base,headers:{'x-api-key':await modelKey(this.store)}};}
  if(!this.tokenFile)throw new AppError(503,'No Claude subscription token is available to Support. Set SUPPORT_CLAUDE_TOKEN_FILE.');
  const token=(await readFile(this.tokenFile,'utf8').catch(()=>{throw new AppError(503,'The Claude subscription token file cannot be read.');})).trim();
  if(!/^[A-Za-z0-9_-]+$/.test(token))throw new AppError(503,'The Claude subscription token file is empty or invalid.');
  return {upstream:new URL('https://api.anthropic.com/'),headers:{authorization:'Bearer '+token}};
 }
 private async handle(req:IncomingMessage,res:ServerResponse){
  try{
   const url=new URL(req.url??'/','http://gateway'),[,token,...rest]=url.pathname.split('/'),path='/'+rest.join('/');
   const session=tokenPattern.test(token??'')?this.sessions.get(token):undefined;
   if(!session)return json(res,403,{error:'Unknown or expired session.'});
   if(path==='/api/hello')return void res.writeHead(200).end();
   if(path==='/v1/messages'||path==='/v1/messages/count_tokens')return await this.model(req,res,session,path+url.search);
   if(path==='/mcp')return await this.mcp(req,res,session);
   if(path==='/tools'&&req.method==='GET')return json(res,200,{tools:session.toolset.definitions.map(d=>({name:d.name,description:d.description,input:d.input_schema}))});
   const tool=path.match(/^\/tools\/([a-z_]{1,64})$/);
   if(tool&&req.method==='POST'){const input=JSON.parse((await readBody(req,1_000_000)).toString('utf8')||'{}');const r=await this.call(session,tool[1],input);return json(res,r.ok?200:400,r.ok?r.value:{error:r.text});}
   if(path==='/kubectl'&&req.method==='POST'){const {args}=z.object({args:z.unknown()}).parse(JSON.parse((await readBody(req,100_000)).toString('utf8')||'{}'));const r=await session.toolset.kubectl(args);session.onTool?.('kubectl',args,{ok:r.code===0,text:(r.stdout+r.stderr).slice(0,4000)});return json(res,200,r);}
   recordDiagnostic(this.store,{tool:'Agent',operation:`Agent gateway refused ${req.method} ${path.slice(0,200)}`,status:'error',durationMs:0,output:'This path is not forwarded.'});
   json(res,404,{error:'Not found.'});
  }catch(e){if(!res.headersSent)json(res,e instanceof AppError?e.status:400,{error:e instanceof AppError?e.message:e instanceof z.ZodError?'Invalid request.':'The request failed.'});else res.destroy();}
 }
 /** Runs a tool and reports the call to the session. Errors are returned to the caller, which can adapt. */
 private async call(session:GatewaySession,name:string,input:unknown):Promise<{ok:true;value:unknown;text:string}|{ok:false;text:string}>{
  try{const value=await session.toolset.run(name,input);const text=resultText(value);session.onTool?.(name,input,{ok:true,text});return {ok:true,value,text};}
  catch(e){const text=e instanceof z.ZodError?'Invalid input: '+e.issues.map(i=>`${i.path.join('.')||'input'} ${i.message}`).join('; '):e instanceof AppError?e.message:'The tool failed.';session.onTool?.(name,input,{ok:false,text});return {ok:false,text};}
 }
 private async mcp(req:IncomingMessage,res:ServerResponse,session:GatewaySession){
  if(req.method==='GET')return void res.writeHead(405,{Allow:'POST'}).end();
  if(req.method==='DELETE')return void res.writeHead(200).end();
  if(req.method!=='POST')return void res.writeHead(405).end();
  const body=JSON.parse((await readBody(req,1_000_000)).toString('utf8'));
  const one=async(m:{id?:unknown;method?:string;params?:{name?:string;arguments?:unknown;protocolVersion?:string}})=>{
   if(m.id===undefined)return undefined;
   const reply=(result:unknown)=>({jsonrpc:'2.0',id:m.id,result});
   switch(m.method){
    case 'initialize':return reply({protocolVersion:m.params?.protocolVersion??'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'support',version:'1.0.0'},instructions:'Support tools: Kubernetes through Toolbox, Prometheus, Grafana, Outline, GitLab, YouTrack, Alertmanager, and the workflow tools ask_engineer, propose_change and submit_result. The same tools are available to scripts with the support command.'});
    case 'ping':return reply({});
    case 'tools/list':return reply({tools:session.toolset.definitions.map(d=>({name:d.name,description:d.description,inputSchema:d.input_schema}))});
    case 'tools/call':{const r=await this.call(session,String(m.params?.name??''),m.params?.arguments??{});return reply({content:[{type:'text',text:r.text}],isError:!r.ok});}
    default:return {jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}};
   }
  };
  const out=Array.isArray(body)?(await Promise.all(body.map(one))).filter(Boolean):await one(body);
  if(out===undefined||(Array.isArray(out)&&!out.length))return void res.writeHead(202).end();
  json(res,200,out);
 }
 private async model(req:IncomingMessage,res:ServerResponse,session:GatewaySession,path:string){
  if(req.method!=='POST')return json(res,405,{error:'POST only.'});
  const body=await readBody(req);
  const {upstream,headers}=await this.credential();
  const forward:Record<string,string>={};
  for(const [k,v] of Object.entries(req.headers))if(!dropped.has(k)&&typeof v==='string')forward[k]=v;
  let response:Response;
  try{response=await this.fetcher(new URL(path.replace(/^\//,''),upstream),{method:'POST',headers:{...forward,...headers},body,redirect:'manual'});}
  catch{return json(res,502,{type:'error',error:{type:'api_error',message:'The model provider is unreachable from Support.'}});}
  if(response.status===429){const reset=response.headers.get('anthropic-ratelimit-unified-reset')??response.headers.get('retry-after');session.onLimit?.(reset&&/^\d+$/.test(reset)?new Date(Number(reset)*(Number(reset)>1e10?1:1000)).toISOString():undefined);}
  const out:Record<string,string>={};response.headers.forEach((v,k)=>{if(!['content-encoding','content-length','transfer-encoding','connection'].includes(k))out[k]=v;});
  res.writeHead(response.status,out);
  const usage=new UsageReader();
  if(response.body)for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){usage.push(chunk);if(!res.write(chunk))await new Promise(r=>res.once('drain',r));}
  res.end();
  const u=usage.result();
  if(u&&path.startsWith('/v1/messages?')||u&&path==='/v1/messages'){const c=this.store.snapshot().config;try{this.store.recordUsage({provider:'anthropic',auth:c.modelAuth,model:u.model||c.connections.Model.scope,input:u.input,output:u.output,cacheRead:u.cacheRead,cacheWrite:u.cacheWrite,webSearches:u.webSearches});}catch{}}
 }
}

/** Reads token usage from a Messages API response, streamed (server-sent events) or not. */
export class UsageReader {
 private text='';private input=0;private output=0;private cacheRead=0;private cacheWrite=0;private webSearches=0;private model='';private seen=false;private decoder=new TextDecoder();
 push(chunk:Uint8Array){this.text+=this.decoder.decode(chunk,{stream:true});const lines=this.text.split('\n');this.text=lines.pop()??'';for(const l of lines)this.line(l);if(this.text.length>2_000_000&&!this.text.startsWith('{'))this.text='';}
 private usage(u:Record<string,unknown>|undefined,final=false){
  if(!u)return;this.seen=true;const n=(k:string)=>typeof u[k]==='number'?u[k] as number:undefined;
  if(n('input_tokens')!==undefined)this.input=n('input_tokens')!+(n('cache_read_input_tokens')??0)+(n('cache_creation_input_tokens')??0);
  if(n('cache_read_input_tokens')!==undefined)this.cacheRead=n('cache_read_input_tokens')!;
  if(n('cache_creation_input_tokens')!==undefined)this.cacheWrite=n('cache_creation_input_tokens')!;
  if(n('output_tokens')!==undefined)this.output=n('output_tokens')!;
  const s=(u.server_tool_use as Record<string,unknown>|undefined)?.web_search_requests;if(typeof s==='number'&&(final||s>this.webSearches))this.webSearches=s;
 }
 private line(l:string){
  const data=l.startsWith('data:')?l.slice(5).trim():l.trim().startsWith('{')?l.trim():'';if(!data)return;
  let v:{type?:string;message?:{model?:string;usage?:Record<string,unknown>};usage?:Record<string,unknown>;model?:string};try{v=JSON.parse(data);}catch{return;}
  if(v.type==='message_start'){this.model=v.message?.model??this.model;this.usage(v.message?.usage);}
  else if(v.type==='message_delta')this.usage(v.usage,true);
  else if(v.usage){this.model=v.model??this.model;this.usage(v.usage,true);}
 }
 result(){if(this.text.trim())this.line(this.text);this.text='';return this.seen?{input:this.input,output:this.output,cacheRead:this.cacheRead,cacheWrite:this.cacheWrite,webSearches:this.webSearches,model:this.model}:undefined;}
}

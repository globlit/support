import {z} from 'zod';
import {AppError} from './store.js';

/** Characters of command output returned to the agent. The end of the output is kept. */
export const commandOutputLimit=20000;
export const maxCommandSeconds=600;
export type CommandResult={exitCode:number|null;signal:string|null;durationMs:number;timedOut:boolean;truncated:boolean;output:string};

/** Base URL of the command sandbox, from SUPPORT_SANDBOX_URL, or undefined when no sandbox is configured. */
export function sandboxUrl(env:NodeJS.ProcessEnv=process.env){
 const value=env.SUPPORT_SANDBOX_URL?.trim();if(!value)return undefined;
 const url=new URL(value.replace(/\/+$/,'')+'/');
 if(url.protocol!=='http:'&&url.protocol!=='https:')throw new AppError(500,'SUPPORT_SANDBOX_URL must be an HTTP URL.');
 return url;
}

/** Agent folder inside the sandbox, a volume: Claude configuration, repository clones and run folders. From SUPPORT_AGENT_HOME, default /home/admin/agent. */
export const agentHome=(env:NodeJS.ProcessEnv=process.env)=>env.SUPPORT_AGENT_HOME?.trim().replace(/\/+$/,'')||'/home/admin/agent';

/**
 * Runs a command in the sandbox and waits for it to end. Calls `onOutput` with each chunk of output as it arrives.
 * Aborting `signal` closes the connection, and the sandbox then kills the command.
 * Returns the exit status and the last `commandOutputLimit` characters of stdout and stderr, in arrival order.
 * `redact` is applied to every chunk before `onOutput` and to the returned output.
 */
export async function runSandboxCommand({runId,command,timeoutSeconds,signal,onOutput,redact=v=>v,fetcher=fetch,base=sandboxUrl()}:{runId:string;command:string;timeoutSeconds:number;signal:AbortSignal;onOutput?:(text:string,stream:'stdout'|'stderr')=>void;redact?:(value:string)=>string;fetcher?:typeof fetch;base?:URL}):Promise<CommandResult>{
 if(!base)throw new AppError(400,'No command sandbox is configured. Set SUPPORT_SANDBOX_URL.');
 let response:Response;
 try{response=await fetcher(new URL('v1/exec',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId,command,timeoutSeconds}),signal,redirect:'manual'});}
 catch(e){if(signal.aborted)throw new AppError(409,'Command stopped.');throw new AppError(502,'The command sandbox is unreachable. Check the sandbox service.');}
 if(!response.ok){const text=await response.text().catch(()=>'');let detail='';try{detail=JSON.parse(text).error??''}catch{}throw new AppError(502,`The command sandbox refused the command (HTTP ${response.status}). ${detail}`.trim());}
 if(!response.body)throw new AppError(502,'The command sandbox returned no output.');
 let output='',dropped=false,pending='',exit:Partial<CommandResult>&{code?:number|null}|undefined;
 const decoder=new TextDecoder();
 const line=(text:string)=>{
  if(!text.trim())return;
  let entry:{type?:string;data?:unknown;code?:number|null;signal?:string|null;durationMs?:number;timedOut?:boolean;truncated?:boolean};
  try{entry=JSON.parse(text)}catch{return;}
  if((entry.type==='stdout'||entry.type==='stderr')&&typeof entry.data==='string'){
   const data=redact(entry.data);onOutput?.(data,entry.type);
   output+=data;if(output.length>commandOutputLimit*2){output=output.slice(-commandOutputLimit);dropped=true;}
  }else if(entry.type==='exit')exit=entry;
 };
 try{for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){pending+=decoder.decode(chunk,{stream:true});if(pending.length>4_000_000)throw new AppError(502,'The command sandbox sent an oversized frame.');const lines=pending.split('\n');pending=lines.pop()??'';lines.forEach(line);}line(pending);}
 catch(e){if(signal.aborted)throw new AppError(409,'Command stopped.');if(e instanceof AppError)throw e;throw new AppError(502,'The connection to the command sandbox was interrupted.');}
 if(!exit)throw new AppError(502,'The command sandbox ended without an exit status.');
 if(output.length>commandOutputLimit){output=output.slice(-commandOutputLimit);dropped=true;}
 return {exitCode:exit.code??null,signal:exit.signal??null,durationMs:exit.durationMs??0,timedOut:!!exit.timedOut,truncated:dropped||!!exit.truncated,output};
}

async function call(path:string,method:string,fetcher:typeof fetch,base=sandboxUrl()){
 if(!base)return undefined;
 const response=await fetcher(new URL(path,base),{method,signal:AbortSignal.timeout(5000),redirect:'manual'});
 if(!response.ok)throw new AppError(502,`The command sandbox returned HTTP ${response.status}.`);
 return response.json() as Promise<Record<string,unknown>>;
}
/** Kills every command running in the sandbox. Does nothing when no sandbox is configured. */
export async function killAllSandbox(fetcher:typeof fetch=fetch){try{await call('v1/kill-all','POST',fetcher);}catch{}}
/** Kills the run's commands and deletes its working folder in the sandbox. Errors are ignored. */
export async function cleanupSandboxRun(runId:string,fetcher:typeof fetch=fetch){if(/^[A-Za-z0-9_-]{1,100}$/.test(runId))try{await call('v1/runs/'+runId,'DELETE',fetcher);}catch{}}
/** Returns whether the sandbox is configured and answers its health check, and the time of its last successful answer since Support started. */
export async function sandboxHealth(fetcher:typeof fetch=fetch){
 if(!sandboxUrl())return {configured:false,reachable:false};
 try{const v=await call('v1/health','GET',fetcher);if(v?.ok===true)lastSandboxOk=new Date().toISOString();return {configured:true,reachable:v?.ok===true,lastOkAt:lastSandboxOk};}catch{return {configured:true,reachable:false,lastOkAt:lastSandboxOk};}
}
let lastSandboxOk:string|undefined;

export type RepoChange={path:string;status:string;content:string|null};
/** Uploads a repository archive (.tar.gz stream) into the run's folder in the sandbox as repos/<name>. Returns the folder and file count. */
export async function uploadRepo(runId:string,name:string,archive:ReadableStream<Uint8Array>,signal:AbortSignal,fetcher:typeof fetch=fetch,base=sandboxUrl()){
 if(!base)throw new AppError(400,'No command sandbox is configured. Set SUPPORT_SANDBOX_URL.');
 const response=await fetcher(new URL(`v1/runs/${runId}/repos/${name}`,base),{method:'PUT',headers:{'Content-Type':'application/gzip'},body:archive,duplex:'half',signal,redirect:'manual'} as RequestInit).catch(()=>{throw new AppError(502,'The command sandbox is unreachable. Check the sandbox service.');});
 const value=await response.json().catch(()=>({})) as {path?:string;files?:number;error?:string};
 if(!response.ok)throw new AppError(502,'The sandbox refused the repository: '+(value.error??`HTTP ${response.status}`));
 return {path:value.path??`repos/${name}`,files:value.files??0};
}
/** Returns the files changed in a sandbox checkout since its base commit. Content is base64, null for deleted files. */
export async function repoChanges(runId:string,name:string,fetcher:typeof fetch=fetch,base=sandboxUrl()):Promise<RepoChange[]>{
 if(!base)throw new AppError(400,'No command sandbox is configured. Set SUPPORT_SANDBOX_URL.');
 const response=await fetcher(new URL(`v1/runs/${runId}/repos/${name}/changes`,base),{method:'GET',signal:AbortSignal.timeout(60000),redirect:'manual'}).catch(()=>{throw new AppError(502,'The command sandbox is unreachable. Check the sandbox service.');});
 const text=await boundedText(response,12_000_000);let value:unknown;try{value=JSON.parse(text);}catch{value={};}
 if(!response.ok)throw new AppError(response.status===404?404:400,String((value as {error?:unknown}).error??`The sandbox returned HTTP ${response.status}.`).slice(0,500));
 return changeList.parse(value).files;
}

const changeList=z.object({files:z.array(z.object({path:z.string().max(1000),status:z.string().max(4),content:z.string().max(4_000_000).nullable()})).max(50)});
/** Reads a response body of at most `limit` bytes as text. Fails with an AppError when it is larger. */
async function boundedText(response:Response,limit:number){
 const chunks:Uint8Array[]=[];let size=0;
 if(response.body)for await(const c of response.body as unknown as AsyncIterable<Uint8Array>){size+=c.length;if(size>limit){await response.body.cancel().catch(()=>{});throw new AppError(502,'The command sandbox returned a response that is too large.');}chunks.push(c);}
 return Buffer.concat(chunks).toString('utf8');
}
/**
 * Returns the files changed in the Git folder `dir` of the sandbox since commit `base`. Content is base64, null for
 * deleted files. The folder must be inside the agent root or a run folder.
 */
export async function folderChanges(dir:string,base:string,fetcher:typeof fetch=fetch,url=sandboxUrl()):Promise<RepoChange[]>{
 if(!url)throw new AppError(400,'No command sandbox is configured. Set SUPPORT_SANDBOX_URL.');
 const u=new URL('v1/changes',url);u.searchParams.set('dir',dir);u.searchParams.set('base',base);
 const response=await fetcher(u,{method:'GET',signal:AbortSignal.timeout(60000),redirect:'manual'}).catch(()=>{throw new AppError(502,'The command sandbox is unreachable. Check the sandbox service.');});
 const text=await boundedText(response,12_000_000);let value:unknown;try{value=JSON.parse(text);}catch{value={};}
 if(!response.ok)throw new AppError(response.status===404?404:400,String((value as {error?:unknown}).error??`The sandbox returned HTTP ${response.status}.`).slice(0,500));
 return changeList.parse(value).files;
}

export type AgentLine={type:'stdout'|'stderr';data:string};
/**
 * Starts a Claude Code session in the sandbox, writes `input` to its stdin, and calls `onLine` with each complete stdout line and each stderr
 * chunk. Resolves with the exit status when the session ends. Aborting `signal` kills the session.
 */
export async function runAgentSession({runId,cwd,args,env,input,timeoutSeconds,signal,onLine,fetcher=fetch,base=sandboxUrl()}:{runId:string;cwd:string;args:string[];env:Record<string,string>;input:string;timeoutSeconds:number;signal:AbortSignal;onLine:(line:AgentLine)=>void;fetcher?:typeof fetch;base?:URL}){
 if(!base)throw new AppError(400,'No command sandbox is configured. Set SUPPORT_SANDBOX_URL.');
 let response:Response;
 try{response=await fetcher(new URL('v1/agent',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId,cwd,args,env,timeoutSeconds,input}),signal,redirect:'manual'});}
 catch{if(signal.aborted)throw new AppError(409,'Agent session stopped.');throw new AppError(502,'The command sandbox is unreachable. Check the sandbox service.');}
 if(!response.ok){const text=await boundedText(response,65536).catch(()=>'');let detail='';try{detail=String(JSON.parse(text).error??'')}catch{}throw new AppError(502,`The command sandbox refused the agent session (HTTP ${response.status}). ${detail}`.trim());}
 if(!response.body)throw new AppError(502,'The command sandbox returned no output.');
 const decoder=new TextDecoder();let pending='',stdout='',exit:{code?:number|null;signal?:string|null;timedOut?:boolean;truncated?:boolean}|undefined;
 const frame=(text:string)=>{
  if(!text.trim())return;let entry:{type?:string;data?:unknown;code?:number|null;signal?:string|null;timedOut?:boolean;truncated?:boolean};try{entry=JSON.parse(text)}catch{return;}
  if(entry.type==='stdout'&&typeof entry.data==='string'){stdout+=entry.data;const lines=stdout.split('\n');stdout=lines.pop()??'';if(stdout.length>8_000_000)throw new AppError(502,'The agent printed a line longer than 8 MB.');for(const l of lines)if(l.trim())onLine({type:'stdout',data:l});}
  else if(entry.type==='stderr'&&typeof entry.data==='string')onLine({type:'stderr',data:entry.data});
  else if(entry.type==='exit')exit=entry;
 };
 try{for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){pending+=decoder.decode(chunk,{stream:true});if(pending.length>16_000_000)throw new AppError(502,'The command sandbox sent an oversized frame.');const parts=pending.split('\n');pending=parts.pop()??'';parts.forEach(frame);}frame(pending);if(stdout.trim())onLine({type:'stdout',data:stdout});}
 catch(e){if(signal.aborted)throw new AppError(409,'Agent session stopped.');if(e instanceof AppError)throw e;throw new AppError(502,'The connection to the command sandbox was interrupted.');}
 return {code:exit?.code??null,signal:exit?.signal??null,timedOut:!!exit?.timedOut,truncated:!!exit?.truncated,ended:!!exit};
}
/** Writes `data` to the stdin of a running agent session, or closes its stdin when `end` is set. */
export async function agentInput(runId:string,input:{data?:string;end?:boolean},fetcher:typeof fetch=fetch,base=sandboxUrl()){
 if(!base)throw new AppError(400,'No command sandbox is configured.');
 const response=await fetcher(new URL(`v1/agent/${runId}/input`,base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(10000),redirect:'manual'}).catch(()=>{throw new AppError(502,'The command sandbox is unreachable.');});
 await response.body?.cancel().catch(()=>{});
 if(!response.ok)throw new AppError(409,'The agent session is not running.');
}

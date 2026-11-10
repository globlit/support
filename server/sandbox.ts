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
 catch(e){if(signal.aborted)throw new AppError(409,'Command stopped.');throw new AppError(502,'The command sandbox is unreachable. Check the support-sandbox service.');}
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
 try{for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){pending+=decoder.decode(chunk,{stream:true});const lines=pending.split('\n');pending=lines.pop()??'';lines.forEach(line);}line(pending);}
 catch{if(signal.aborted)throw new AppError(409,'Command stopped.');throw new AppError(502,'The connection to the command sandbox was interrupted.');}
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
/** Returns whether the sandbox is configured and answers its health check. */
export async function sandboxHealth(fetcher:typeof fetch=fetch){
 if(!sandboxUrl())return {configured:false,reachable:false};
 try{const v=await call('v1/health','GET',fetcher);return {configured:true,reachable:v?.ok===true};}catch{return {configured:true,reachable:false};}
}

export type RepoChange={path:string;status:string;content:string|null};
/** Uploads a repository archive (.tar.gz stream) into the run's folder in the sandbox as repos/<name>. Returns the folder and file count. */
export async function uploadRepo(runId:string,name:string,archive:ReadableStream<Uint8Array>,signal:AbortSignal,fetcher:typeof fetch=fetch,base=sandboxUrl()){
 if(!base)throw new AppError(400,'No command sandbox is configured. Set SUPPORT_SANDBOX_URL.');
 const response=await fetcher(new URL(`v1/runs/${runId}/repos/${name}`,base),{method:'PUT',headers:{'Content-Type':'application/gzip'},body:archive,duplex:'half',signal,redirect:'manual'} as RequestInit).catch(()=>{throw new AppError(502,'The command sandbox is unreachable. Check the support-sandbox service.');});
 const value=await response.json().catch(()=>({})) as {path?:string;files?:number;error?:string};
 if(!response.ok)throw new AppError(502,'The sandbox refused the repository: '+(value.error??`HTTP ${response.status}`));
 return {path:value.path??`repos/${name}`,files:value.files??0};
}
/** Returns the files changed in a sandbox checkout since its base commit. Content is base64, null for deleted files. */
export async function repoChanges(runId:string,name:string,fetcher:typeof fetch=fetch,base=sandboxUrl()):Promise<RepoChange[]>{
 if(!base)throw new AppError(400,'No command sandbox is configured. Set SUPPORT_SANDBOX_URL.');
 const response=await fetcher(new URL(`v1/runs/${runId}/repos/${name}/changes`,base),{method:'GET',signal:AbortSignal.timeout(60000),redirect:'manual'}).catch(()=>{throw new AppError(502,'The command sandbox is unreachable. Check the support-sandbox service.');});
 const value=await response.json().catch(()=>({})) as {files?:RepoChange[];error?:string};
 if(!response.ok||!value.files)throw new AppError(response.status===404?404:400,value.error??`The sandbox returned HTTP ${response.status}.`);
 return value.files;
}

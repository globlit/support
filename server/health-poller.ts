import {outlineCollectionRef} from './outline.js';
export {outlineCollectionRef};
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {connectionNames,type Config,type ConnectionName} from '../src/model.js';
import {logTools} from '../src/diagnostics-model.js';
import {Store,AppError} from './store.js';
import {serviceBase} from './gitlab.js';
import {serviceAuthHeaders} from './service-auth.js';
import {probeToolboxContexts,toolboxFiles} from './toolbox.js';
import {modelKey} from './model-api.js';
import {claudeCliStatus} from './claude-cli.js';
import {recordDiagnostic} from './diagnostics.js';
import {healthIntervalMs,healthTimeouts,recordHealthProbe,toolHealth,type HealthResult} from './tool-health.js';
export type HealthProbe=(name:ConnectionName,config:Config,signal:AbortSignal)=>Promise<HealthResult>;
// Log availability and HTTP status only.
class ProbeError extends Error{}
async function readResponse(response:Response,signal:AbortSignal,limit:number){
 const reader=response.body?.getReader();if(!reader)return '';const chunks:Uint8Array[]=[];let bytes=0;
 try{while(true){signal.throwIfAborted();const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>limit)throw new ProbeError('Health response exceeded its size limit.');chunks.push(next.value)}return Buffer.concat(chunks).toString('utf8')}finally{void reader.cancel().catch(()=>{});}
}
/**
 * Checks that an Outline token can read the configured collection with `documents.list`. A collection ID is used directly
 * and needs the `documents:read` scope only. A name or URL is resolved with `collections.list`, which needs `collections:read`.
 * Without a configured collection, lists one document of any collection.
 */
async function probeOutline(base:URL,token:string,collection:string,fetcher:typeof fetch,signal:AbortSignal):Promise<HealthResult>{
 const call=async(path:string,body:unknown)=>{
  const response=await fetcher(new URL(path,base),{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),redirect:'manual',signal});
  if(!response.ok){void response.body?.cancel().catch(()=>{});const method=path.replace(/^api\//,''),scope=method.split('.')[0]+':read';throw new ProbeError(response.status===401?'Outline rejected the saved token: it is invalid, expired or revoked.':response.status===403?`The token's scopes do not allow ${method}. Add ${scope} to the Outline API key.`:`Outline returned HTTP ${response.status} for ${path}.`);}
  try{return JSON.parse(await readResponse(response,signal,2_000_000))}catch(e){if(e instanceof ProbeError)throw e;throw new ProbeError('Outline returned an unexpected response.');}
 };
 if(!collection.trim()){const v=await call('api/documents.list',{limit:1});return Array.isArray(v?.data)?{ok:true,detail:'Outline API accepts the saved token. No collection is set.'}:{ok:false,detail:'Outline returned an unexpected response.'};}
 const {ref,urlId}=outlineCollectionRef(collection);
 let found:{id:string;name:string}|undefined=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)?{id:ref,name:ref}:undefined;
 for(let offset=0;offset<1000&&!found;offset+=100){
  let page;
  try{page=await call('api/collections.list',{limit:100,offset});}
  catch(e){if(e instanceof ProbeError&&e.message.startsWith("The token's scopes"))return {ok:false,detail:'The token cannot list collections. Add collections:read to the Outline API key, or set the collection ID instead of its name.'};throw e;}const items:{id:string;urlId?:string;name:string}[]=Array.isArray(page?.data)?page.data:[];
  found=items.find(c=>c.id===ref||(!!urlId&&c.urlId===urlId)||c.name.toLowerCase()===ref.toLowerCase());
  if(items.length<100)break;
 }
 if(!found)return {ok:false,detail:`The saved token cannot see an Outline collection matching "${ref.slice(0,100)}". Use the name shown in Outline's sidebar, or paste the collection URL.`};
 const documents=await call('api/documents.list',{collectionId:found.id,limit:1});
 if(!Array.isArray(documents?.data))return {ok:false,detail:'Outline returned an unexpected document list.'};
 return {ok:true,detail:documents.data.length?`The saved token can read documents in the Outline collection "${found.name}".`:`The saved token can open the Outline collection "${found.name}". It has no documents yet.`};
}
export function serviceProbe(store:Store,fetcher:typeof fetch=fetch):HealthProbe{return async(name,config,signal)=>{
 const c=config.connections[name];signal.throwIfAborted();
 if(name==='Toolbox'){
  const binary=process.env.SUPPORT_TOOLBOX_BINARY??'/usr/local/bin/toolbox';
  const pasted=store.vaultStatus().credentials.includes('Toolbox');
  if(process.platform!=='linux'||!isAbsolute(binary)||(!pasted&&!isAbsolute(c.path)))return {ok:false,detail:'Add a kubeconfig and generate the Toolbox configuration in Settings → Connections → Toolbox.'};
  if(!pasted)await access(c.path,constants.R_OK);signal.throwIfAborted();
  return await probeToolboxContexts(config,pasted?toolboxFiles(store):null,signal);
 }
 if(name==='Model'&&config.modelAuth==='claude_cli'){
  const status=await claudeCliStatus(c.path,undefined,signal);return {ok:status.connected,detail:status.connected?'Local Claude CLI responds and is signed in. No generation or remote model request performed.':'Local Claude CLI is not signed in with a subscription.'};
 }
 const base=serviceBase(c.endpoint),headers:Record<string,string>={Accept:'application/json'};
 const optionalToken=()=>store.vaultStatus().credentials.includes(name)?store.readCredential(name):undefined;
 if(name==='Outline'&&store.vaultStatus().credentials.includes('Outline'))return await probeOutline(base,store.readCredential('Outline'),c.scope,fetcher,signal);
 let path='',method:'GET'|'POST'='GET',body:string|undefined,format:'json'|'text'='json',check:(v:any)=>boolean=()=>true,detail='';
 switch(name){
  case 'YouTrack':path='api/users/me?fields=id';headers.Authorization='Bearer '+store.readCredential(name);check=v=>typeof v.id==='string';detail='YouTrack API responds and accepts the saved token.';break;
  case 'GitLab':{path='api/v4/projects?membership=true&simple=true&per_page=1';headers['PRIVATE-TOKEN']=store.readCredential(name);check=v=>Array.isArray(v);detail='GitLab project API responds and accepts the saved token.';break;}
  case 'Alertmanager':path='api/v2/status';check=v=>typeof v?.versionInfo==='object';detail='Alertmanager API responds and accepts the configured authentication.';Object.assign(headers,serviceAuthHeaders(store,name));break;
  case 'Prometheus':path='api/v1/status/buildinfo';check=v=>v?.status==='success';detail='Prometheus API responds and accepts the configured authentication.';Object.assign(headers,serviceAuthHeaders(store,name));break;
  case 'Outline':path='_health';format='text';check=v=>String(v).trim()==='OK';detail='Outline responds. No token saved, so only availability is checked.';break;
  case 'Slack':path=base.pathname.replace(/\/$/,'').endsWith('/api')?'auth.test':'api/auth.test';method='POST';headers.Authorization='Bearer '+store.readCredential(name);check=v=>v?.ok===true;detail='Slack API accepts the saved token. Channel permissions are checked when a request is opened.';break;
  case 'Model':{
   if(config.modelAuth==='chatgpt'&&(config.modelProvider!=='openai'||c.endpoint!=='https://api.openai.com'))return {ok:false,detail:'Restore the OpenAI endpoint for ChatGPT sign-in.'};
   const token=await modelKey(store);signal.throwIfAborted();
   if(config.modelProvider==='openai')headers.Authorization='Bearer '+token;else {headers['x-api-key']=token;headers['anthropic-version']='2023-06-01'}
   path=config.modelAuth==='chatgpt'?'v1/models':'v1/models/'+encodeURIComponent(c.scope);
   check=config.modelAuth==='chatgpt'?v=>Array.isArray(v.models):v=>typeof v.id==='string';detail='Model catalog responds and accepts authentication. No tokens generated.';break;
  }
 }
 signal.throwIfAborted();const response=await fetcher(new URL(path,base),{method,headers,body,redirect:'manual',signal});
 if(!response.ok){void response.body?.cancel().catch(()=>{});return {ok:false,code:response.status,detail:response.status===401||response.status===403?'Authentication or access denied.':response.status===429?'Rate limited.':response.status>=300&&response.status<400?'Endpoint redirected; check its saved base URL.':`Endpoint returned HTTP ${response.status}.`};}
 const text=await readResponse(response,signal,name==='Model'?2_000_000:131072);let value:unknown;try{value=format==='json'?JSON.parse(text):text}catch{return {ok:false,code:response.status,detail:'Endpoint returned an unexpected response.'}}
 const ok=check(value),reported=(value as {error?:unknown})?.error;
 return {ok,code:response.status,detail:ok?detail:typeof reported==='string'?`Service reported: ${reported.slice(0,200)}.`:'Endpoint returned an unexpected health response.'};
};}
function probeFailure(e:unknown,timeout:boolean,ms:number):HealthResult{
 return {ok:false,detail:timeout?`Timed out after ${ms/1000}s.`:e instanceof ProbeError?e.message:e instanceof AppError&&[400,401,403].includes(e.status)?'Check the saved endpoint, credentials and local tool configuration.':'Connection failed. Check the endpoint, VPN and TLS settings.'};
}
/** Runs one read-only probe. Records no health state. */
export async function testConnection(name:ConnectionName,config:Config,probe:HealthProbe,ms=healthTimeouts[name]):Promise<HealthResult>{
 const controller=new AbortController();let timeout=false;const timer=setTimeout(()=>{timeout=true;controller.abort()},ms);
 const aborted=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));
 try{return await Promise.race([probe(name,config,controller.signal),aborted]);}catch(e){return probeFailure(e,timeout,ms);}finally{clearTimeout(timer);}
}
export class HealthPoller{
 private context='';private next=new Map<ConnectionName,number>();private active=new Map<ConnectionName,AbortController>();private stopped=false;
 constructor(private store:Store,private probe:HealthProbe=serviceProbe(store),private now=()=>Date.now(),private timeouts=healthTimeouts){}
 private identity(){return `${this.store.snapshot().configRevision}:${this.store.credentialEpoch}:${this.store.vaultEpoch}`}
 async tick(){
  if(this.stopped)return;const context=this.identity();
  if(context!==this.context){for(const controller of this.active.values())controller.abort();this.next.clear();this.context=context;}
  if(!this.store.key)return;
  const config=this.store.snapshot().config;
  const due=connectionNames.filter(name=>config.connections[name].enabled&&!this.active.has(name)&&(this.next.get(name)??0)<=this.now()).slice(0,Math.max(0,2-this.active.size));
  await Promise.allSettled(due.map(name=>this.check(name,config,context)));
 }
 private async check(name:ConnectionName,config:Config,context:string){
  const controller=new AbortController(),start=this.now();this.active.set(name,controller);this.next.set(name,start+healthIntervalMs);
  let timeout=false;const timer=setTimeout(()=>{timeout=true;controller.abort()},this.timeouts[name]);
  const aborted=new Promise<HealthResult>(resolve=>controller.signal.addEventListener('abort',()=>resolve({ok:false,detail:timeout?`Timed out after ${this.timeouts[name]/1000}s.`:'Check cancelled.'}),{once:true}));
  let result:HealthResult;
  try{result=await Promise.race([this.probe(name,config,controller.signal),aborted]);}catch(e){result=probeFailure(e,timeout,this.timeouts[name]);}
  finally{clearTimeout(timer);this.active.delete(name)}
  if(this.stopped||!this.store.key||this.identity()!==context)return;
  const before=toolHealth(this.store,this.now()).find(t=>t.name===name)!;
  recordHealthProbe(this.store,name,result,Math.max(0,this.now()-start),this.now());
  const after=toolHealth(this.store,this.now()).find(t=>t.name===name)!;
  // Log state changes only.
  if(before.state!==after.state||before.label!==after.label)recordDiagnostic(this.store,{tool:logTools.includes(name as typeof logTools[number])?name as typeof logTools[number]:'App',operation:`${name} availability check`,status:result.ok?'ok':'error',durationMs:Math.max(0,this.now()-start),code:result.code,output:after.label+': '+result.detail});
 }
 stop(){this.stopped=true;for(const controller of this.active.values())controller.abort()}
}

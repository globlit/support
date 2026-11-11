import {outlineCollectionRef} from './outline.js';
export {outlineCollectionRef};
import {connectionNames,type Config,type ConnectionName} from '../src/model.js';
import {logTools} from '../src/diagnostics-model.js';
import {Store,AppError} from './store.js';
import {serviceBase} from './gitlab.js';
import {serviceAuthHeaders,serverAuthHeaders} from './service-auth.js';
import {checkContext,enabledContexts} from './kubernetes.js';
import {modelKey} from './model-api.js';
import {claudeLoginStatus} from './claude-login.js';
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
 if(name==='Kubernetes'){
  const contexts=enabledContexts(store,config);
  if(!contexts.length)return {ok:false,detail:'No enabled context with a saved token. Import a kubeconfig or add a context in Settings → Connections → Kubernetes.'};
  const results=await Promise.all(contexts.map(x=>checkContext(store,config,x.name,signal)));
  const failed=results.filter(r=>!r.ok);
  return failed.length?{ok:false,detail:`${failed.length} of ${results.length} contexts failed. ${failed.slice(0,3).map(r=>r.detail).join(' ')}`}:{ok:true,detail:results.length===1?results[0].detail:`${results.length} contexts answer: ${contexts.map(x=>x.name).join(', ')}.`};
 }
 if(name==='Model'&&config.modelAuth==='claude_subscription'){
  const status=await claudeLoginStatus(undefined,signal);return {ok:status.connected,detail:status.connected?'Claude Code in the sandbox is signed in. No generation or remote model request performed.':'Claude Code in the sandbox is not signed in with a subscription.'};
 }
 if(name==='Prometheus'){
  const servers=config.prometheusSources.filter(s=>s.kind==='url');
  if(!servers.length)return {ok:true,detail:'No Prometheus server reached by URL. Servers through Kubernetes are checked with Test.'};
  for(const s of servers){
   let response:Response;
   try{response=await fetcher(new URL('api/v1/status/buildinfo',serviceBase(s.endpoint)),{method:'GET',headers:{Accept:'application/json',...serverAuthHeaders(store,s.id)},redirect:'manual',signal});}
   catch(e){if(signal.aborted)throw e;return {ok:false,detail:`${s.name}: connection failed. Check the URL, VPN and TLS settings.`};}
   if(!response.ok){void response.body?.cancel().catch(()=>{});return {ok:false,code:response.status,detail:`${s.name}: ${response.status===401||response.status===403?'authentication or access denied':`HTTP ${response.status}`}.`};}
   let value:unknown;try{value=JSON.parse(await readResponse(response,signal,131072));}catch{value=undefined;}
   if((value as {status?:unknown})?.status!=='success')return {ok:false,detail:`${s.name}: the endpoint is not a Prometheus API.`};
  }
  return {ok:true,detail:`${servers.length===1?servers[0].name+' responds':`${servers.length} Prometheus servers respond`} and accept${servers.length===1?'s':''} the configured authentication.`};
 }
 if(name==='GitLab'){
  const base=serviceBase(c.endpoint),auth={Accept:'application/json','PRIVATE-TOKEN':store.readCredential(name)};
  const get=async(path:string)=>{const r=await fetcher(new URL(path,base),{method:'GET',headers:auth,redirect:'manual',signal});let value:unknown;try{value=JSON.parse(await readResponse(r,signal,131072));}catch{if(signal.aborted)throw signal.reason;value=undefined;}return {status:r.status,value};};
  // GitLab answers 401 to an invalid, expired or revoked token, and 403 to a valid token that lacks a permission.
  const self=await get('api/v4/personal_access_tokens/self');
  if(self.status===401)return {ok:false,code:401,detail:'GitLab rejected the saved token: it is invalid, expired or revoked.'};
  if(self.status>=300&&self.status<400)return {ok:false,code:self.status,detail:'GitLab redirected the request. Check the service URL.'};
  const t=self.value as {active?:boolean;revoked?:boolean;expires_at?:string|null;name?:string}|undefined;
  if(self.status===200&&t&&typeof t==='object'&&typeof t.active==='boolean'){
   if(t.revoked||t.active===false)return {ok:false,detail:'The saved GitLab token is revoked or inactive.'};
   const days=t.expires_at?Math.floor((Date.parse(t.expires_at)-Date.now())/86400000):undefined;
   return {ok:true,code:200,detail:`GitLab accepts the saved token${t.name?` "${t.name}"`:''}.${days!==undefined?days<=14?` It expires in ${Math.max(0,days)} day${days===1?'':'s'} (${t.expires_at}): renew it.`:` It expires on ${t.expires_at}.`:''}`};
  }
  const list=await get('api/v4/projects?membership=true&simple=true&per_page=1');
  if(list.status===200&&Array.isArray(list.value))return {ok:true,code:200,detail:'GitLab project API responds and accepts the saved token.'};
  if(list.status===401)return {ok:false,code:401,detail:'GitLab rejected the saved token: it is invalid, expired or revoked.'};
  if(list.status===403)return {ok:true,code:403,detail:'GitLab accepts the saved token, but it cannot list projects. Add Project: Read and Group: Read under User to the token so the agent can list them.'};
  return {ok:false,code:list.status,detail:`GitLab returned HTTP ${list.status}. Check the service URL and the token.`};
 }
 const base=serviceBase(c.endpoint),headers:Record<string,string>={Accept:'application/json'};
 if(name==='Outline'&&store.vaultStatus().credentials.includes('Outline'))return await probeOutline(base,store.readCredential('Outline'),c.scope,fetcher,signal);
 let path='',method:'GET'|'POST'='GET',body:string|undefined,format:'json'|'text'='json',check:(v:any)=>boolean=()=>true,detail='';
 switch(name){
  case 'YouTrack':path='api/users/me?fields=id';headers.Authorization='Bearer '+store.readCredential(name);check=v=>typeof v.id==='string';detail='YouTrack API responds and accepts the saved token.';break;
  case 'Alertmanager':path='api/v2/status';check=v=>typeof v?.versionInfo==='object';detail='Alertmanager API responds and accepts the configured authentication.';Object.assign(headers,serviceAuthHeaders(store,name));break;
  case 'Grafana':path='api/user';check=v=>typeof v?.login==='string';detail='Grafana API responds and accepts the configured authentication.';Object.assign(headers,serviceAuthHeaders(store,name));break;
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

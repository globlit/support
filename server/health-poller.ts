import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connectionNames,type Config,type ConnectionName} from '../src/model.js';
import {logTools} from '../src/diagnostics-model.js';
import {Store,AppError} from './store.js';
import {serviceBase} from './gitlab.js';
import {modelKey} from './model-api.js';
import {claudeCliStatus} from './claude-cli.js';
import {recordDiagnostic} from './diagnostics.js';
import {healthIntervalMs,healthTimeouts,recordHealthProbe,toolHealth,type HealthResult} from './tool-health.js';
const exec=promisify(execFile);
export type HealthProbe=(name:ConnectionName,config:Config,signal:AbortSignal)=>Promise<HealthResult>;
// Probe responses are deliberately omitted from logs: only availability and HTTP status are kept.
class ProbeError extends Error{}
async function readResponse(response:Response,signal:AbortSignal,limit:number){
 const reader=response.body?.getReader();if(!reader)return '';const chunks:Uint8Array[]=[];let bytes=0;
 try{while(true){signal.throwIfAborted();const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>limit)throw new ProbeError('Health response exceeded its size limit.');chunks.push(next.value)}return Buffer.concat(chunks).toString('utf8')}finally{void reader.cancel().catch(()=>{});}
}
export function serviceProbe(store:Store,fetcher:typeof fetch=fetch):HealthProbe{return async(name,config,signal)=>{
 const c=config.connections[name];signal.throwIfAborted();
 if(name==='Toolbox'){
  const binary=process.env.SUPPORT_TOOLBOX_BINARY??'/usr/local/bin/toolbox';
  if(process.platform!=='linux'||!isAbsolute(binary)||!isAbsolute(c.path))return {ok:false,detail:'Set the Toolbox executable and configuration paths inside the Linux VM.'};
  await access(c.path,constants.R_OK);signal.throwIfAborted();
  await exec(binary,['--help'],{signal,timeout:healthTimeouts.Toolbox,killSignal:'SIGKILL',maxBuffer:65536,shell:false});
  return {ok:true,detail:'Local executable responds and its configuration is readable. Cluster connectivity is checked during investigations.'};
 }
 if(name==='Model'&&config.modelAuth==='claude_cli'){
  const status=await claudeCliStatus(c.path,undefined,signal);return {ok:status.connected,detail:status.connected?'Local Claude CLI responds and is signed in. No generation or remote model request performed.':'Local Claude CLI is not signed in with a subscription.'};
 }
 const base=serviceBase(c.endpoint),headers:Record<string,string>={Accept:'application/json'};
 const optionalToken=()=>store.vaultStatus().credentials.includes(name)?store.readCredential(name):undefined;
 let path='',format:'json'|'text'='json',check:(v:any)=>boolean=()=>true,detail='';
 switch(name){
  case 'YouTrack':path='api/users/me?fields=id';headers.Authorization='Bearer '+store.readCredential(name);check=v=>typeof v.id==='string';detail='YouTrack API responds and accepts the saved token.';break;
  case 'GitLab':{const repo=config.repositories.find(r=>r.project);path=repo?'api/v4/projects/'+encodeURIComponent(repo.project!)+'/repository/branches/'+encodeURIComponent(repo.branch):'api/v4/projects?membership=true&simple=true&per_page=1';headers['PRIVATE-TOKEN']=store.readCredential(name);check=repo?v=>typeof v.commit?.id==='string':v=>Array.isArray(v);detail=repo?'GitLab responds and the configured repository branch is readable.':'GitLab project API responds and accepts the saved token.';break;}
  case 'Alertmanager':case 'Prometheus':path='-/ready';format='text';detail='Readiness endpoint reports ready.';{const token=optionalToken();if(token)headers.Authorization='Bearer '+token}break;
  case 'Outline':path='_health';format='text';check=v=>String(v).trim()==='OK';detail='Outline health endpoint responds.';{const token=optionalToken();if(token)headers.Authorization='Bearer '+token}break;
  case 'Slack':path=base.pathname.replace(/\/$/,'').endsWith('/api')?'api.test':'api/api.test';check=v=>v.ok===true;detail='Slack API responds. This checks availability, not channel permissions.';break;
  case 'Model':{
   if(config.modelAuth==='chatgpt'&&(config.modelProvider!=='openai'||c.endpoint!=='https://api.openai.com'))return {ok:false,detail:'Restore the OpenAI endpoint for ChatGPT sign-in.'};
   const token=await modelKey(store);signal.throwIfAborted();
   if(config.modelProvider==='openai')headers.Authorization='Bearer '+token;else {headers['x-api-key']=token;headers['anthropic-version']='2023-06-01'}
   path=config.modelAuth==='chatgpt'?'v1/models':'v1/models/'+encodeURIComponent(c.scope);
   check=config.modelAuth==='chatgpt'?v=>Array.isArray(v.models):v=>typeof v.id==='string';detail='Model catalog responds and accepts authentication. No tokens generated.';break;
  }
 }
 signal.throwIfAborted();const response=await fetcher(new URL(path,base),{method:'GET',headers,redirect:'manual',signal});
 if(!response.ok){void response.body?.cancel().catch(()=>{});return {ok:false,code:response.status,detail:response.status===401||response.status===403?'Authentication or access denied.':response.status===429?'Rate limited.':response.status>=300&&response.status<400?'Endpoint redirected; check its saved base URL.':`Endpoint returned HTTP ${response.status}.`};}
 const text=await readResponse(response,signal,name==='Model'?2_000_000:131072);let value:unknown;try{value=format==='json'?JSON.parse(text):text}catch{return {ok:false,code:response.status,detail:'Endpoint returned an unexpected response.'}}
 return {ok:check(value),code:response.status,detail:check(value)?detail:'Endpoint returned an unexpected health response.'};
};}
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
  try{result=await Promise.race([this.probe(name,config,controller.signal),aborted]);}catch(e){result={ok:false,detail:timeout?`Timed out after ${this.timeouts[name]/1000}s.`:e instanceof ProbeError?e.message:e instanceof AppError&&[400,401,403].includes(e.status)?'Check the saved endpoint, credentials and local tool configuration.':'Connection failed. Check the endpoint, VPN and TLS settings.'};}
  finally{clearTimeout(timer);this.active.delete(name)}
  if(this.stopped||!this.store.key||this.identity()!==context)return;
  const before=toolHealth(this.store,this.now()).find(t=>t.name===name)!;
  recordHealthProbe(this.store,name,result,Math.max(0,this.now()-start),this.now());
  const after=toolHealth(this.store,this.now()).find(t=>t.name===name)!;
  // Log state changes, not each healthy minute, to preserve the bounded diagnostic history.
  if(before.state!==after.state||before.label!==after.label)recordDiagnostic(this.store,{tool:logTools.includes(name as typeof logTools[number])?name as typeof logTools[number]:'App',operation:`${name} availability check`,status:result.ok?'ok':'error',durationMs:Math.max(0,this.now()-start),code:result.code,output:after.label+': '+result.detail});
 }
 stop(){this.stopped=true;for(const controller of this.active.values())controller.abort()}
}

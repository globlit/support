import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store.js';
import {agentFeed} from './agent-feed.js';
import {runSandboxCommand,agentHome} from './sandbox.js';
import {enabledContexts} from './kubernetes.js';
import {agentToolset,type AgentResult} from './agent-toolset.js';
import type {AgentGateway} from './agent-gateway.js';
import {sourceKind} from '../src/intake-model.js';
import type {YouTrack} from './youtrack.js';
import type {GitProxy} from './git-proxy.js';
import type {AnalysisRun,Config,SourceIssue} from '../src/model.js';

/** Working folder of a request: every run of the same ticket, alert or Slack thread uses it, so sessions can be resumed. */
export function workFolder(issue:Pick<SourceIssue,'connection'|'id'|'key'>){
 const name=`${sourceKind(issue.connection)}-${(issue.key||issue.id).replace(/[^A-Za-z0-9._-]/g,'-')}`.slice(0,120);
 return `${agentHome()}/work/${name}`;
}
export const pathEnv='/opt/support-agent/bin:/home/admin/.local/bin:/home/admin/go/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export type Ctx={
 store:Store;youtrack:YouTrack;fetcher:typeof fetch;gateway:AgentGateway;gitProxy?:GitProxy;
 run:AnalysisRun;issue:SourceIssue;config:Config;model:string;prompt:string;resume?:{sessionId:string;fork:boolean};
 signal:AbortSignal;redact:(v:string)=>string;
 onQuestion(q:{id:string;text:string}):void;
 /** Called once per run with an accepted result, before the session ends. */
 persist():void;
 /** Called when the provider reports a usage limit. */
 onLimit(resetAt?:string):void;
};

/** Quotes a value for bash. */
const quote=(value:string)=>`'${value.replace(/'/g,`'\\''`)}'`;
/**
 * Downloads the session kubeconfig from the agent gateway into the request's working folder, with a sandbox command.
 * Returns its path, or undefined when no Kubernetes context is enabled or the download fails. The kubeconfig contains
 * gateway URLs only: no token or certificate.
 */
export async function writeKubeconfig(ctx:Ctx,gatewayUrl:string){
 if(!enabledContexts(ctx.store,ctx.config).length)return undefined;
 const dir=`${workFolder(ctx.issue)}/.support`,file=`${dir}/kubeconfig`;
 const command=`mkdir -p ${quote(dir)} && curl -fsS --noproxy '*' -m 20 -o ${quote(file)} ${quote(gatewayUrl+'/kubeconfig')}`;
 try{
  const r=await runSandboxCommand({runId:ctx.run.id,command,timeoutSeconds:30,signal:ctx.signal,fetcher:ctx.fetcher});
  if(r.exitCode===0)return file;
  agentFeed.publish(ctx.run.id,'error',`Kubernetes access is unavailable in this session: the kubeconfig download failed. ${r.output.trim().slice(0,300)}`);
 }catch(e){agentFeed.publish(ctx.run.id,'error',`Kubernetes access is unavailable in this session: ${e instanceof AppError?e.message:'the kubeconfig download failed.'}`);}
 return undefined;
}

/** Shared state of a session: the accepted result and the number of successful checks. */
export type SessionState={accepted?:AgentResult;succeeded:number};
/**
 * Creates the tools of a run and registers them with the agent gateway. Returns the gateway session and the state that
 * its hooks update. A first submit_result gets a review reminder; the second is accepted.
 */
export async function openSession(ctx:Ctx){
 const {run,store,config}=ctx;
 const state:SessionState={succeeded:0};let reviewed=false;
 const toolset=await agentToolset(store,config,ctx.youtrack,ctx.fetcher,ctx.signal,{
  question:input=>{const q={id:randomUUID(),text:ctx.redact(input.text),at:new Date().toISOString(),...(input.options?.length?{options:input.options.map(ctx.redact)}:{})};run.questions=[...(run.questions??[]),q];ctx.persist();agentFeed.publish(run.id,'question',q.text,q.id);ctx.onQuestion(q);agentFeed.setQuestions(run.id,run.questions.filter(x=>!x.answer).length);},
  proposal:p=>{run.proposals=[...(run.proposals??[]).filter(x=>x.project!==p.project),p];ctx.persist();agentFeed.publish(run.id,'result',`Proposal "${p.title}": ${p.files.map(f=>f.path).join(', ')}`);},
  result:r=>{
   if(!reviewed){reviewed=true;return 'Before this is final, check: Is every hypothesis you relied on verified by a command or tool result? Did you search each keyword of the request, and its variants, in the cluster, the repositories, Outline and the web? Did a failed tool leave a gap that another tool or a script could fill? If something is left, do it now. Then call submit_result again, with the same or an updated report.';}
   state.accepted={...r,report:ctx.redact(r.report),questions:r.questions.map(q=>({text:ctx.redact(q.text),...(q.options?.length?{options:q.options.map(ctx.redact)}:{})})),replyDraft:r.replyDraft?ctx.redact(r.replyDraft):undefined};
   agentFeed.publish(run.id,'result',`Result: ${r.outcome}`);
   return 'Recorded for the engineer. End your turn now with a one-line summary.';
  },
  cloneUrl:ctx.gitProxy?.listening?(()=>{const t=ctx.gitProxy!.register();ctx.signal.addEventListener('abort',()=>ctx.gitProxy!.release(t),{once:true});return (p:string)=>ctx.gitProxy!.url(t,p);})():undefined,
 });
 const gw=ctx.gateway.register({runId:run.id,toolset,onLimit:ctx.onLimit,onTool:(name,input,r)=>{if(r.ok)state.succeeded++;agentFeed.publish(run.id,r.ok?'tool':'error',`${name}${r.ok?'':' failed'}: ${ctx.redact(JSON.stringify(input)??'').slice(0,300)}`);}});
 return {gw,state,toolset};
}

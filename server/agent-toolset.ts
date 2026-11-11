import {z} from 'zod';
import {AppError,type Store} from './store.js';
import {readTools,toolDefinition,type ToolDefinition} from './agent-tools.js';
import {readToolbox,readToolboxLogs,startPortForward,toolboxContexts,toolboxFiles,readableResources,toolboxKubectl} from './toolbox.js';
import {PrometheusSources,prometheusEndpoints} from './prometheus-sources.js';
import {OutlineReader,outlineAvailable} from './outline.js';
import {boundedJSON,serviceBase,projectPath} from './gitlab.js';
import {proposeFromFolder} from './repo-tools.js';
import type {YouTrack} from './youtrack.js';
import type {Config,ChangeProposal} from '../src/model.js';

export const outcomes=['diagnosis','plan','needs_input','inconclusive'] as const;
export type Outcome=typeof outcomes[number];
export type AgentResult={outcome:Outcome;report:string;questions:string[];replyDraft?:string};
const str={type:'string'};

/**
 * Callbacks of the run that owns a toolset. `result` receives the agent's final report and returns the text sent
 * back to the agent: a review reminder the first time, a confirmation afterwards.
 */
export type ToolsetHooks={
 question(text:string):void;
 proposal(p:ChangeProposal):void;
 result(r:AgentResult):string;
 cloneUrl?(project:string):string;
};

/**
 * Support tools offered to an agent session: Kubernetes through Toolbox, Prometheus and Grafana, Outline, GitLab,
 * YouTrack, Alertmanager, and the workflow tools ask_engineer, propose_change and submit_result. A tool is listed
 * only when its connection is enabled. Every request uses credentials from the Vault; none are returned.
 */
export async function agentToolset(store:Store,config:Config,youtrack:YouTrack,fetcher:typeof fetch,signal:AbortSignal,hooks:ToolsetHooks){
 const definitions:ToolDefinition[]=[];const handlers=new Map<string,(input:unknown)=>Promise<unknown>>();
 const add=(d:ToolDefinition,h:(input:unknown)=>Promise<unknown>)=>{definitions.push(d);handlers.set(d.name,h);};
 const files=toolboxFiles(store);
 const contexts=config.connections.Toolbox.enabled&&(files||config.connections.Toolbox.path)?toolboxContexts(config,files):[];
 if(contexts.length){
  add(toolDefinition('toolbox_get','Read Kubernetes resources through Toolbox, sanitized. Give a resource from the catalog, an optional name and label selector. The kubectl command in Bash offers the same reads.',{context:{type:'string',enum:contexts},resource:{type:'string',enum:readableResources(config)},namespace:str,name:str,selector:str},['context','resource']),input=>readToolbox(config,input,signal,toolboxFiles(store)));
  add(toolDefinition('toolbox_logs','Read the logs of one pod through Toolbox, sanitized. tail defaults to 200 lines (at most 2,000). since is a duration such as 15m.',{context:{type:'string',enum:contexts},namespace:str,pod:str,container:str,previous:{type:'boolean'},tail:{type:'integer',minimum:1,maximum:2000},since:str},['context','namespace','pod']),input=>readToolboxLogs(config,input,signal,toolboxFiles(store)));
  if(config.toolbox.allowPortForward)add(toolDefinition('toolbox_port_forward','Open a temporary Toolbox tunnel to a pod, service, deployment or StatefulSet. The result lists addresses reachable from Bash, for example curl http://ADDRESS/metrics. Send only read requests through tunnels.',{context:{type:'string',enum:contexts},namespace:str,target:str,ports:{type:'array',items:str,minItems:1,maxItems:8},durationSeconds:{type:'integer',minimum:1,maximum:config.toolbox.portForwardMaxSeconds}}),input=>startPortForward(config,input,toolboxFiles(store)));
 }
 const prom=await PrometheusSources.create(store,config,fetcher,signal);
 if(prom.names().length){
  const source={type:'string',enum:prom.names()};
  add(toolDefinition('prometheus_sources','List the Prometheus sources: servers reached by URL or through Kubernetes, and Grafana datasources.',{},[]),async()=>prom.describe());
  add(toolDefinition('prometheus_query','Run an instant PromQL query on one Prometheus source.',{source,query:str,time:str},['query']),input=>prom.query(input,signal));
  add(toolDefinition('prometheus_query_range','Run a PromQL range query. start and end are RFC 3339 or Unix seconds; step is a duration such as 60s.',{source,query:str,start:str,end:str,step:str},['query','start','end','step']),input=>prom.queryRange(input,signal));
  add(toolDefinition('prometheus_api','Read a Prometheus API endpoint: targets (scrape health and errors), rules, alerts, labels, label_values (params.label), series (params["match[]"]), metadata, status pages.',{source,endpoint:{type:'string',enum:[...prometheusEndpoints]},params:{type:'object'}},['endpoint']),input=>prom.api(input,signal));
 }
 const grafana=prom.grafanaClient();
 if(grafana){
  add(toolDefinition('grafana_dashboards','Search Grafana dashboards by title.',{query:str}),input=>grafana.searchDashboards(input,signal));
  add(toolDefinition('grafana_dashboard','Read one Grafana dashboard by UID: variables and the queries of each panel.',{uid:str}),input=>grafana.dashboard(input,signal));
 }
 if(outlineAvailable(store,config)){
  const outline=new OutlineReader(store,config,fetcher);
  add(toolDefinition('outline_collections','List the Outline collections that can be searched.',{},[]),()=>outline.collections());
  add(toolDefinition('outline_search','Search Outline documents. When nothing matches, other wordings are tried and listed in queriesTried. Optional collection name or ID.',{query:str,collection:str},['query']),input=>outline.search(input));
  add(toolDefinition('outline_read','Read one Outline document as Markdown, by the ID that outline_search returned.',{id:str}),input=>outline.read(input));
 }
 const reads=readTools(store,config,youtrack,fetcher);
 for(const d of reads.definitions)add(d,input=>reads.run(d.name,input));
 const gitlab=config.connections.GitLab;
 if(gitlab.enabled&&gitlab.endpoint){
  add(toolDefinition('gitlab_pipelines','Read the latest ten pipelines of a GitLab project.',{project:str}),async input=>{const {project}=z.object({project:projectPath}).strict().parse(input);const u=new URL('api/v4/projects/'+encodeURIComponent(project)+'/pipelines',serviceBase(gitlab.endpoint));u.searchParams.set('per_page','10');return boundedJSON(fetcher,u,{'PRIVATE-TOKEN':store.readCredential('GitLab')});});
  if(hooks.cloneUrl)add(toolDefinition('gitlab_clone_url','Return a URL to git clone or fetch a GitLab project with its history, without credentials. Valid during this session. Pushing is refused.',{project:str}),async input=>{const {project}=z.object({project:projectPath}).strict().parse(input);return {url:hooks.cloneUrl!(project)};});
  add(toolDefinition('propose_change','Submit edits made in a Git folder as a code change proposal for the engineer. dir is the absolute path of the folder; base is the commit SHA the edits started from, which must exist on GitLab. A branch and merge request are created only after the engineer approves.',{project:str,dir:str,base:str,title:str,summary:str}),async input=>{const p=await proposeFromFolder(store,input,fetcher);hooks.proposal(p);return {proposal:p.id,files:p.files.map(f=>({path:f.path,change:f.before===null?'added':f.after===null?'deleted':'modified'})),note:'Saved for engineer review. Nothing was written to GitLab.'};});
 }
 add(toolDefinition('ask_engineer','Ask the engineer a question. Does not wait: continue working. The answer arrives as a user message.',{question:str}),async input=>{const {question}=z.object({question:z.string().trim().min(3).max(2000)}).strict().parse(input);hooks.question(question);return {sent:true};});
 add(toolDefinition('submit_result','Report the result of this session to the engineer. outcome: diagnosis (cause found), plan (a change to make), needs_input (questions block progress), or inconclusive. report: Markdown in your own structure, with what you checked and found. questions: what the engineer must answer. replyDraft: optional answer to the requester.',{outcome:{type:'string',enum:[...outcomes]},report:str,questions:{type:'array',items:str,maxItems:20},replyDraft:str},['outcome','report']),async input=>{
  const r=z.object({outcome:z.enum(outcomes),report:z.string().trim().min(1).max(60000),questions:z.array(z.string().trim().min(1).max(2000)).max(20).optional(),replyDraft:z.string().max(16000).optional()}).strict().parse(input);
  if(r.outcome==='needs_input'&&!r.questions?.length)throw new AppError(400,'needs_input requires at least one question.');
  return {message:hooks.result({outcome:r.outcome,report:r.report,questions:r.questions??[],replyDraft:r.replyDraft})};
 });
 return {
  definitions,
  async run(name:string,input:unknown){const h=handlers.get(name);if(!h)throw new AppError(404,`Tool ${name} is not available in this session.`);return h(input);},
  kubectl:(args:unknown)=>toolboxKubectl(config,args,signal,toolboxFiles(store)),
  close(){prom.close();},
 };
}
export type AgentToolset=Awaited<ReturnType<typeof agentToolset>>;

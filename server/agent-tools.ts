import {z} from 'zod';
import {AppError,type Store} from './store.js';
import {boundedJSON,serviceBase,gitLabProjects,GitLab} from './gitlab.js';
import {serviceAuthHeaders} from './service-auth.js';
import type {YouTrack} from './youtrack.js';
import type {Config} from '../src/model.js';

export type ToolDefinition={name:string;description:string;input_schema:{type:'object';properties:Record<string,unknown>;required:string[];additionalProperties:false}};
export const toolDefinition=(name:string,description:string,properties:Record<string,unknown>,required:string[]=Object.keys(properties)):ToolDefinition=>({name,description,input_schema:{type:'object',properties,required,additionalProperties:false}});
const str={type:'string'},textLimit=20000;
const project=z.string().min(3).max(300).regex(/^[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)+$/).refine(p=>!p.split('/').some(s=>s==='.'||s==='..'),'Invalid GitLab project.');
const ref=z.string().min(1).max(255).regex(/^[A-Za-z0-9._\/-]+$/).optional();
const repoPath=z.string().max(1000).regex(/^[^\0]*$/).refine(p=>!p.split('/').includes('..'),'Invalid path.');
const tail=(text:string)=>text.length>textLimit?{text:text.slice(-textLimit),truncated:true}:{text,truncated:false};

/**
 * Read-only agent tools for GitLab, YouTrack and Alertmanager. Each tool is offered only when its
 * connection is enabled with a service URL. Every request uses the credential saved in the Vault.
 */
export function readTools(store:Store,config:Config,youtrack:YouTrack,fetcher:typeof fetch){
 const c=config.connections,definitions:ToolDefinition[]=[];
 const handlers=new Map<string,(input:unknown)=>Promise<unknown>>();
 const add=(definition:ToolDefinition,handler:(input:unknown)=>Promise<unknown>)=>{definitions.push(definition);handlers.set(definition.name,handler);};
 if(c.GitLab.enabled&&c.GitLab.endpoint){
  const base=serviceBase(c.GitLab.endpoint),get=(path:string,params:Record<string,string>={})=>{const u=new URL('api/v4/'+path,base);for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);return boundedJSON(fetcher,u,{'PRIVATE-TOKEN':store.readCredential('GitLab')});};
  const p=(name:string)=>'projects/'+encodeURIComponent(name);
  add(toolDefinition('gitlab_projects','List GitLab projects the token can access, most recently active first. Optional search on name and path.',{search:str},[]),async input=>{const {search}=z.object({search:z.string().max(100).optional()}).strict().parse(input);return gitLabProjects(store,fetcher,search??'');});
  add(toolDefinition('gitlab_tree','List files and folders of a GitLab repository folder. Default: repository root on the default branch.',{project:str,path:str,ref:str},['project']),async input=>{const i=z.object({project,path:repoPath.optional(),ref}).strict().parse(input);const items=await get(p(i.project)+'/repository/tree',{per_page:'100',...(i.path?{path:i.path}:{}),...(i.ref?{ref:i.ref}:{})});return z.array(z.object({name:z.string(),type:z.string(),path:z.string()})).parse(items);});
  add(toolDefinition('gitlab_file','Read one file of a GitLab repository. Default: the default branch. Returns at most 20,000 characters.',{project:str,path:str,ref:str},['project','path']),async input=>{const i=z.object({project,path:repoPath.min(1),ref}).strict().parse(input);const file=z.object({file_path:z.string(),content:z.string(),encoding:z.string(),ref:z.string().optional(),last_commit_id:z.string().optional()}).parse(await get(p(i.project)+'/repository/files/'+encodeURIComponent(i.path),{ref:i.ref??'HEAD'}));const text=file.encoding==='base64'?Buffer.from(file.content,'base64').toString('utf8'):file.content;return {path:file.file_path,ref:file.ref,commit:file.last_commit_id,...tail(text)};});
  add(toolDefinition('gitlab_search','Search code in one GitLab project on its default branch. Returns at most 20 matches with their lines.',{project:str,query:str}),async input=>{const i=z.object({project,query:z.string().min(1).max(200)}).strict().parse(input);const hits=z.array(z.object({path:z.string(),startline:z.number().optional(),data:z.string().optional()})).parse(await get(p(i.project)+'/search',{scope:'blobs',search:i.query,per_page:'20'}));return hits.map(h=>({path:h.path,line:h.startline,excerpt:h.data?.slice(0,800)}));});
  add(toolDefinition('gitlab_job_log','Read the log of one CI job. Returns the last 20,000 characters.',{project:str,jobId:{type:'integer'}}),async input=>{const i=z.object({project,jobId:z.number().int().positive()}).strict().parse(input);return tail(await new GitLab(store,i.project,fetcher).trace(i.jobId));});
 }
 if(c.YouTrack.enabled&&c.YouTrack.endpoint){
  add(toolDefinition('youtrack_search','Search YouTrack tickets with YouTrack query syntax, for example "project: INFRA ingress #Unresolved". Returns at most 20 tickets.',{query:str}),async input=>{const {query}=z.object({query:z.string().min(1).max(500)}).strict().parse(input);return youtrack.search(query);});
  add(toolDefinition('youtrack_issue','Read one YouTrack ticket with its description and comments, by its ID such as INFRA-123.',{id:str}),async input=>{const {id}=z.object({id:z.string().regex(/^[A-Za-z0-9_]+-\d+$/)}).strict().parse(input);const issue=await youtrack.issue(id);return issue;});
 }
 if(c.Alertmanager.enabled&&c.Alertmanager.endpoint){
  add(toolDefinition('alertmanager_alerts','Read active Alertmanager alerts. Optional matchers in Alertmanager syntax, for example severity="critical". Returns at most 100 alerts.',{filter:{type:'array',items:str,maxItems:10}},[]),async input=>{const {filter}=z.object({filter:z.array(z.string().min(1).max(300)).max(10).optional()}).strict().parse(input);const u=new URL('api/v2/alerts',serviceBase(c.Alertmanager.endpoint));u.searchParams.set('active','true');u.searchParams.set('silenced','false');u.searchParams.set('inhibited','false');for(const f of filter??[])u.searchParams.append('filter',f);const alerts=z.array(z.object({labels:z.record(z.string(),z.string()),annotations:z.record(z.string(),z.string()).optional(),startsAt:z.string().optional(),status:z.object({state:z.string()}).optional()})).parse(await boundedJSON(fetcher,u,serviceAuthHeaders(store,'Alertmanager')));return {count:alerts.length,alerts:alerts.slice(0,100).map(a=>({labels:a.labels,summary:a.annotations?.summary,description:a.annotations?.description?.slice(0,500),startsAt:a.startsAt,state:a.status?.state}))};});
 }
 return {definitions,async run(name:string,input:unknown){const handler=handlers.get(name);if(!handler)throw new AppError(403,'Tool is not available.');return handler(input);}};
}

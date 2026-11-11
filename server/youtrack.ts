import {humanAttribution} from './identity.js';
import {assertHandling} from './intake.js';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {boundedJSON} from './gitlab.js';
import type {ResolvedState,TicketField} from '../src/model.js';
import {AppError,Store} from './store.js';
import type {SourceIssue,PlanAnnotation} from '../src/model.js';
/** YouTrack project. YouTrack may omit `archived` for projects that are not archived; a missing value means false. */
export const projectSchema=z.object({id:z.string().min(1),name:z.string(),shortName:z.string(),archived:z.boolean().nullish().transform(v=>v===true)});
const alertIssueSchema=z.object({id:z.string().min(1),idReadable:z.string().min(1),description:z.string().nullable(),project:z.object({id:z.string().min(1)})});
const alertIssueFields='id,idReadable,description,project(id)';
const value=z.union([z.object({name:z.string().optional(),login:z.string().optional(),fullName:z.string().optional(),isResolved:z.boolean().optional()}).passthrough(),z.array(z.object({name:z.string().optional(),login:z.string().optional(),fullName:z.string().optional()}).passthrough()),z.string(),z.number(),z.null()]);
const issueSchema=z.object({commentsCount:z.number().optional(),comments:z.array(z.object({id:z.string(),text:z.string().nullable(),created:z.number().optional(),updated:z.number().nullable().optional(),deleted:z.boolean().optional()})).optional(),id:z.string(),idReadable:z.string(),summary:z.string().nullable(),description:z.string().nullable().optional(),updated:z.number(),resolved:z.number().nullable().optional(),project:z.object({name:z.string(),shortName:z.string()}).nullable().optional(),customFields:z.array(z.object({name:z.string(),value:value.optional()})).optional()});
/** Fields of the ticket list shown in the UI: no description or comments, which only the ticket view needs. */
const listFields='id,idReadable,summary,updated,resolved,project(name,shortName),customFields(name,value(name,login,fullName,isResolved))';
const fields='commentsCount,comments(id,text,created,updated,deleted),id,idReadable,summary,description,updated,resolved,project(name,shortName),customFields(name,value(name,login,fullName,isResolved))';
function display(v:unknown):string{if(v==null)return '';if(Array.isArray(v))return v.map(display).join(', ');if(typeof v==='object'){const o=v as Record<string,unknown>;return String(o.fullName??o.name??o.login??'')}return String(v)}
/** YouTrack refused a creation request (4xx). Nothing was created. */
export class TicketRejected extends AppError{constructor(reason:string){super(409,`YouTrack refused the ticket: ${reason}. Nothing was created.`);}}
/** Issue field type to send for each project field type. */
const issueFieldTypes:Record<string,[single:string,multi?:string]>={EnumProjectCustomField:['SingleEnumIssueCustomField','MultiEnumIssueCustomField'],StateProjectCustomField:['StateIssueCustomField'],OwnedProjectCustomField:['SingleOwnedIssueCustomField','MultiOwnedIssueCustomField'],VersionProjectCustomField:['SingleVersionIssueCustomField','MultiVersionIssueCustomField'],BuildProjectCustomField:['SingleBuildIssueCustomField','MultiBuildIssueCustomField'],UserProjectCustomField:['SingleUserIssueCustomField','MultiUserIssueCustomField']};
export class YouTrack{
 constructor(private store:Store,private fetcher:typeof fetch=fetch){}
 context(){const config=this.store.snapshot().config.connections.YouTrack;if(!config.enabled||!config.endpoint||!config.scope.trim())throw new AppError(400,'Configure and enable YouTrack with an instance URL and a search query first.');const base=new URL(config.endpoint.replace(/\/+$/,'' )+'/');if(base.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw new AppError(400,'Use HTTPS for YouTrack. HTTP is allowed only on loopback.');if(/\/(api|mcp)\/?$/.test(base.pathname))throw new AppError(400,'Use the YouTrack instance URL, not its /api or /mcp endpoint.');const token=this.store.readCredential('YouTrack');return {base,token,query:config.scope,revision:this.store.get<number>('configRevision'),epoch:this.store.credentialEpoch,connection:createHash('sha256').update(base.href).digest('hex')};}
 async request(path:string,params:Record<string,string>,ctx:ReturnType<YouTrack['context']>){const url=new URL(path,ctx.base);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);let response:Response;try{response=await this.fetcher(url,{method:'GET',redirect:'manual',headers:{Authorization:`Bearer ${ctx.token}`,Accept:'application/json'},signal:AbortSignal.timeout(15000)});}catch{throw new AppError(502,'YouTrack could not be reached. Check its URL, VPN and TLS trust.');}if(response.status!==200){await response.body?.cancel();throw new AppError(response.status===401||response.status===403?403:502,({401:'YouTrack rejected the token.',403:'The token cannot read this YouTrack resource.',404:'The issue or API path is unavailable.',429:'YouTrack rate limit reached. Try again later.'} as Record<number,string>)[response.status]??'YouTrack returned an unexpected response. Redirects are not followed.');}let size=0;const chunks:Uint8Array[]=[];try{if(!response.body)throw new Error();for await(const c of response.body as unknown as AsyncIterable<Uint8Array>){size+=c.length;if(size>4_000_000)throw new AppError(502,'YouTrack response exceeds the 4 MB limit. Narrow the query.');chunks.push(c);}const result=JSON.parse(Buffer.concat(chunks).toString());this.assertContext(ctx);return result;}catch(e){if(e instanceof AppError)throw e;throw new AppError(502,'YouTrack returned invalid data.');}}
 assertContext(c:ReturnType<YouTrack['context']>){if(!this.store.key||this.store.credentialEpoch!==c.epoch||this.store.get('configRevision')!==c.revision)throw new AppError(409,'Connection or vault changed during the read. Refresh and try again.');}
 normalize(raw:unknown,ctx:ReturnType<YouTrack['context']>):SourceIssue{
  const parsed=issueSchema.safeParse(raw);if(!parsed.success)throw new AppError(502,'YouTrack issue format was not recognized.');
  const i=parsed.data,f=Object.fromEntries((i.customFields??[]).map(f=>[f.name,display(f.value)]));
  const comments=(i.comments??[]).filter(c=>!c.deleted).map(c=>({id:c.id,text:c.text??'',updated:c.updated??c.created??0}));
  // Compare content in canonical order, not the issue timestamp.
  const sourceFingerprint=createHash('sha256').update(JSON.stringify({title:i.summary??'',description:i.description??'',updated:i.updated,resolved:i.resolved??null,project:i.project??null,fields:Object.entries(f).sort(([a],[b])=>a.localeCompare(b)),comments:[...comments].sort((a,b)=>a.id.localeCompare(b.id))})).digest('hex');
  return {comments,sourceFingerprint,id:i.id,key:i.idReadable,title:i.summary??'(Untitled issue)',description:i.description??'',updated:i.updated,resolved:i.resolved!=null,status:f.State??f.Status??(i.resolved!=null?'Resolved':'Unresolved'),severity:f.Criticality??f.Severity??f.Priority??'Unspecified',assignee:f.Assignee??'Unassigned',project:i.project?.name??'',fields:f,url:new URL('issue/'+encodeURIComponent(i.idReadable),ctx.base).href,connection:ctx.connection};
 }
 async projects(){const ctx=this.context(),result:z.infer<typeof projectSchema>[]=[];for(let skip=0;skip<1000;skip+=100){const page=z.array(projectSchema).parse(await this.request('api/admin/projects',{fields:'id,name,shortName,archived',$top:'100',$skip:String(skip)},ctx));result.push(...page);if(page.length<100)return result.filter(p=>!p.archived);}throw new AppError(409,'Project list exceeds 1000 entries. Narrow access before selecting a project.');}
 async alertProject(id:string,ctx:ReturnType<YouTrack['context']>){return projectSchema.parse(await this.request('api/admin/projects/'+encodeURIComponent(id),{fields:'id,name,shortName,archived'},ctx));}
 async findAlertTickets(marker:string,ctx:ReturnType<YouTrack['context']>){
  if(!/^supportalert[a-f0-9]{64}$/.test(marker))throw new AppError(400,'Invalid case reference.');
  const found:z.infer<typeof alertIssueSchema>[]=[];
  for(let skip=0;skip<1000;skip+=100){
   const page=z.array(alertIssueSchema).parse(await this.request('api/issues',{fields:alertIssueFields,query:'description: "'+marker+'"',$top:'100',$skip:String(skip)},ctx));
   for(const issue of page)if(issue.description?.split('\n').some(line=>line.trim()==='Support alert case: '+marker)&&!found.some(i=>i.id===issue.id))found.push(issue);
   if(page.length<100)return found;
  }
  throw new AppError(409,'Case reference search is incomplete. No ticket was created.');
 }
 async alertTicket(id:string,ctx:ReturnType<YouTrack['context']>){return alertIssueSchema.parse(await this.request('api/issues/'+encodeURIComponent(id),{fields:alertIssueFields},ctx));}
 /**
  * Creates an issue. A 4xx answer means YouTrack created nothing: it throws TicketRejected with YouTrack's reason.
  * Other failures leave the outcome unknown and throw an AppError; the caller must check before any retry.
  */
 async createAlertTicket(payload:{project:{id:string};summary:string;description:string;customFields?:unknown[]},ctx:ReturnType<YouTrack['context']>){
  this.assertContext(ctx);const url=new URL('api/issues',ctx.base);url.searchParams.set('fields','id');
  let response:Response;
  try{response=await this.fetcher(url,{method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+ctx.token,Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(45000)});}
  catch{throw new AppError(502,'The connection to YouTrack was interrupted. Check whether the ticket exists before trying again.');}
  const chunks:Uint8Array[]=[];let size=0;
  if(response.body)for await(const c of response.body as unknown as AsyncIterable<Uint8Array>){size+=c.length;if(size>262144)break;chunks.push(c);}
  let value:Record<string,unknown>={};try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{value={};}
  if(response.status>=400&&response.status<500){
   const reason=[value.error_description??value.error_message??value.error,value.error_field?`(field: ${value.error_field})`:''].filter(v=>typeof v==='string'&&v).join(' ');
   let text=String(reason||`HTTP ${response.status}`).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300);for(const s of this.store.secretValues())if(s.length>=6)text=text.split(s).join('[redacted]');
   throw new TicketRejected(text);
  }
  if(!response.ok)throw new AppError(502,`YouTrack returned HTTP ${response.status}. Check whether the ticket exists before trying again.`);
  this.assertContext(ctx);
  return z.object({id:z.string().min(1)}).parse(value).id;
 }
 /**
  * Returns the custom fields of a project that cannot be empty, with their allowed values and YouTrack default values.
  * `issueType` is the type to send at creation; fields of other types are left to YouTrack.
  */
 async projectFields(projectId:string):Promise<TicketField[]>{
  const ctx=this.context();
  const raw=z.array(z.object({id:z.string().optional(),$type:z.string(),canBeEmpty:z.boolean().optional(),field:z.object({name:z.string(),fieldType:z.object({isMultiValue:z.boolean().optional()}).passthrough().nullish()}),defaultValues:z.array(z.object({name:z.string().optional(),login:z.string().optional()}).passthrough()).nullish(),bundle:z.object({values:z.array(z.object({name:z.string().optional(),login:z.string().optional(),archived:z.boolean().optional()}).passthrough()).nullish()}).passthrough().nullish()}).passthrough())
   .parse(await this.request('api/admin/projects/'+encodeURIComponent(projectId)+'/customFields',{fields:'id,$type,canBeEmpty,field(name,fieldType(isMultiValue)),defaultValues(name,login),bundle(values(name,login,archived))',$top:'200'},ctx));
  return raw.filter(f=>f.canBeEmpty===false).map(f=>{
   const multi=f.field.fieldType?.isMultiValue===true,types=issueFieldTypes[f.$type],issueType=types?(multi?types[1]:types[0]):undefined;
   const options=(f.bundle?.values??[]).filter(v=>!v.archived).map(v=>v.name??v.login??'').filter(Boolean);
   const defaults=(f.defaultValues??[]).map(v=>v.name??v.login??'').filter(Boolean);
   return {id:f.id,name:f.field.name,issueType,multi,options,value:defaults[0]??''};
  });
 }
 /** Projects of the connection, from a cache refreshed every 30 minutes or when `refresh` is set. */
 async cachedProjects(refresh=false){
  const ctx=this.context(),cached=this.store.get<{at:string;connection:string;projects:z.infer<typeof projectSchema>[]}>('youtrack.projects');
  if(!refresh&&cached&&cached.connection===ctx.connection&&Date.now()-Date.parse(cached.at)<30*60_000)return cached;
  const fresh={at:new Date().toISOString(),connection:ctx.connection,projects:await this.projects()};
  this.store.put('youtrack.projects',fresh);return fresh;
 }
 async resolvedStates(id:string):Promise<ResolvedState[]>{const ctx=this.context();const raw=await this.request('api/issues/'+encodeURIComponent(id)+'/customFields',{fields:'id,name,$type,value(id,name,isResolved),projectCustomField(bundle(values(id,name,isResolved)))',$top:'100'},ctx);const values=z.array(z.object({id:z.string(),name:z.string(),$type:z.string(),projectCustomField:z.object({bundle:z.object({values:z.array(z.object({id:z.string(),name:z.string(),isResolved:z.boolean().optional()}))}).nullable().optional()}).nullable().optional()})).parse(raw);if(values.length>=100)throw new AppError(409,'State field list is incomplete. Close the issue in YouTrack.');return values.filter(v=>v.$type==='StateIssueCustomField').flatMap(v=>(v.projectCustomField?.bundle?.values??[]).filter(s=>s.isResolved===true).map(s=>({fieldId:v.id,fieldName:v.name,valueId:s.id,valueName:s.name})));}
 async currentState(id:string,fieldId:string){const ctx=this.context();return z.object({id:z.string(),$type:z.string(),value:z.object({id:z.string(),isResolved:z.boolean()}).nullable()}).parse(await this.request('api/issues/'+encodeURIComponent(id)+'/customFields/'+encodeURIComponent(fieldId),{fields:'id,$type,value(id,isResolved)'},ctx));}
 async resolutionComments(id:string){const ctx=this.context();const found:{id:string;text:string|null;deleted:boolean}[]=[];for(let offset=0;offset<1000;offset+=100){const rows=z.array(z.object({id:z.string(),text:z.string().nullable(),deleted:z.boolean()})).parse(await this.request('api/issues/'+encodeURIComponent(id)+'/comments',{fields:'id,text,deleted',$top:'100',$skip:String(offset)},ctx));found.push(...rows);if(rows.length<100)return found;}throw new AppError(409,'Comment scan exceeded 1000 entries. Inspect YouTrack manually; no write was retried.');}
 private async resolutionWrite(id:string,suffix:string,payload:unknown,fields:string){const ctx=this.context();const url=new URL('api/issues/'+encodeURIComponent(id)+suffix,ctx.base);url.searchParams.set('fields',fields);const data=await boundedJSON(this.fetcher,url,{Authorization:'Bearer '+ctx.token},payload);this.assertContext(ctx);return data;}
 async postResolution(id:string,text:string){return this.resolutionWrite(id,'/comments',{text},'id,text,deleted');}
 async closeResolved(id:string,state:ResolvedState){return this.resolutionWrite(id,'',{customFields:[{id:state.fieldId,$type:'StateIssueCustomField',value:{id:state.valueId,$type:'StateBundleElement'}}]},'id,updated,resolved');}
 /**
  * Lists 50 tickets of the configured query from `offset`. With `light`, descriptions and comments are not requested and
  * `sourceFingerprint` is omitted, which makes the request much smaller.
  */
 async list(offset=0,light=false){const ctx=this.context();const data=await this.request('api/issues',{fields:light?listFields:fields,query:ctx.query,$top:'50',$skip:String(offset)},ctx);if(!Array.isArray(data))throw new AppError(502,'YouTrack returned an invalid issue list.');return {issues:data.map(i=>{const issue=this.normalize(i,ctx);if(light){delete issue.sourceFingerprint;delete issue.comments;}return issue;}),hasMore:data.length===50,offset,loadedAt:new Date().toISOString(),query:ctx.query};}
 /** Searches every ticket the token can read, not only the configured query. Returns at most 20 tickets without comments. */
 async search(query:string){const ctx=this.context();const data=z.array(z.object({idReadable:z.string(),summary:z.string(),updated:z.number().optional(),resolved:z.number().nullable().optional(),project:z.object({shortName:z.string().optional()}).nullable().optional()})).parse(await this.request('api/issues',{fields:'idReadable,summary,updated,resolved,project(shortName)',query,$top:'20'},ctx));return data.map(i=>({id:i.idReadable,summary:i.summary,resolved:!!i.resolved,updated:i.updated?new Date(i.updated).toISOString():undefined}));}
 async issue(id:string){const ctx=this.context();const data=issueSchema.parse(await this.request('api/issues/'+encodeURIComponent(id),{fields},ctx));if((data.commentsCount??0)>(data.comments?.length??0)){const comments:NonNullable<typeof data.comments>=[];for(let skip=0;skip<1000;skip+=100){const page=z.array(z.object({id:z.string(),text:z.string().nullable(),created:z.number().optional(),updated:z.number().nullable().optional(),deleted:z.boolean().optional()})).parse(await this.request('api/issues/'+encodeURIComponent(id)+'/comments',{fields:'id,text,created,updated,deleted',$top:'100',$skip:String(skip)},ctx));comments.push(...page);if(page.length<100)break;if(skip===900)throw new AppError(409,'More than 1000 comments. Narrow the investigation before proceeding.');}data.comments=comments;}return this.normalize(data,ctx);}
 async work(id:string){const issue=await this.issue(id);return {issue,session:this.store.workSession(issue)};}
 async action(id:string,input:{action:'note'|'draft'|'plan'|'approve'|'unapprove'|'revise'|'delete-note';revision:number;text?:string;sourceUpdated:number;annotation?:PlanAnnotation}){const issue=await this.issue(id);return localAction(this.store,issue,input);}
}

export function localAction(store:Store,issue:SourceIssue,input:{action:'note'|'draft'|'plan'|'approve'|'unapprove'|'revise'|'delete-note';revision:number;text?:string;sourceUpdated:number;annotation?:PlanAnnotation}){assertHandling(store,issue,input.action==='note'?['pending','ticket','investigate']:['investigate']);const session=store.workSession(issue);return store.transaction(()=>{if(session.revision!==input.revision||issue.updated!==input.sourceUpdated)throw new AppError(409,'The issue or work session changed. Refresh before acting.');const now=new Date().toISOString();if(['note','plan','revise'].includes(input.action)&&!input.text?.trim())throw new AppError(400,'Enter text first.');if(input.action==='note'){session.notes.push({id:randomUUID(),at:now,text:input.text!});session.approval=null;}if(input.action==='draft')session.draft=input.text??'';if(input.action==='plan'){delete session.sourceChangedAt;session.pendingRevision=false;session.plans.push({version:session.plans.length+1,text:input.text!,at:now});session.approval=null;}if(input.action==='revise'){session.pendingRevision=true;if(input.annotation&&!session.plans.some(p=>p.version===input.annotation!.version))throw new AppError(409,'The selected plan version no longer exists.');
 if(session.notes.filter(n=>n.text.startsWith('Revision requested: ')&&n.at>=(session.plans.at(-1)?.at??'')).length>=50)throw new AppError(409,'Send the queued comments for revision before adding more than 50.');
 session.notes.push({id:randomUUID(),at:now,text:'Revision requested: '+input.text,...(input.annotation?{annotation:input.annotation}:{})});session.approval=null;}if(input.action==='delete-note'){
 const index=session.notes.findIndex(n=>n.id===input.text&&n.text.startsWith('Revision requested: '));
 if(index<0)throw new AppError(404,'Plan comment not found. Refresh before deleting.');
 session.notes.splice(index,1);session.approval=null;
 const planAt=session.plans.at(-1)?.at??'';
 session.pendingRevision=session.notes.some(n=>n.text.startsWith('Revision requested: ')&&n.at>=planAt);
}if(input.action==='unapprove'){if(!session.approval)throw new AppError(409,'This plan is not approved.');const pending=store.changes(issue.connection,issue.id).find(c=>['branch_pending','mr_pending','generating'].includes(c.state));if(pending)throw new AppError(409,'A GitLab write for this plan is in progress or needs verification. Check it in the implementation step before cancelling the approval.');session.approval=null;}if(input.action==='approve'){if(session.pendingRevision)throw new AppError(409,'Save a revised plan before approving.');if(issue.resolved)throw new AppError(409,'This source is no longer active.');const plan=session.plans.at(-1);if(!plan)throw new AppError(409,'Save a plan first.');delete session.sourceChangedAt;session.approval={version:plan.version,sourceUpdated:issue.updated,configRevision:store.get<number>('configRevision')!,...humanAttribution(store),at:now};}session.revision++;session.updatedAt=now;store.saveWorkSession(session);return {issue,session};});}

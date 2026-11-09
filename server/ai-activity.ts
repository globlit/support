import {handling,isIgnored} from './intake.js';
import {sourceKind,handlingLabel} from '../src/intake-model.js';
import {decorateDispositions} from './ai-dispositions.js';
import {Store,AppError} from './store.js';
import {Claude} from './claude.js';
import type {AnalysisRun} from '../src/model.js';
import type {AIOverview,AIState,AIWorkflow,AIRunSummary} from '../src/ai-model.js';
export type SessionSummary={connection:string;issueId:string;sourceKey?:string;updatedAt:string;sourceChangedAt?:string;pendingRevision?:number;planVersion?:number;planAt?:string;approval?:string;noteAt?:string};
export type ChangeSummary={connection:string;issueId:string;state:string;message:string;updatedAt:string;planVersion:number;resolution?:string;resolutionMessage?:string;fix?:string;fixMessage?:string;trackingState?:string;pipeline?:string;trackingError?:string;checkedAt?:string};
export function activityBuckets(run:AnalysisRun,now=Date.now()){
 const start=Date.parse(run.startedAt),end=Math.max(start+1000,Date.parse(run.finishedAt??new Date(now).toISOString()));
 const counts=Array<number>(40).fill(0);
 for(const event of run.events){const at=Date.parse(event.at);if(Number.isFinite(at)&&at>=start&&at<=end)counts[Math.min(39,Math.floor((at-start)/(end-start)*40))]++;}
 return {start:new Date(start).toISOString(),end:new Date(end).toISOString(),counts};
}
export function summarizeRun(run:AnalysisRun,now=Date.now()):AIRunSummary{
 const checks=run.events.filter(e=>e.tool),last=checks.slice(-3);
 const repeating=last.length===3&&last.every(e=>e.tool===last[0].tool&&e.input===last[0].input)&&!!last[0].input;
 const updatedAt=run.finishedAt??run.events.at(-1)?.at??run.startedAt;
 return {activity:activityBuckets(run,now),id:run.id,connection:run.connection!,issueId:run.issueId,kind:run.kind??'investigation',state:run.state==='running'?'running':run.state==='failed'?'blocked':run.state==='cancelled'?'stopped':'completed',model:run.model,startedAt:run.startedAt,finishedAt:run.finishedAt,updatedAt,step:run.events.at(-1)?.text??(run.state==='running'?'Starting…':'Run finished'),error:run.error,checks:checks.length,repeating,quiet:run.state==='running'&&now-Date.parse(updatedAt)>60000};
}
export function workflowState(session:SessionSummary|undefined,change:ChangeSummary|undefined,run:AIRunSummary|undefined):Pick<AIWorkflow,'state'|'stage'|'reason'>{
 const state=(state:AIState,stage:string,reason:string)=>({state,stage,reason});
 if(run?.state==='running')return state('running',run.kind==='changes'?'Preparing changes':run.kind==='diagnosis'?'Pipeline diagnosis':'Investigation',run.step);
 if(session?.sourceChangedAt)return state('waiting','Request review','Review the latest ticket requirements before continuing.');
 const relevantChange=change&&(!session?.planVersion||change.planVersion===session.planVersion)?change:undefined;
 if(relevantChange?.resolution==='closed')return state('completed','Resolved','YouTrack confirmed the ticket was closed.');
 const workAt=[session?.planAt,session?.noteAt,relevantChange?.updatedAt].filter(Boolean).sort().at(-1)??'';
 if(run&&run.updatedAt>=workAt&&run.state==='blocked')return state('blocked',run.kind==='diagnosis'?'Pipeline diagnosis':run.kind==='changes'?'Change preparation':'Investigation',run.error??'Review the failed run before retrying.');
 if(run&&run.updatedAt>=workAt&&run.state==='stopped')return state('stopped','Investigation stopped','Start a new investigation when ready.');
 if(session?.pendingRevision)return state('waiting','Plan revision','Queued feedback is waiting to be sent for revision.');
 if(relevantChange){
  const c=relevantChange;
  if(['failed','changed','branch_pending','mr_pending'].includes(c.state))return state('blocked','Implementation',c.message||'Verify the last operation before continuing.');
  if(c.resolution==='reopened')return state('blocked','Ticket reopened',c.resolutionMessage??'Review the reopened ticket.');
  if(c.resolution==='posting'||c.resolution==='closing')return state('blocked','Confirm YouTrack action',c.resolutionMessage??'Confirm the remote result. No action is retried automatically.');
  if(c.resolution==='draft')return state('waiting','Summary approval','Review the resolution summary before posting it.');
  if(c.resolution==='posted')return state('waiting','Closure approval','The summary was posted. Review ticket closure.');
  if(c.fix==='proposed')return state('waiting','Fix approval','Review the proposed fix before pushing changes.');
  if(c.fix==='pushing'||c.fix==='changed')return state('blocked','Confirm fix',c.fixMessage??'Review the last fix operation.');
  if(c.fix==='diagnosed')return state('waiting','Diagnosis review','Review the diagnosis; no code fix was proposed.');
  if(c.state==='generating')return state('blocked','Interrupted preparation','No active run was found. Inspect the change preparation.');
  if(c.state==='review')return state('waiting','Diff approval','Review the branch diff and merge request message.');
  if(c.trackingError)return state('blocked','GitLab status unavailable',c.trackingError);
  if(c.pipeline==='manual')return state('waiting','Pipeline action','The last recorded pipeline is waiting for a manual action.');
  if(['canceled','skipped'].includes(c.pipeline??''))return state('blocked','Pipeline incomplete','Review the canceled or skipped pipeline before proceeding.');
  if(c.pipeline==='failed')return state('blocked','Pipeline failed','Diagnose the failed pipeline before proposing a fix.');
  if(['running','pending','created','preparing','waiting_for_resource','scheduled'].includes(c.pipeline??''))return state('waiting','Pipeline','Waiting for the last recorded pipeline to finish.');
  if(c.trackingState==='merged')return c.pipeline==='success'?state('waiting','Resolution summary','Prepare a resolution summary for engineer review.'):state('waiting','Merged pipeline','Check the pipeline for the merged commit.');
  if(c.trackingState==='closed')return state('stopped','Merge request closed','The merge request was closed without merging.');
  if(c.state==='created')return state('waiting','Merge request','Waiting for merge or the next GitLab status check.');
 }
 if(session?.approval)return state('waiting','Implementation','The plan is approved. Start preparing the scoped changes.');
 if(session?.planVersion)return state('waiting','Plan approval',`Review plan v${session.planVersion}.`);
 return state('waiting','Investigation','Start an investigation to prepare a plan.');
}
export function aiOverview(store:Store,claude:Claude,now=Date.now()):AIOverview{
 if(!store.key)throw new AppError(423,'Unlock the Vault to view AI activity.');
 store.pruneInvestigations();
 const historyLimit=200;
 const runs=(store.db.prepare('SELECT id FROM investigations ORDER BY started DESC LIMIT ?').all(historyLimit) as {id:string}[]).map(({id})=>summarizeRun(claude.status(id),now));
 const sessions=store.db.prepare(`SELECT connection,issue_id AS issueId,json_extract(value,'$.sourceKey') AS sourceKey,json_extract(value,'$.updatedAt') AS updatedAt,json_extract(value,'$.sourceChangedAt') AS sourceChangedAt,json_extract(value,'$.pendingRevision') AS pendingRevision,json_extract(value,'$.plans[#-1].version') AS planVersion,json_extract(value,'$.plans[#-1].at') AS planAt,json_extract(value,'$.approval.at') AS approval,json_extract(value,'$.notes[#-1].at') AS noteAt FROM work_sessions`).all() as SessionSummary[];
 // Load metadata only.
 const changes=store.db.prepare(`SELECT json_extract(value,'$.connection') AS connection,json_extract(value,'$.issueId') AS issueId,json_extract(value,'$.state') AS state,json_extract(value,'$.message') AS message,json_extract(value,'$.updatedAt') AS updatedAt,json_extract(value,'$.planVersion') AS planVersion,json_extract(value,'$.resolution.state') AS resolution,json_extract(value,'$.resolution.message') AS resolutionMessage,json_extract(value,'$.fixes[#-1].state') AS fix,json_extract(value,'$.fixes[#-1].message') AS fixMessage,json_extract(value,'$.tracking.state') AS trackingState,json_extract(value,'$.tracking.pipeline.status') AS pipeline,json_extract(value,'$.tracking.error') AS trackingError,json_extract(value,'$.tracking.checkedAt') AS checkedAt FROM changes ORDER BY updatedAt DESC`).all() as ChangeSummary[];
 const cases=store.db.prepare(`SELECT id,json_extract(value,'$.connection') AS connection,json_extract(value,'$.title') AS title,json_extract(value,'$.ticket') AS ticket,json_extract(value,'$.ticketCreation.state') AS ticketState,json_extract(value,'$.active') AS active FROM alert_cases`).all() as {id:string;connection:string;title:string;ticket?:string;ticketState?:string;active:number}[];
 const key=(connection:string,id:string)=>connection+':'+id;
 const grouped=new Map<string,{connection:string;issueId:string;session?:SessionSummary;change?:ChangeSummary;runs:AIRunSummary[]}>();
 const group=(connection:string,issueId:string)=>{const id=key(connection,issueId);if(!grouped.has(id))grouped.set(id,{connection,issueId,runs:[]});return grouped.get(id)!};
 for(const s of sessions)group(s.connection,s.issueId).session=s;
 for(const c of changes){const g=group(c.connection,c.issueId);g.change??=c;}
 for(const r of runs)group(r.connection,r.issueId).runs.push(r);
 const workflows=[...grouped.values()].map(g=>{
  const source=sourceKind(g.connection),alert=source==='alert'?cases.find(a=>a.id===g.issueId&&a.connection===g.connection):undefined;
  const run=g.runs.find(r=>r.state==='running')??g.runs[0];
  let status=workflowState(g.session,g.change,run);
  if(source==='alert'&&run?.state!=='running'&&!['blocked','stopped'].includes(status.state)){
   if(alert?.ticket)status={state:'waiting',stage:'Linked ticket',reason:'Continue the work in the linked YouTrack ticket.'};
   else if(alert?.ticketState==='draft')status={state:'waiting',stage:'Ticket approval',reason:'Review the proposed YouTrack ticket before creating it.'};
   else if(alert?.ticketState==='pending')status={state:'blocked',stage:'Confirm ticket creation',reason:'Verify the creation result before trying again.'};
   else if(alert&&!alert.active)status={state:'stopped',stage:'Alert not firing',reason:'No longer present in the last successful poll. Recovery is not yet verified.'};
  }
  const ownership=handling(store,{connection:g.connection,id:g.issueId});
  if(['human','refused','done'].includes(ownership.mode))status={state:ownership.mode==='done'?'completed':'stopped',stage:handlingLabel(ownership.mode),reason:ownership.reason||'Agent handling is paused until an engineer returns this request.'};
  else if(isIgnored(store,{connection:g.connection,id:g.issueId}))status={state:'stopped',stage:'Ignored',reason:'An active ignore rule prevents agent work.'};
  else if(ownership.mode==='pending'&&ownership.defaultIgnored)status={state:'stopped',stage:'Not handled',reason:'New alerts are ignored by default. Choose how to handle this alert to start work.'};
   else if(ownership.mode==='pending')status={state:'waiting',stage:'Intake decision',reason:'Create a ticket, investigate here, or ignore this request.'};
  else if(ownership.mode==='reply')status={state:'waiting',stage:'Direct reply',reason:'Prepare and approve an answer to the Slack thread.'};
  const reply=store.get<{state:string}>('incomingReply:'+g.connection+':'+g.issueId);
  if(!['human','refused','done'].includes(ownership.mode)&&!isIgnored(store,{connection:g.connection,id:g.issueId})&&reply)status=reply.state==='pending'?{state:'blocked',stage:'Confirm reply',reason:'Check the pending reply; no message is retried automatically.'}:reply.state==='sent'?{state:'completed',stage:source==='alert'?'Resolution recorded':'Reply sent',reason:'Approved response recorded. New work requires another review.'}:{state:'waiting',stage:'Reply approval',reason:'Review the exact response before sending.'};
  const slack=source==='slack'?store.get<import('./slack.js').SlackCase>('slack:'+g.issueId):undefined;
  if(slack?.ticket)status={state:'waiting',stage:'Linked ticket',reason:'Continue in the linked YouTrack ticket.'};
  return {id:key(g.connection,g.issueId),connection:g.connection,issueId:g.issueId,source,title:alert?.title??slack?.title??'YouTrack work session',key:source==='alert'?'ALERT-'+g.issueId.slice(0,8):source==='slack'?'SLACK-'+g.issueId.slice(0,8):g.session?.sourceKey??g.issueId,...status,updatedAt:[run?.updatedAt,g.session?.updatedAt,g.session?.sourceChangedAt,g.change?.updatedAt].filter(Boolean).sort().at(-1)??new Date(now).toISOString(),latestRun:run?.id,runCount:g.runs.length,repeating:run?.state==='running'&&run.repeating||false,quiet:run?.quiet??false,linkedTicket:alert?.ticket?JSON.parse(alert.ticket):slack?.ticket,pipelineCheckedAt:g.change?.checkedAt??undefined} satisfies AIWorkflow;
 });
 const order:Record<AIState,number>={running:0,blocked:1,waiting:2,stopped:3,completed:4};workflows.sort((a,b)=>order[a.state]-order[b.state]||b.updatedAt.localeCompare(a.updatedAt));
 const active=runs.find(r=>r.state==='running');
 return decorateDispositions(store,{workflows,runs,loadedAt:new Date(now).toISOString(),historyLimit,agent:{model:active?.model??store.snapshot().config.connections.Model.scope,active:!!active,step:active?.step??'No active run'}});
}

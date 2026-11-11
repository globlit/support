import type {AIWorkflow} from './ai-model';

export type BoardColumn='triage'|'working'|'you'|'others'|'done';
export type BoardTone='running'|'attention'|'failed'|'done'|'idle';
export const boardColumns:{id:BoardColumn;title:string;hint:string}[]=[
 {id:'triage',title:'To triage',hint:'No Support work yet.'},
 {id:'working',title:'Agent working',hint:'An agent run is in progress.'},
 {id:'you',title:'Needs you',hint:'A decision, a review or an answer is waiting for you.'},
 {id:'others',title:'Waiting on others',hint:'A merge request, a pipeline, a linked ticket or another engineer.'},
 {id:'done',title:'Done',hint:'Finished or quiet in the last 7 days.'},
];
export type BoardPlacement={column:BoardColumn;state:string;tone:BoardTone};
export type BoardCard=BoardPlacement&{id:string;key:string;title:string;severity:string;since:string;meta?:string};

/** Workflow stages that wait for something outside Support and the engineer's decision. */
const waitingOnOthers=new Set(['Pipeline','Merge request','Merged pipeline','Linked ticket']);
/** Texts shown for workflow stages, when the stage alone is not explicit enough. */
const stageText:Record<string,string>={
 'Plan approval':'Plan to review','Plan revision':'Revision requested','Request review':'Ticket changed · review the request','Diff approval':'Diff to review','Fix approval':'Fix to review',
 'Summary approval':'Summary to review','Closure approval':'Closure to review','Diagnosis review':'Diagnosis to review','Implementation':'Approved · prepare the changes','Resolution summary':'Merged · prepare the summary',
 'Pipeline action':'Pipeline waits for a manual action','Pipeline':'Pipeline running','Merge request':'Merge request open','Merged pipeline':'Merged · pipeline running','Investigation stopped':'Investigation stopped',
};

/**
 * Column, next-step text and tone of a request from its AI workflow. A request without a workflow is to triage. A
 * running run is agent work. Blocked requests and engineer decisions need the engineer; pipelines, merge requests and
 * linked tickets wait on others. A stopped investigation needs the engineer; other stopped or completed work is done.
 */
export function workflowPlacement(w:AIWorkflow|undefined):BoardPlacement{
 if(!w)return {column:'triage',state:'Not investigated',tone:'idle'};
 const text=stageText[w.stage]??w.stage;
 if(w.state==='running')return {column:'working',state:w.reason&&w.reason!=='Starting…'?`Running · ${w.reason}`:'Running',tone:'running'};
 if(w.state==='blocked')return {column:'you',state:text,tone:'failed'};
 if(w.state==='completed')return {column:'done',state:text,tone:'done'};
 if(w.state==='stopped')return w.stage==='Investigation stopped'?{column:'you',state:text,tone:'failed'}:w.stage==='Engineer handling'?{column:'others',state:text,tone:'idle'}:{column:'done',state:text,tone:'done'};
 if(w.linkedTicket)return {column:'others',state:`Continue in ${w.linkedTicket.key}`,tone:'idle'};
 if(waitingOnOthers.has(w.stage))return {column:'others',state:text,tone:'idle'};
 if(w.stage==='Investigation')return {column:'triage',state:'Not investigated',tone:'idle'};
 return {column:'you',state:text,tone:'attention'};
}

/** Column of an alert case from its detailed state (the labels of the alert list). */
export function alertPlacement(label:string,c:{ticket?:{key:string};session:{plans:{version:number}[];approval:null|{version:number}}}):BoardPlacement{
 if(c.ticket)return {column:'others',state:`Continue in ${c.ticket.key}`,tone:'idle'};
 const plan=c.session.plans.at(-1);
 switch(label){
  case 'Choose next step':return {column:'triage',state:'Choose how to handle it',tone:'idle'};
  case 'Backlog':return {column:'triage',state:'Not investigated',tone:'idle'};
  case 'Investigating':return {column:'working',state:'Running',tone:'running'};
  case 'Create a ticket':return {column:'you',state:'Ticket to create',tone:'attention'};
  case 'Review':return {column:'you',state:plan?`Plan v${plan.version} to review`:'Ticket draft to review',tone:'attention'};
  case 'Revision requested':return {column:'you',state:'Revision requested',tone:'attention'};
  case 'Approved':return {column:'you',state:`Plan v${c.session.approval?.version??plan?.version} approved · prepare the changes`,tone:'attention'};
  case 'Needs attention':return {column:'you',state:'Needs attention',tone:'failed'};
  case 'Engineer handling':return {column:'others',state:'Engineer handling',tone:'idle'};
  default:return {column:'done',state:label,tone:'done'};
 }
}

const severityRank=(s:string)=>{const v=s.toLowerCase();return /crit|block|show|urgent|p1|major/.test(v)?0:/high|error|warn|p2/.test(v)?1:/normal|medium|p3/.test(v)?2:3;};
/** Cards of a column, most severe first, then the longest waiting first. */
export function sortCards(cards:BoardCard[]){return [...cards].sort((a,b)=>severityRank(a.severity)-severityRank(b.severity)||a.since.localeCompare(b.since));}
/** Done cards of the last `days` days. */
export function recentDone(cards:BoardCard[],now=Date.now(),days=7){return cards.filter(c=>c.column!=='done'||now-Date.parse(c.since)<=days*86400000);}
/** Short age of a time: "5 min", "3 h", "2 d". */
export function age(at:string,now=Date.now()){const m=Math.max(0,Math.round((now-Date.parse(at))/60000));return m<60?`${m} min`:m<48*60?`${Math.round(m/60)} h`:`${Math.round(m/1440)} d`;}

import {sourceKind,handlingLabel} from './intake-model';
import {latestChange,replyStatus} from './reply-state';
import type {AnalysisRun,ChangeSet,LiveDetail} from './model';
import {ToolUsageChart} from './ToolUsageChart';
import {countTools} from './tool-usage';
export type ReviewStage='request'|'ticket'|'investigation'|'plan'|'implementation'|'message';
/**
 * Returns the step a ticket is at: the latest step with recorded work.
 * Alerts and Slack requests stay on the request step until a handling decision exists.
 * Pass the loaded change sets: without them, the result stops at the implementation step.
 */
export function currentStage(detail:LiveDetail,changes:ChangeSet[],running=false):ReviewStage{
 const s=detail.session,c=latestChange(changes),mode=s.handling?.mode;
 if(mode==='reply')return 'message';
 if(sourceKind(detail.issue.connection)!=='youtrack'){if(!mode||mode==='pending')return 'request';if(mode==='ticket')return 'ticket';}
 if(mode==='human'||mode==='refused')return 'request';
 if(s.replyState||c?.resolution||c?.tracking?.state==='merged')return 'message';
 if(c||s.approval)return 'implementation';
 if(s.plans.length)return 'plan';
 if(running||s.analysis||s.alertHandoffs?.some(h=>h.analysis))return 'investigation';
 return 'request';
}
export function IssueFlow({detail,changes,loaded,error,running,selected,onSelect,disabled,latestRun}:{latestRun?:AnalysisRun|null;detail:LiveDetail;changes:ChangeSet[];loaded:boolean;error:string;running:boolean;selected:ReviewStage;onSelect:(s:ReviewStage)=>void;disabled:boolean}){
 const s=detail.session,origin=s.origin,c=latestChange(changes),incoming='alert' in detail?(detail as import('./model').AlertDetail).alert:undefined;const ignored=!!incoming?.ignored&&(sourceKind(detail.issue.connection)==='slack'||incoming.ignored>=incoming.members.length);
 const tools=countTools(latestRun?.events??[]);
 const recorded=!!s.analysis||!!s.alertHandoffs?.some(h=>h.analysis);
 const items:{id:ReviewStage;title:string;status:string;at?:string}[]=[
 {id:'request',title:origin?`${origin.kind==='alert'?'Alert':'Slack'} → Ticket`:sourceKind(detail.issue.connection)==='alert'?'Alert received':sourceKind(detail.issue.connection)==='slack'?'Slack message':'YouTrack request',status:ignored?'Ignored':detail.session.handling&&detail.session.handling.mode!=='investigate'?handlingLabel(detail.session.handling.mode):detail.issue.status,at:new Date(detail.issue.updated).toISOString()},
 {id:'investigation',title:'Investigation',status:running||latestRun?.state==='running'?'Running':latestRun?.state==='failed'?'Failed · review run':latestRun?.state==='cancelled'?'Stopped':recorded?'Recorded activity':'Not started',at:latestRun?.startedAt??s.analysis?.events.at(-1)?.at},
 {id:'plan',title:'Plan',status:!s.plans.length?'Not prepared':s.sourceChangedAt?(sourceKind(detail.issue.connection)==='youtrack'?'Ticket changed · review':'Scope changed · review'):s.pendingRevision?'Revision requested':s.approval?'Approved':s.plans.length?'Your review':'Not prepared',at:s.plans.at(-1)?.at},
 {id:'implementation',title:'Implementation',status:!loaded?'Loading…':error?'Status unavailable':c?.tracking?.state==='merged'?'Merged':c?.mr?'MR & pipeline':c?.state==='review'?'Review diff':c?'Needs attention':s.approval?'Ready to prepare':'Not started',at:c?.updatedAt},
 {id:'message',title:sourceKind(detail.issue.connection)==='alert'?'Resolution':'Reply',status:s.replyState==='sent'?'Sent / recorded':s.replyState==='pending'?'Check sending':s.replyState==='draft'?'Your review':s.handling?.mode==='reply'?'Draft an answer':!loaded?'Loading…':error?'Status unavailable':replyStatus(c),at:c?.resolution?.postApproval?.at},
 ];
 if(sourceKind(detail.issue.connection)!=='youtrack'&&s.handling?.mode==='ticket')items.splice(1,0,{id:'ticket',title:'YouTrack ticket',status:'alert' in detail&&(detail as import('./model').AlertDetail).alert.ticket?'Created · continue in ticket':'Review creation'});
 if(s.handling?.mode==='reply')items.splice(1,items.length-2);
 return <nav className="case-timeline" aria-label="Work timeline"><p className="timeline-label">WORK TIMELINE</p><ol>{items.map(item=><li key={item.id} className={selected===item.id?'selected':''}><button disabled={disabled&&selected!==item.id} aria-current={selected===item.id?'step':undefined} onClick={()=>onSelect(item.id)}><span className={'case-dot'+(running&&item.id==='investigation'?' live':'')}/><span><strong>{item.title}</strong><small>{item.status}</small>{item.at&&<time dateTime={item.at}>{new Date(item.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>}</span></button></li>)}</ol>{tools.length>0&&<details className="timeline-tools"><summary>Tool usage</summary><ToolUsageChart compact counts={tools} title="Investigation"/></details>}</nav>;
}

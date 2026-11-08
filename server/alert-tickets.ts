import {humanAttribution} from './identity.js';
import {assertHandling,handling} from './intake.js';
import type {AlertCase} from '../src/model.js';
import {markdownText} from './markdown.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Store,AppError} from './store.js';
import {Alertmanager} from './alertmanager.js';
import {YouTrack} from './youtrack.js';
import type {AlertTicketDraft} from '../src/model.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const alertDraftInput=z.object({projectId:z.string().min(1).max(100),title:z.string().trim().min(1).max(250),description:z.string().trim().min(1).max(48000),hash:z.string().length(64)}).strict();
type Context=ReturnType<YouTrack['context']>;
export class AlertTickets {
 constructor(private store:Store,private alerts:Pick<Alertmanager,'work'|'issue'>,private youtrack:YouTrack,private cases?:{getCase:(id:string)=>AlertCase;saveCase:(c:AlertCase)=>void}){}
 private case(id:string){return this.cases?this.cases.getCase(id):this.store.alert(id)}
 private saveCase(c:AlertCase){if(this.cases)this.cases.saveCase(c);else this.store.saveAlert(c)}
 private editable(id:string){const c=this.case(id);assertHandling(this.store,{connection:c.connection,id},['pending','ticket','investigate']);if(c.ticket)throw new AppError(409,'This case already has a YouTrack ticket.');if(c.ticketCreation&&c.ticketCreation.state!=='draft')throw new AppError(409,'Check the pending creation. No new request will be sent.');return c;}
 private text(d:AlertTicketDraft){return d.description+'\n\nSupport alert case: '+d.marker;}
 private digest(d:AlertTicketDraft){return hash({revision:d.revision,connection:d.connection,endpoint:d.endpoint,project:d.project,title:d.title,description:this.text(d),source:d.sourceUpdated,session:d.sessionRevision,config:d.configRevision});}
 private safeText(text:string){
  const tokens=this.store.secretValues();
  if(tokens.some(t=>t&&text.includes(t))||/-----BEGIN [^-]*PRIVATE KEY-----|\bclient-key-data\s*:|\b(password|token|api[_-]?key|authorization)\s*[:=]\s*["']?[^\s"'<>$\[]+/i.test(text))
   throw new AppError(400,'Possible plaintext credential found. Replace it with a placeholder before saving or posting.');
  if(text.includes('\0'))throw new AppError(400,'Ticket text must not contain null characters.');
 }
 private async project(id:string,ctx:Context){const p=await this.youtrack.alertProject(id,ctx);if(p.id!==id||p.archived)throw new AppError(409,'Select an available, non-archived project.');return p;}
 private async fresh(id:string){const detail=await this.alerts.work(id);if(!detail.alert.active)throw new AppError(409,'This alert is no longer firing. Review it before creating a ticket.');return detail;}
 private guard(id:string,d:AlertTicketDraft,ctx:Context){
  this.youtrack.assertContext(ctx);this.editable(id);
  const c=this.case(id),w=this.store.getWorkSession(c.connection,id);
  if(ctx.connection!==d.connection||ctx.base.href!==d.endpoint||ctx.revision!==d.configRevision||c.updated!==d.sourceUpdated||(w?.revision??1)!==d.sessionRevision||!c.active)
   throw new AppError(409,'Alert, plan, feedback or settings changed. Prepare a fresh ticket draft.');
 }
 private persist(id:string,d:AlertTicketDraft){const c=this.case(id);c.ticketCreation=d;this.saveCase(c);return c;}
 private link(id:string,issue:{id:string;idReadable:string},ctx:Context,message:string){
  this.youtrack.assertContext(ctx);const c=this.case(id);
  if(c.ticket&&(c.ticket.id!==issue.id||c.ticket.connection!==ctx.connection))throw new AppError(409,'A different ticket is already linked. Inspect YouTrack.');
  c.ticket={id:issue.id,key:issue.idReadable,connection:ctx.connection,url:new URL('issue/'+encodeURIComponent(issue.idReadable),ctx.base).href};
  if(c.ticketCreation){c.ticketCreation.state='created';c.ticketCreation.remoteId=issue.id;c.ticketCreation.message=message;}
  this.saveCase(c);this.store.put('origin:'+ctx.connection+':'+issue.id,{kind:c.sourceKind==='slack'?'slack':'alert',id:c.id,title:c.title,connection:c.connection});const owner=handling(this.store,{connection:c.connection,id});if(['human','refused','done'].includes(owner.mode))this.store.put('handling:'+ctx.connection+':'+issue.id,owner);return c;
 }
 private async existing(marker:string,ctx:Context){
  const found=await this.youtrack.findAlertTickets(marker,ctx);
  if(found.length>1)throw new AppError(409,'Multiple tickets contain this case reference. Inspect YouTrack; no ticket was created.');
  return found[0];
 }
 async prepare(id:string,projectId:string){
  const release=this.store.claimWork();try{
   this.editable(id);const detail=await this.fresh(id),ctx=this.youtrack.context();
   const project=await this.project(projectId,ctx),marker='supportalert'+id;
   const existing=await this.existing(marker,ctx);
   if(existing)return this.link(id,existing,ctx,'Existing ticket found. No creation request sent.');
   const c=this.case(id),plan=detail.session.plans.at(-1);
   if(c.updated!==detail.issue.updated)throw new AppError(409,'Alert changed while preparing. Refresh and try again.');
   const labelText=Object.entries(c.labels).map(([k,v])=>`- **${markdownText(k)}:** ${markdownText(v)}`).join('\n');
   const description=[`## ${c.sourceKind==='slack'?'Slack request':'Alert'}: ${markdownText(c.title)}`,`- **Severity:** ${c.severity}\n- **Observed occurrences:** ${c.episodes}\n- **Affected instances:** ${c.members.length}\n- **First seen:** ${c.firstSeen}`,
    '### Group labels\n\n'+(labelText.length>4000?labelText.slice(0,4000)+'\n[Additional labels omitted from this draft]':labelText),
    plan?'## Proposed plan — not executed\n\n'+plan.text:'Investigation pending. No remediation has been performed.',
    c.sourceKind==='slack'?'## Slack thread\n\n'+detail.issue.description+'\n\n'+(detail.issue.comments??[]).map(c=>c.text).join('\n\n'):'Created from a local support alert case. Alert recurrence does not create a new ticket.'].join('\n\n');
   if(description.includes('Support alert case:'))throw new AppError(400,'Remove embedded case references from the plan before preparing a ticket.');
   const d:AlertTicketDraft={state:'draft',revision:(c.ticketCreation?.revision??0)+1,hash:'',connection:ctx.connection,endpoint:ctx.base.href,project,title:('['+c.severity+'] '+c.title).slice(0,250),description,marker,sourceUpdated:detail.issue.updated,sessionRevision:detail.session.revision,configRevision:ctx.revision!,message:'Draft only. Review the project, title and description before creation.'};
   this.safeText(d.title+'\n'+this.text(d));this.guard(id,d,ctx);d.hash=this.digest(d);return this.persist(id,d);
  }finally{release();}
 }
 async save(id:string,input:z.infer<typeof alertDraftInput>){
  const release=this.store.claimWork();try{
   const d=this.editable(id).ticketCreation;if(!d||d.hash!==input.hash)throw new AppError(409,'Reload the current draft before editing.');
   await this.fresh(id);const ctx=this.youtrack.context();this.guard(id,d,ctx);
   const project=await this.project(input.projectId,ctx);this.guard(id,d,ctx);
   // Keep the immutable reference out of editable text; the exact posted footer is shown separately.
   if(input.description.includes('Support alert case:'))throw new AppError(400,'The case reference is added separately. Remove it from the editable description.');
   Object.assign(d,{project,title:input.title,description:input.description,revision:d.revision+1});
   this.safeText(d.title+'\n'+this.text(d));d.hash=this.digest(d);return this.persist(id,d);
  }finally{release();}
 }
 private async finish(id:string,ctx:Context){
  const c=this.case(id),d=c.ticketCreation!;
  if(d.connection!==ctx.connection||d.endpoint!==ctx.base.href)throw new AppError(409,'Restore the original YouTrack instance before checking creation.');
  const issue=d.remoteId?await this.youtrack.alertTicket(d.remoteId,ctx):await this.existing(d.marker,ctx);
  if(!issue||issue.project.id!==d.project.id||!issue.description?.split('\n').some(line=>line.trim()==='Support alert case: '+d.marker))
   throw new AppError(409,'Creation is not confirmed. Inspect YouTrack or check again later. No create request was retried.');
  return this.link(id,issue,ctx,'YouTrack ticket confirmed. Recurring alerts reuse this ticket.');
 }
 async approve(id:string,expectedHash:string){
  const release=this.store.claimWork();let intended=false;
  try{
   const d=this.editable(id).ticketCreation;
   if(!d||d.hash!==expectedHash||this.digest(d)!==expectedHash)throw new AppError(409,'Review the current ticket draft before approving creation.');
   await this.fresh(id);const ctx=this.youtrack.context();this.guard(id,d,ctx);
   if(hash(await this.project(d.project.id,ctx))!==hash(d.project))throw new AppError(409,'The destination project changed. Prepare a fresh draft.');
   const existing=await this.existing(d.marker,ctx);this.guard(id,d,ctx);
   if(existing)return this.link(id,existing,ctx,'Existing ticket found. No creation request sent.');
   this.safeText(d.title+'\n'+this.text(d));
   // Persist intent before the sole POST. Pending never transitions back to draft, even after a restart.
   d.state='pending';d.approval={hash:expectedHash,...humanAttribution(this.store),at:new Date().toISOString()};d.message='Creation requested. Check status if interrupted.';
   this.persist(id,d);intended=true;
   const remoteId=await this.youtrack.createAlertTicket({project:{id:d.project.id},summary:d.title,description:this.text(d)},ctx);
   // Merge only operation metadata: background polling may have updated the case while POST was in flight.
   const current=this.case(id).ticketCreation!;current.remoteId=remoteId;this.persist(id,current);
   return await this.finish(id,ctx);
  }catch(e){
   if(intended){const d=this.case(id).ticketCreation!;d.message=e instanceof AppError?e.message:'Creation response could not be verified. Check YouTrack status; no automatic retry.';return this.persist(id,d);}
   throw e;
  }finally{release();}
 }
 async reconcile(id:string){
  const release=this.store.claimWork();try{
   const d=this.case(id).ticketCreation;if(!d||d.state!=='pending')throw new AppError(409,'There is no pending creation to check.');
   try{return await this.finish(id,this.youtrack.context());}catch(e){d.message=e instanceof AppError?e.message:'Could not verify the ticket. Inspect YouTrack; no create request was retried.';return this.persist(id,d);}
  }finally{release();}
 }
}

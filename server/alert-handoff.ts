import {humanAttribution} from './identity.js';
import {assertHandling} from './intake.js';
import {createHash} from 'node:crypto';
import {Store,AppError} from './store.js';
import {Alertmanager} from './alertmanager.js';
import {YouTrack} from './youtrack.js';
import type {AlertHandoff,HandoffReview,HandoffResult} from '../src/model.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class AlertHandoffs {
 constructor(private store:Store,private alerts:Alertmanager,private youtrack:YouTrack){}
 private async read(id:string){
  const configRevision=this.store.snapshot().configRevision,epoch=this.store.credentialEpoch;
  const source=await this.alerts.work(id),link=source.alert.ticket;
  if(!link||source.alert.ticketCreation?.state==='pending')throw new AppError(409,'Confirm the linked YouTrack ticket first.');
  const ctx=this.youtrack.context();
  if(ctx.connection!==link.connection)throw new AppError(409,'Restore the linked YouTrack instance before carrying the plan.');
  const target=await this.youtrack.work(link.id);
  const check=()=>{
   this.youtrack.assertContext(ctx);assertHandling(this.store,target.issue);
   if(configRevision!==this.store.snapshot().configRevision||epoch!==this.store.credentialEpoch)throw new AppError(409,'Settings or vault changed. Review the handoff again.');
   const current=this.store.alert(id),session=this.store.getWorkSession(current.connection,id);
   const dest=this.store.getWorkSession(target.issue.connection,target.issue.id);
   if(current.updated!==source.issue.updated||current.ticket?.id!==link.id||current.ticket.connection!==link.connection||(session?.revision??1)!==source.session.revision||(dest?.revision??1)!==target.session.revision)
    throw new AppError(409,'Alert, ticket or local work changed. Review the handoff again.');
  };
  check();
  if(target.issue.id!==link.id||target.issue.connection!==link.connection)throw new AppError(409,'The linked ticket identity changed.');
  if(target.issue.resolved)throw new AppError(409,'The linked ticket is resolved. Reopen it in YouTrack before carrying a plan.');
  if(source.session.pendingRevision||source.alert.run?.state==='running')throw new AppError(409,'Finish the alert plan revision or investigation first.');
  const plan=source.session.plans.at(-1);if(!plan)throw new AppError(409,'Prepare an alert plan first.');
  const pending=this.store.changes(link.connection,link.id).some(c=>['generating','branch_pending','mr_pending'].includes(c.state)||c.fixes?.some(f=>f.state==='pushing')||['posting','closing'].includes(c.resolution?.state??''));
  if(pending)throw new AppError(409,'Check the ticket’s pending external operation before carrying another plan.');
  const content={alertId:id,alertConnection:source.issue.connection,alertTitle:source.issue.title,alertUpdated:source.issue.updated,alertActive:source.alert.active,occurrences:source.alert.episodes,sourcePlanVersion:plan.version,plan:plan.text,notes:source.session.notes,replyDraft:source.session.draft,analysis:source.session.analysis};
  const identity=hash(content);
  const review:HandoffReview={hash:'',source:{id,title:content.alertTitle,updated:content.alertUpdated,active:content.alertActive,occurrences:content.occurrences,revision:source.session.revision,planVersion:plan.version},plan:plan.text,notes:content.notes,replyDraft:content.replyDraft,analysis:content.analysis,
   target:{id:target.issue.id,key:target.issue.key,title:target.issue.title,connection:target.issue.connection,revision:target.session.revision,sourceUpdated:target.issue.updated,planCount:target.session.plans.length,hasReplyDraft:!!target.session.draft,pendingRevision:!!target.session.pendingRevision},
   alreadyImported:target.session.alertHandoffs?.find(h=>h.id===identity)?.targetPlanVersion};
  review.hash=hash({identity,review,configRevision});
  return {source,target,plan,content,identity,review,check};
 }
 async preview(id:string){const release=this.store.claimWork();try{return (await this.read(id)).review;}finally{release();}}
 async carry(id:string,expectedHash:string):Promise<HandoffResult>{
  const release=this.store.claimWork();try{
   const r=await this.read(id),w=r.target.session;
   // A lost response may be retried safely, even if later ticket work has already advanced.
   const prior=w.alertHandoffs?.find(h=>h.requestHash===expectedHash);
   if(prior)return {detail:r.target,handoff:prior,alreadyImported:true};
   if(expectedHash!==r.review.hash)throw new AppError(409,'The handoff review is stale. Review both sessions again.');
   const existing=w.alertHandoffs?.find(h=>h.id===r.identity);
   if(existing)return {detail:r.target,handoff:existing,alreadyImported:true};
   return this.store.transaction(()=>{
    r.check();const at=new Date().toISOString(),version=w.plans.length+1;
    const handoff:AlertHandoff={id:r.identity,requestHash:expectedHash,alertId:id,alertConnection:r.source.issue.connection,alertTitle:r.content.alertTitle,alertUpdated:r.content.alertUpdated,alertActive:r.content.alertActive,occurrences:r.content.occurrences,sourcePlanVersion:r.plan.version,sourceRevision:r.source.session.revision,targetPlanVersion:version,at,...humanAttribution(this.store),notes:structuredClone(r.content.notes),replyDraft:r.content.replyDraft,analysis:structuredClone(r.content.analysis)};
    w.plans.push({version,text:r.plan.text,at});
    (w.alertHandoffs??=[]).push(handoff);
    // Existing notes, history, reply drafts and unresolved revision requests are not overwritten.
    if(!w.draft)w.draft=r.content.replyDraft;
    w.approval=null;w.revision++;w.updatedAt=at;
    this.store.saveWorkSession(w);
    return {detail:{issue:r.target.issue,session:w},handoff,alreadyImported:false};
   });
  }finally{release();}
 }
}

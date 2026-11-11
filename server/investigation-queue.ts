import {agentHalted} from './agent-feed.js';
import {handling,isIgnored} from './intake.js';
import {Store} from './store.js';
import {YouTrack} from './youtrack.js';
import type {AgentQueue} from './agent-queue.js';
import {recordDiagnostic} from './diagnostics.js';
/** YouTrack intake: offers eligible tickets to the agent queue every minute. Never starts or executes anything itself. */
export class InvestigationQueue {
 private busy=false;private next=0;private offset=0;private revision=0;
 constructor(private store:Store,private source:YouTrack,private queue:AgentQueue){}
 async tick(now=Date.now()){
  if(this.busy||!this.store.key)return;
  const snapshot=this.store.snapshot(),config=snapshot.config;
  if(agentHalted(this.store)||!config.autoInvestigate||!config.connections.YouTrack.enabled||!config.connections.Model.enabled)return;
  if(this.revision!==snapshot.configRevision){this.offset=0;this.next=0;this.revision=snapshot.configRevision;}
  if(now<this.next)return;
  this.busy=true;this.next=now+60000;
  const epoch=this.store.credentialEpoch;
  const current=()=>!!this.store.key&&epoch===this.store.credentialEpoch&&snapshot.configRevision===this.store.snapshot().configRevision;
  try{
   const page=await this.source.list(this.offset);if(!current())return;
   for(const candidate of page.issues){
    if(candidate.resolved){this.queue.close(candidate.connection,candidate.id);continue;}
    const {issue,session}=await this.source.work(candidate.id);if(!current())return;
    const pendingOrigins=[...this.store.alertCases(),...(this.store.get<string[]>('slackIds')??[]).map(id=>this.store.get<import('../src/model.js').AlertCase>('slack:'+id)!).filter(Boolean)].filter(c=>c.ticketCreation?.state==='pending');
    if(pendingOrigins.some(c=>issue.description.split('\n').some(line=>line.trim()==='Support alert case: '+c.ticketCreation!.marker)))continue;
    if(handling(this.store,issue).mode!=='investigate'||isIgnored(this.store,issue))continue;
    if(issue.resolved||session.pendingRevision||session.approval||this.store.changes(issue.connection,issue.id).length)continue;
    const scope=issue.connection+':'+issue.id,fingerprint=issue.sourceFingerprint??String(issue.updated);
    const previous=this.store.db.prepare('SELECT fingerprint FROM investigation_attempts WHERE scope=?').get(scope);
    if(previous?.fingerprint===fingerprint)continue;
    const runs=this.store.investigations(issue.connection,issue.id).filter(r=>!r.kind||r.kind==='investigation');
    if(runs.some(r=>r.startedAt>=(session.handling?.at||'')&&r.sourceFingerprint===issue.sourceFingerprint&&r.sourceUpdated===issue.updated))continue;
    // Keep imported and reviewed plans.
    if(session.plans.length&&!session.sourceChangedAt)continue;
    this.queue.offer({connection:issue.connection,id:issue.id,title:`${issue.key} · ${issue.title}`,fingerprint});
   }
   this.offset=page.hasMore?this.offset+page.issues.length:0;
  }catch(e){if(current())recordDiagnostic(this.store,{tool:'YouTrack',operation:'Automatic investigation intake',status:'error',durationMs:0,output:(e as Error).message});}
  finally{this.busy=false;}
 }
}

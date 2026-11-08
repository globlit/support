import {handling,isIgnored} from './intake.js';
import {Store,AppError} from './store.js';
import {YouTrack} from './youtrack.js';
import {Claude} from './claude.js';
import {recordDiagnostic} from './diagnostics.js';
/** Bounded server-owned intake. Re-read each source before starting; never execute plans. */
export class InvestigationQueue {
 private busy=false;private next=0;private offset=0;private revision=0;
 constructor(private store:Store,private source:YouTrack,private agent:Claude){}
 async tick(now=Date.now()){
  const snapshot=this.store.snapshot(),config=snapshot.config;
  if(this.busy||!this.store.key||!config.autoInvestigate||!config.connections.YouTrack.enabled||!config.connections.Model.enabled)return;
  if(this.revision!==snapshot.configRevision){this.offset=0;this.next=0;this.revision=snapshot.configRevision;}
  if(now<this.next||!this.store.canAnalyze())return;
  this.busy=true;this.next=now+60000;
  const epoch=this.store.credentialEpoch;
  const current=()=>!!this.store.key&&epoch===this.store.credentialEpoch&&snapshot.configRevision===this.store.snapshot().configRevision;
  try{
   const page=await this.source.list(this.offset);if(!current())return;
   let saturated=false;
   for(const candidate of page.issues){
    if(!this.store.canAnalyze()){saturated=true;break;}
    if(candidate.resolved)continue;
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
    // Preserve plans imported from alerts and existing reviews. Changed requests get a fresh analysis.
    if(session.plans.length&&!session.sourceChangedAt)continue;
    try{await this.agent.start(issue.id,{revision:session.revision,sourceUpdated:issue.updated});}
    catch(e){if(e instanceof AppError&&e.status===409){saturated=true;break;}
     this.store.db.prepare('INSERT OR REPLACE INTO investigation_attempts VALUES (?,?,?)').run(scope,fingerprint,new Date(now).toISOString());
     throw e;
    }
   }
   if(!saturated)this.offset=page.hasMore?this.offset+page.issues.length:0;
  }catch(e){if(current())recordDiagnostic(this.store,{tool:'YouTrack',operation:'Automatic investigation intake',status:'error',durationMs:0,output:(e as Error).message});}
  finally{this.busy=false;}
 }
}

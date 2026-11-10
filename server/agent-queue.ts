import type {Store} from './store.js';
import {AppError} from './store.js';
import {agentHalted,agentFeed} from './agent-feed.js';
import {handling,isIgnored} from './intake.js';
import {recordDiagnostic} from './diagnostics.js';
import {sourceKind,sourcePage,type SourceKind} from '../src/intake-model.js';
import type {SourceIssue,WorkSession} from '../src/model.js';

export type QueueState='queued'|'running'|'review'|'dead'|'done';
export type QueueEntry={scope:string;connection:string;issueId:string;title:string;fingerprint:string;origin:'auto'|'manual';state:QueueState;attempts:number;lastError:string|null;runId:string|null;nextAttemptAt:string;enqueuedAt:string;updatedAt:string};
export type QueueAdapter={load(id:string):Promise<{issue:SourceIssue;session:WorkSession}>;start(id:string,expected:{revision:number;sourceUpdated:number}):Promise<unknown>;onStartError?(id:string,error:unknown):void};
/** Automatic runs get one retry after this delay. A second failure moves the entry to the dead letter. */
export const retryDelayMs=60_000,maxAttempts=2;
type Row={scope:string;connection:string;issue_id:string;title:string;fingerprint:string;origin:'auto'|'manual';state:QueueState;attempts:number;last_error:string|null;run_id:string|null;next_attempt_at:string;enqueued_at:string;updated_at:string};
const entry=(r:Row):QueueEntry=>({scope:r.scope,connection:r.connection,issueId:r.issue_id,title:r.title,fingerprint:r.fingerprint,origin:r.origin,state:r.state,attempts:r.attempts,lastError:r.last_error,runId:r.run_id,nextAttemptAt:r.next_attempt_at,enqueuedAt:r.enqueued_at,updatedAt:r.updated_at});

/**
 * Queue of investigations, stored in SQLite. Sources offer eligible tickets, alerts and Slack threads. `tick` starts
 * the oldest queued entry when a slot is free. With `parallelReview` off, an entry whose plan waits for review keeps
 * its slot until the engineer approves, ignores or discards it, or the source is resolved.
 * A failed automatic run is retried once after 60 s, then moved to the dead letter.
 */
export class AgentQueue {
 private adapters=new Map<SourceKind,QueueAdapter>();private busy=false;
 constructor(private store:Store,private isActive:(runId:string)=>boolean=()=>false,private now=()=>Date.now()){
  store.db.exec(`CREATE TABLE IF NOT EXISTS agent_queue (scope TEXT PRIMARY KEY, connection TEXT NOT NULL, issue_id TEXT NOT NULL, title TEXT NOT NULL, fingerprint TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, run_id TEXT, next_attempt_at TEXT NOT NULL, enqueued_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  // Runs do not survive a restart: queue interrupted entries again without counting an attempt.
  for(const e of this.list('running'))if(!this.isActive(e.runId??''))this.update(e.scope,{state:e.origin==='auto'?'queued':'done',run_id:null});
 }
 register(kind:SourceKind,adapter:QueueAdapter){this.adapters.set(kind,adapter);}
 private iso(offset=0){return new Date(this.now()+offset).toISOString();}
 private changed(){agentFeed.emit('state');}
 private log(operation:string,e:QueueEntry,output:string,status:'ok'|'error'='ok'){recordDiagnostic(this.store,{tool:'Agent',operation:`${operation}: ${e.title.split(' · ')[0]}`,status,durationMs:0,output:[output,`Ticket: ${e.title}`].filter(Boolean).join('\n'),issueId:e.issueId});}
 private update(scope:string,fields:Partial<Row>){
  const keys=Object.keys(fields);if(!keys.length)return;
  this.store.db.prepare(`UPDATE agent_queue SET ${keys.map(k=>k+'=?').join(',')},updated_at=? WHERE scope=?`).run(...keys.map(k=>(fields as Record<string,string|number|null>)[k]),this.iso(),scope);
  this.changed();
 }
 get(scope:string){const r=this.store.db.prepare('SELECT * FROM agent_queue WHERE scope=?').get(scope) as Row|undefined;return r&&entry(r);}
 /** Entries in queue order: oldest first. */
 list(state?:QueueState){return ((state?this.store.db.prepare('SELECT * FROM agent_queue WHERE state=? ORDER BY enqueued_at,scope').all(state):this.store.db.prepare("SELECT * FROM agent_queue WHERE state<>'done' ORDER BY enqueued_at,scope").all()) as Row[]).map(entry);}
 counts(){const c={queued:0,running:0,review:0,dead:0};for(const e of this.list())if(e.state in c)c[e.state as keyof typeof c]++;const config=this.store.snapshot().config;return {...c,budgetFull:!config.parallelReview&&c.running+c.review>=config.maxRuns};}

 /**
  * Adds an eligible source to the queue. A queued entry gets the new title. A new fingerprint also resets its attempts and makes it due now. A running entry
  * is unchanged. A reviewed, dead or done entry is queued again only when its fingerprint changed.
  */
 offer(o:{connection:string;id:string;title:string;fingerprint:string}){
  const scope=o.connection+':'+o.id,current=this.get(scope);
  if(!current){const at=this.iso();this.store.db.prepare('INSERT INTO agent_queue VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(scope,o.connection,o.id,o.title.slice(0,300),o.fingerprint,'auto','queued',0,null,null,at,at,at);this.changed();return;}
  if(current.state==='queued'){if(current.fingerprint!==o.fingerprint)this.update(scope,{fingerprint:o.fingerprint,title:o.title.slice(0,300),attempts:0,last_error:null,next_attempt_at:this.iso()});else if(current.title!==o.title)this.update(scope,{title:o.title.slice(0,300)});return;}
  // A changed source is investigated again, including one whose plan waits for review.
  if((current.state==='dead'||current.state==='done'||current.state==='review')&&current.fingerprint!==o.fingerprint)this.update(scope,{state:'queued',origin:'auto',fingerprint:o.fingerprint,title:o.title.slice(0,300),attempts:0,last_error:null,run_id:null,next_attempt_at:this.iso(),enqueued_at:this.iso()});
 }
 /** Removes a resolved source from the queue, whatever its state. */
 close(connection:string,id:string){const e=this.get(connection+':'+id);if(e&&e.state!=='done'&&e.state!=='running')this.update(e.scope,{state:'done'});}
 retry(scope:string){const e=this.get(scope);if(!e||e.state!=='dead')throw new AppError(404,'This entry is not in the dead letter.');this.log('Retried by engineer',e,'');this.update(scope,{state:'queued',origin:'auto',attempts:0,last_error:null,next_attempt_at:this.iso(),enqueued_at:this.iso()});}
 discard(scope:string){const e=this.get(scope);if(!e||e.state==='running')throw new AppError(409,'Stop the run before discarding it.');this.log('Discarded by engineer',e,e.lastError?`Last error: ${e.lastError}`:'');this.update(scope,{state:'done'});}

 /** Records a run start, including manual starts, so that the run uses a slot. */
 started(run:{runId:string;connection:string;id:string;title:string;fingerprint?:string}){
  const scope=run.connection+':'+run.id,current=this.get(scope);
  if(current)this.update(scope,{state:'running',run_id:run.runId,title:run.title.slice(0,300)});
  else{const at=this.iso();this.store.db.prepare('INSERT INTO agent_queue VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(scope,run.connection,run.id,run.title.slice(0,300),run.fingerprint??'','manual','running',0,null,run.runId,at,at,at);this.changed();}
 }
 /** Records the end of a run: a plan waits for review, a failure is retried or moved to the dead letter, a stop goes to the dead letter. */
 finished(runId:string,state:'ready'|'failed'|'cancelled',error?:string){
  const r=this.store.db.prepare('SELECT * FROM agent_queue WHERE run_id=?').get(runId) as Row|undefined;if(!r)return;const e=entry(r);
  if(state==='ready')return this.update(e.scope,{state:'review',last_error:null});
  if(state==='cancelled')return this.update(e.scope,{state:'dead',last_error:error??'Stopped by the engineer.'});
  if(e.origin==='manual')return this.update(e.scope,{state:'done',last_error:error??null});
  this.fail(e,error??'Investigation failed.');
 }
 private fail(e:QueueEntry,error:string){
  const attempts=e.attempts+1;
  if(attempts<maxAttempts)this.log(`Retry in ${retryDelayMs/1000} s`,e,`Attempt ${attempts} of ${maxAttempts} failed: ${error}`,'error');else this.log('Moved to dead letter',e,`${attempts} attempts failed. Last error: ${error}`,'error');
  this.update(e.scope,attempts<maxAttempts?{state:'queued',attempts,last_error:error,run_id:null,next_attempt_at:this.iso(retryDelayMs)}:{state:'dead',attempts,last_error:error,run_id:null});
 }
 /** Frees review slots that the engineer handled: approved, ignored, taken over, or changes prepared. A pending revision keeps its slot. */
 reconcile(){
  for(const e of this.list('review')){
   const session=this.store.getWorkSession(e.connection,e.issueId),ref={connection:e.connection,id:e.issueId};
   if(session?.approval||handling(this.store,ref).mode!=='investigate'||isIgnored(this.store,ref)||this.store.changes(e.connection,e.issueId).length)this.update(e.scope,{state:'done'});
  }
 }
 /** True when a new automatic investigation may start now. */
 hasSlot(){
  if(!this.store.canAnalyze())return false;
  return !this.counts().budgetFull;
 }
 /** Starts the oldest due queued entry when a slot is free. */
 async tick(){
  if(this.busy||!this.store.key||agentHalted(this.store))return;
  this.busy=true;
  try{
   this.reconcile();
   for(const e of this.list('queued')){
    if(!this.hasSlot())return;
    if(e.nextAttemptAt>this.iso())continue;
    const adapter=this.adapters.get(sourceKind(e.connection));if(!adapter)continue;
    let loaded;
    try{loaded=await adapter.load(e.issueId);}catch(error){this.fail(e,(error as Error).message);continue;}
    const {issue,session}=loaded;
    if(issue.resolved||session.approval||session.pendingRevision||handling(this.store,issue).mode!=='investigate'||isIgnored(this.store,issue)){this.update(e.scope,{state:'done'});continue;}
    try{await adapter.start(e.issueId,{revision:session.revision,sourceUpdated:issue.updated});}
    catch(error){
     if(error instanceof AppError&&(error.status===409||error.status===423))return;
     adapter.onStartError?.(e.issueId,error);this.fail(e,'Start failed: '+(error as Error).message);
    }
   }
  }finally{this.busy=false;}
 }
 /** Entries for the agent console, with the route of each source. */
 view(){return this.list().map(e=>({...e,route:{page:sourcePage(e.connection),issue:e.issueId}}));}
}

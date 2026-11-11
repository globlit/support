import {assertHandling,handling,matchedRules,isIgnored} from './intake.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Store,AppError} from './store.js';
import {boundedJSON,serviceBase} from './gitlab.js';
import {serviceAuthHeaders} from './service-auth.js';
import {localAction,YouTrack} from './youtrack.js';
import type {Claude} from './claude.js';
import type {AgentQueue} from './agent-queue.js';
import type {AlertCase,AlertMember,AlertQueue,SourceIssue,AlertDetail} from '../src/model.js';

const labels=z.record(z.string().max(200),z.string().max(16000)).refine(v=>Object.keys(v).length<=100);
const alertSchema=z.object({fingerprint:z.string().min(1).max(128),labels,annotations:labels,
 startsAt:z.iso.datetime({offset:true}),status:z.object({state:z.enum(['unprocessed','active','suppressed'])})});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted=(value:Record<string,string>)=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));

export class Alertmanager {
 private pending:Promise<void>|null=null;
 private lastAttempt=0;
 private attemptRevision=0;
 private attemptEpoch=0;
 private lastSuccess?:string;
 private error?:string;
 private pollConnection?:string;
 private ticking=false;
 constructor(private store:Store,private fetcher:typeof fetch=fetch){
  // Require an explicit retry after a restart.
  for(const c of store.alertCases())if(c.run?.state==='running'){
   c.run.state='failed';c.run.error='Investigation interrupted by restart. Analyze again.';store.saveAlert(c);
  }
 }
 private context(){
  const s=this.store.snapshot(),c=s.config.connections.Alertmanager;
  if(!c.enabled||!c.endpoint)throw new AppError(400,'Configure and enable Alertmanager in Connections.');
  if(!s.vault.unlocked)throw new AppError(423,'Unlock the vault to poll alerts.');
  const base=serviceBase(c.endpoint);
  if(/\/api\/v2\/?$/.test(base.pathname))throw new AppError(400,'Use the Alertmanager base URL, without /api/v2.');
  // New matchers or grouping create a separate scope.
  const configured=s.config.alerting.groupBy.split(',').map(k=>k.trim()).filter(Boolean);
  const keys=configured.length?[...new Set(['alertname',...configured])].sort():[];
  return {base,keys,filters:c.scope.split('\n').map(v=>v.trim()).filter(Boolean),
   connection:'alertmanager:'+digest([base.href,c.scope.trim(),keys]),revision:s.configRevision,epoch:this.store.credentialEpoch,
   headers:serviceAuthHeaders(this.store,'Alertmanager')};
 }
 private check(ctx:ReturnType<Alertmanager['context']>){
  if(ctx.revision!==this.store.snapshot().configRevision||ctx.epoch!==this.store.credentialEpoch||!this.store.key)
   throw new AppError(409,'Settings or vault changed during polling. Refresh alerts.');
 }
 private clean(text:string,secrets:string[]){
  for(const secret of secrets)if(secret)text=text.split(secret).join('[redacted]');
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted private key]')
   .replace(/\b(password|token|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]');
 }
 private cleanLabels(values:Record<string,string>,secrets:string[]){
  return Object.fromEntries(Object.entries(sorted(values)).map(([k,v])=>[k,/(password|token|secret|authorization|api.?key)/i.test(k)?'[redacted]':this.clean(v,secrets)]));
 }
 async poll(){
  if(this.pending)return this.pending;
  this.lastAttempt=Date.now();this.attemptRevision=this.store.snapshot().configRevision;this.attemptEpoch=this.store.credentialEpoch;
  this.pending=this.read().catch(e=>{this.error=e instanceof AppError?e.message:'Alertmanager returned invalid data. Previous cases were kept.';throw new AppError(e instanceof AppError?e.status:502,this.error);}).finally(()=>{this.pending=null;});
  return this.pending;
 }
 private async read(){
  const ctx=this.context(),url=new URL('api/v2/alerts',ctx.base);
  for(const key of ['active','silenced','inhibited','unprocessed'])url.searchParams.set(key,'true');
  for(const filter of ctx.filters)url.searchParams.append('filter',filter);
  const raw=await boundedJSON(this.fetcher,url,ctx.headers);
  const alerts=z.array(alertSchema).max(5000).parse(raw);this.check(ctx);
  const secrets=this.store.secretValues();
  const groups=new Map<string,{labels:Record<string,string>;members:AlertMember[]}>();
  for(const a of alerts){
   if(!['warning','critical'].includes(a.labels.severity?.toLowerCase()))continue;
   const keyLabels=ctx.keys.length?Object.fromEntries(ctx.keys.map(k=>[k,a.labels[k]??''])):
    Object.fromEntries(Object.entries(a.labels).filter(([k])=>k!=='severity'));
   // Hash the identity before redaction.
   const id=digest([ctx.connection,sorted(keyLabels)]);
   const group=groups.get(id)??{labels:this.cleanLabels(keyLabels,secrets),members:[]};
   const member={fingerprint:a.fingerprint,labels:this.cleanLabels(a.labels,secrets),annotations:this.cleanLabels(a.annotations,secrets),startsAt:a.startsAt,state:a.status.state};
   const previous=group.members.find(m=>m.fingerprint===member.fingerprint);
   if(previous&&digest(previous)!==digest(member))throw new AppError(502,'Conflicting alert fingerprints. Previous cases were kept.');
   if(!previous)group.members.push(member);
   if(group.members.length>200)throw new AppError(502,'An alert group exceeds 200 members. Use more grouping labels. Previous cases were kept.');
   groups.set(id,group);
  }
  const now=new Date().toISOString();
  this.store.transaction(()=>{
   const old=this.store.alertCases().filter(c=>c.connection===ctx.connection);
   for(const [id,group] of groups){
    group.members.sort((a,b)=>a.fingerprint.localeCompare(b.fingerprint));
    const content=digest(group),previous=old.find(c=>c.id===id),changed=!previous||!previous.active||previous.digest!==content;
    const c:AlertCase={...previous,id,connection:ctx.connection,title:group.labels.alertname??group.members[0].labels.alertname??'Infrastructure alert',
     severity:group.members.some(m=>m.labels.severity?.toLowerCase()==='critical')?'critical':'warning',...group,
     active:true,suppressed:group.members.every(m=>m.state==='suppressed'),episodes:(previous?.episodes??0)+(!previous?.active||group.members.some(m=>previous.members.some(p=>p.fingerprint===m.fingerprint&&p.startsAt!==m.startsAt))?1:0),
     firstSeen:previous?.firstSeen??now,lastSeen:now,updated:changed?Math.max(Date.now(),(previous?.updated??0)+1):previous.updated,digest:content};
    this.store.saveAlert(c);if(changed)this.store.workSession(this.source(c));
   }
   for(const c of old)if(c.active&&!groups.has(c.id)){
    c.active=false;c.updated=Math.max(Date.now(),c.updated+1);this.store.saveAlert(c);this.store.workSession(this.source(c));
   }
   // Prune inactive cases only.
   const cutoff=Date.now()-this.store.snapshot().config.retentionDays*86400000;
   for(const c of this.store.alertCases())if(!c.active&&!c.ticket&&c.ticketCreation?.state!=='pending'&&Date.parse(c.lastSeen)<cutoff){
    this.store.db.prepare('DELETE FROM alert_cases WHERE id=?').run(c.id);
    this.store.db.prepare('DELETE FROM work_sessions WHERE connection=? AND issue_id=?').run(c.connection,c.id);
   }
  });
  this.pollConnection=ctx.connection;this.lastSuccess=now;this.error=undefined;
 }
 source(c:AlertCase):SourceIssue{
  return {id:c.id,connection:c.connection,key:'ALERT-'+c.id.slice(0,8),title:c.title,
   description:JSON.stringify({ignoredInstances:c.members.filter(m=>matchedRules(this.store,'alert',m.labels.alertname??c.title,m.labels).length).length,state:c.active?'Present in Alertmanager':'Not present in latest successful poll',episodes:c.episodes,group:c.labels,members:c.members.filter(m=>!matchedRules(this.store,'alert',m.labels.alertname??c.title,m.labels).length)}),
   sourceFingerprint:digest([c.digest,c.active,c.episodes,c.members.filter(m=>matchedRules(this.store,'alert',m.labels.alertname??c.title,m.labels).length).map(m=>m.fingerprint)]),updated:c.updated,resolved:!c.active,status:!c.active?'Not firing':c.suppressed?'Suppressed':'Firing',severity:c.severity,assignee:'Support engineer',project:'Alertmanager',fields:c.labels,url:''};
 }
 async issue(id:string){
  await this.poll();const c=this.store.alert(id);
  if(c.connection!==this.context().connection)throw new AppError(409,'This case belongs to different Alertmanager settings.');
  return this.source(c);
 }
 async work(id:string):Promise<AlertDetail>{const issue=await this.issue(id),c=this.store.alert(id);return {issue,session:this.store.workSession(issue),alert:{...c,ignored:c.members.filter(m=>matchedRules(this.store,'alert',m.labels.alertname??c.title,m.labels).length).length}};}
 async action(id:string,input:Parameters<typeof localAction>[2]){
  const issue=await this.issue(id);return {...localAction(this.store,issue,input),alert:this.store.alert(id)};
 }
 async link(id:string,ticketId:string,youtrack:YouTrack){
  const release=this.store.claimWork();try{
  if(this.store.alert(id).ticketCreation?.state==='pending')throw new AppError(409,'Check pending ticket creation before linking another ticket.');
  await this.issue(id);const revision=this.store.snapshot().configRevision,epoch=this.store.credentialEpoch;
  const ticket=await youtrack.issue(ticketId);
  if(revision!==this.store.snapshot().configRevision||epoch!==this.store.credentialEpoch)throw new AppError(409,'Settings changed. Link again.');
  const c=this.store.alert(id);
  if(c.ticket&&(c.ticket.connection!==ticket.connection||c.ticket.id!==ticket.id))throw new AppError(409,'A ticket is already linked to this case.');
  c.ticket={connection:ticket.connection,id:ticket.id,key:ticket.key,url:ticket.url};if(c.ticketCreation){c.ticketCreation.state='created';c.ticketCreation.remoteId=ticket.id;c.ticketCreation.message='Existing ticket linked. No creation request sent.';}this.store.saveAlert(c);this.store.put('origin:'+ticket.connection+':'+ticket.id,{kind:'alert',id:c.id,title:c.title,connection:c.connection});
  return await this.work(id);
  }finally{release();}
 }
 /** Records a failed automatic start on the alert case, as shown in the alert's investigation step. */
 recordStartFailure(id:string,error:unknown){const c=this.store.alert(id);c.autoAttempt=c.episodes;this.store.db.prepare('INSERT OR REPLACE INTO investigation_attempts VALUES (?,?,?)').run(c.connection+':'+c.id,this.source(c).sourceFingerprint??String(c.updated),new Date().toISOString());c.run={id:'',issueId:c.id,state:'failed',startedAt:new Date().toISOString(),events:[],error:error instanceof AppError?error.message:'Investigation could not start.'};this.store.saveAlert(c);}
 async analyze(id:string,expected:{revision:number;sourceUpdated:number},claude:Claude,resume?:{prompt:string;parentRunId:string}){
  assertHandling(this.store,{connection:this.store.alert(id).connection,id});const run=await claude.start(id,expected,this,resume);
  const c=this.store.alert(id);c.autoAttempt=c.episodes;c.run=run;this.store.saveAlert(c);return run;
 }
 private syncRuns(claude:Claude){for(const c of this.store.alertCases())if(c.run?.state==='running'){
  c.run=claude.status(c.run.id);this.store.saveAlert(c);
 }}
 queue(claude?:Claude):AlertQueue{
  if(claude)this.syncRuns(claude);
  const s=this.store.snapshot();let connection:string|undefined;
  try{connection=this.context().connection;}catch{/* A locked vault exposes no stale cases as current. */}
  return {cases:connection?this.store.alertCases().filter(c=>c.connection===connection).map(c=>({...c,ignored:c.members.filter(m=>matchedRules(this.store,'alert',m.labels.alertname??c.title,m.labels).length).length,session:this.store.workSession(this.source(c))})).sort((a,b)=>Number(b.active)-Number(a.active)||b.updated-a.updated):[],
   enabled:s.config.connections.Alertmanager.enabled,paused:!s.vault.unlocked,pollSeconds:s.config.alerting.pollSeconds,
   lastSuccess:this.pollConnection===connection?this.lastSuccess:undefined,error:this.error,polling:!!this.pending};
 }
 async tick(claude:Claude,queue:AgentQueue){
  if(this.ticking)return;this.ticking=true;
  try{
   const s=this.store.snapshot();if(!s.config.connections.Alertmanager.enabled||!s.vault.unlocked)return;
   this.syncRuns(claude);
   if(Date.now()-this.lastAttempt>=s.config.alerting.pollSeconds*1000||this.attemptRevision!==s.configRevision||this.attemptEpoch!==this.store.credentialEpoch)await this.poll();
   if(!s.config.alerting.autoInvestigate||this.error)return;
   for(const c of this.queue().cases){
    if(!c.active||c.ticket){queue.close(c.connection,c.id);continue;}
    if(c.active&&!c.ticket&&!c.suppressed&&handling(this.store,{connection:c.connection,id:c.id}).mode==='investigate'&&!isIgnored(this.store,{connection:c.connection,id:c.id})&&!c.session.pendingRevision&&!c.session.approval&&this.store.db.prepare('SELECT fingerprint FROM investigation_attempts WHERE scope=?').get(c.connection+':'+c.id)?.fingerprint!==(this.source(c).sourceFingerprint??String(c.updated)))queue.offer({connection:c.connection,id:c.id,title:c.title,fingerprint:this.source(c).sourceFingerprint??String(c.updated)});
   }
  }catch{/* poll stores the safe error for the UI; next scheduled poll retries */}finally{this.ticking=false;}
 }
}

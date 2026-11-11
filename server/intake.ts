import {humanAttribution} from './identity.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Store,AppError} from './store.js';
import {sourceKind,ruleMatches,type Handling,type HandlingMode,type IgnoreRule} from '../src/intake-model.js';
import type {SourceIssue,AlertCase} from '../src/model.js';
export const handlingInput=z.object({connection:z.string().max(200).optional(),revision:z.number().int().positive(),sourceUpdated:z.number(),mode:z.enum(['ticket','investigate','reply','human','refused','done']),reason:z.string().trim().max(2000).default('')}).strict();
export const ignoreInput=z.object({revision:z.number().int().positive(),sourceUpdated:z.number(),reason:z.string().trim().min(1).max(2000),durationMinutes:z.number().int().min(1).max(43200).optional(),labels:z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),z.array(z.string().min(1).max(1000)).min(1).max(100)).refine(v=>Object.keys(v).length<=10)}).strict();
export function handling(store:Store,issue:Pick<SourceIssue,'connection'|'id'>):Handling{
 const saved=store.get<Handling>('handling:'+issue.connection+':'+issue.id);if(saved)return saved;
 const w=store.getWorkSession(issue.connection,issue.id),kind=sourceKind(issue.connection);
 const base={reason:'',revision:0,at:'',actor:'',history:[]};
 if(kind==='youtrack'||w?.plans.length)return {...base,mode:'investigate'};
 if(kind==='alert'){
  // Alerts without a decision follow Settings → Alertmanager → Default handling. The raw setting avoids a full config parse per alert.
  const choice=store.get<{alerting?:{defaultHandling?:string}}>('config')?.alerting?.defaultHandling;
  if(choice==='ticket'||choice==='investigate')return {...base,mode:choice};
  return {...base,mode:'pending',defaultIgnored:true};
 }
 return {...base,mode:'pending'};
}
export function assertHandling(store:Store,issue:Pick<SourceIssue,'connection'|'id'>,allowed:HandlingMode[]=['investigate']){
 const h=handling(store,issue);if(!allowed.includes(h.mode))throw new AppError(409,`This request is ${h.mode==='human'?'being handled by an engineer':h.mode==='refused'?'refused':h.mode==='done'?'resolved locally':'waiting for an intake decision'}. Return it to the agent before continuing.`);
 if(isIgnored(store,issue))throw new AppError(409,'This request matches an active ignore rule. Remove the rule or wait for it to expire before continuing.');
}
/** Stored case of an alert or Slack request. Undefined for YouTrack tickets and unknown cases. */
function storedCase(store:Store,issue:Pick<SourceIssue,'connection'|'id'>){const kind=sourceKind(issue.connection);return kind==='alert'?store.alertCases().find(c=>c.id===issue.id):kind==='slack'?store.get<AlertCase>('slack:'+issue.id):undefined;}
export function assertAgentWork(store:Store,issue:Pick<SourceIssue,'connection'|'id'>){assertHandling(store,issue);if(storedCase(store,issue)?.ticket)throw new AppError(409,'Continue agent work in the linked YouTrack ticket.');}
export function rules(store:Store){return store.get<IgnoreRule[]>('ignoreRules')??[];}
export function matchedRules(store:Store,source:'alert'|'slack',kind:string,labels:Record<string,string>){const endpoint=store.snapshot().config.connections[source==='alert'?'Alertmanager':'Slack'].endpoint.replace(/\/+$/,'');return rules(store).filter(r=>ruleMatches(r,source,endpoint,kind,labels));}
export function isIgnored(store:Store,issue:Pick<SourceIssue,'connection'|'id'>){
 const kind=sourceKind(issue.connection);if(kind==='alert'){let c:AlertCase|undefined;try{c=store.alert(issue.id);}catch{c=undefined;}return !!c?.members.length&&c.members.every(m=>matchedRules(store,'alert',m.labels.alertname??c.title,m.labels).length>0);}
 if(kind==='slack'){const c=store.get<AlertCase>('slack:'+issue.id);return !!c&&matchedRules(store,'slack',c.threadTs!,{channel:c.channel!}).length>0;}return false;
}
export function setHandling(store:Store,issue:SourceIssue,input:z.infer<typeof handlingInput>){
 if(!store.key)throw new AppError(423,'Unlock the Vault first.');
 return store.transaction(()=>{const w=store.workSession(issue);if(w.revision!==input.revision||issue.updated!==input.sourceUpdated)throw new AppError(409,'Request changed. Refresh before choosing who handles it.');
 const kind=sourceKind(issue.connection);if(kind==='youtrack'&&['ticket','reply'].includes(input.mode))throw new AppError(400,'YouTrack requests already have a ticket.');
 if(['human','refused','done'].includes(input.mode)&&!input.reason)throw new AppError(400,'Add a reason so the next engineer can follow the decision.');
 const c=kind==='alert'?store.alert(issue.id):kind==='slack'?store.get<AlertCase>('slack:'+issue.id):null;
 if(c?.ticketCreation?.state==='pending'&&!['human','refused'].includes(input.mode))throw new AppError(409,'Check the pending ticket creation before changing intake.');
 if(c?.ticket&&['investigate','reply'].includes(input.mode))throw new AppError(409,'Continue in the linked YouTrack ticket.');
 if(kind==='alert'&&input.mode==='reply')throw new AppError(400,'Alertmanager has no reply channel. Investigate or record a local resolution.');
 const old=handling(store,issue),event={mode:input.mode,reason:input.reason,at:new Date().toISOString(),...humanAttribution(store)};
 const next:Handling={...event,revision:old.revision+1,history:[...old.history,event].slice(-100)};
 store.put('handling:'+issue.connection+':'+issue.id,next);w.approval=null;w.revision++;w.updatedAt=event.at;store.saveWorkSession(w);
 store.db.prepare('DELETE FROM investigation_attempts WHERE scope=?').run(issue.connection+':'+issue.id);
 if(kind==='alert'&&c){c.autoAttempt=undefined;store.saveAlert(c);}if(kind==='slack')store.put('slackAttempt:'+issue.id,null);return {...next};});
}
export function addIgnore(store:Store,issue:SourceIssue,input:z.infer<typeof ignoreInput>){
 if(!store.key)throw new AppError(423,'Unlock the Vault first.');const source=sourceKind(issue.connection);if(source==='youtrack')throw new AppError(400,'Use Refuse or Take over for tickets.');
 const w=store.workSession(issue);if(w.revision!==input.revision||issue.updated!==input.sourceUpdated)throw new AppError(409,'Request changed. Refresh before adding a rule.');
 const c=source==='alert'?store.alert(issue.id):store.get<AlertCase>('slack:'+issue.id);
 if(c?.ticketCreation?.state==='pending')throw new AppError(409,'Check pending ticket creation first.');
 if(!c)throw new AppError(404,'Source case not found.');
 const kind=source==='alert'?c.title:c.threadTs!;
 if(source==='slack'&&(Object.keys(input.labels).length!==1||input.labels.channel?.length!==1||input.labels.channel[0]!==c.channel))throw new AppError(400,'Slack ignore rules must target this channel and thread.');
 if(source==='alert')for(const [label,values] of Object.entries(input.labels)){if(!c.members.some((m)=>values.includes(m.labels[label])))throw new AppError(400,`Selected ${label} values do not include any instance in this case.`);}
 const r:IgnoreRule={id:randomUUID(),source,endpoint:store.snapshot().config.connections[source==='alert'?'Alertmanager':'Slack'].endpoint.replace(/\/+$/,''),kind,labels:input.labels,reason:input.reason,createdAt:new Date().toISOString(),...humanAttribution(store),...(input.durationMinutes?{expiresAt:new Date(Date.now()+input.durationMinutes*60000).toISOString()}: {})};
 store.transaction(()=>{store.put('ignoreRules',[...rules(store),r]);invalidateSource(store,source);});return r;
}
export function invalidateSource(store:Store,source:'alert'|'slack'){
 for(const row of store.db.prepare('SELECT value FROM work_sessions').all() as {value:string}[]){const w=JSON.parse(row.value);if(sourceKind(w.connection)!==source)continue;w.approval=null;w.revision++;w.sourceChangedAt=new Date().toISOString();w.updatedAt=w.sourceChangedAt;store.saveWorkSession(w);store.db.prepare('DELETE FROM investigation_attempts WHERE scope=?').run(w.connection+':'+w.issueId);}
}
export function removeIgnore(store:Store,id:string){if(!store.key)throw new AppError(423,'Unlock the Vault first.');const r=rules(store).find(r=>r.id===id);if(!r)throw new AppError(404,'Ignore rule not found.');store.transaction(()=>{store.put('ignoreRules',rules(store).filter(r=>r.id!==id));invalidateSource(store,r.source);});}

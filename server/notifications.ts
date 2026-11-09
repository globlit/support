import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Store,AppError} from './store.js';
import type {AIWorkflow} from '../src/ai-model.js';
import {routeHash} from '../src/navigation.js';
import {workflowStep} from '../src/workflow-step.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const reviewStages=new Set(['Request review','Plan approval','Diff approval','Fix approval','Summary approval','Closure approval','Diagnosis review','Ticket approval','Reply approval','Intake decision','Direct reply']);
type Kind='reviews'|'blocked'|'reopened'|'completion'|'test';
type Source='youtrack'|'alert'|'slack';
type Event={id:string;seq:number;at:number;kind:Kind;workflow?:string;signature?:string;key?:string;title?:string;stage?:string;source?:Source;route:string};
type History={seq:number;seen:Record<string,{signature:string;state:string;at:number}>;events:Event[]};
const text:Record<Kind,[string,string]>={reviews:['Review ready','Open Support to review the next step.'],blocked:['Work needs attention','Open Support to check what is blocking progress.'],reopened:['Work reopened','Open Support to review the updated request.'],completion:['Work completed','Open Support to view the result.'],test:['Support notifications work','Notifications from Support can reach this browser.']};
/** Notification titles for workflow stages that wait for a review. */
const reviewTitles:Record<string,string>={'Request review':'Request ready for review','Plan approval':'Plan ready for approval','Diff approval':'Code changes ready for review','Fix approval':'Fix ready for review','Summary approval':'Resolution summary ready for review','Closure approval':'Ticket closure ready for review','Diagnosis review':'Diagnosis ready for review','Ticket approval':'Ticket draft ready for approval','Reply approval':'Reply ready for approval','Intake decision':'New request needs a decision','Direct reply':'Reply ready for approval'};
const sourceLabels:Record<Source,string>={youtrack:'YouTrack ticket',alert:'Alert',slack:'Slack request'};
/** Returns a one-line ticket title of at most 100 characters. */
const shortTitle=(value:string)=>{const line=value.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();return line.length>100?line.slice(0,99)+'…':line;};
function message(e:Event,hideReferences:boolean){
 const title=e.kind==='reviews'&&e.stage&&reviewTitles[e.stage]?reviewTitles[e.stage]:e.kind==='blocked'&&e.stage?`Work stopped at ${e.stage}`:text[e.kind][0];
 const action=e.kind==='blocked'&&e.stage?'Open Support to check what is blocking progress.':text[e.kind][1];
 const origin=e.source?sourceLabels[e.source]+' · ':'';
 const reference=!hideReferences&&e.key?[e.key,e.title].filter(Boolean).join(' · ')+'\n':'';
 return {title,body:reference+origin+action};
}
const pageSize=20;
export const notificationQuery=z.object({after:z.coerce.number().int().min(0).optional()}).strict();
export type NotificationPage={seq:number;paused:boolean;reason?:string;events:{id:string;seq:number;at:number;title:string;body:string;route:string}[]};

/** Detects workflow changes that need attention and serves them to signed-in browsers. */
export class Notifications {
 private queueError:string|null=null;
 constructor(private store:Store,private workflows:()=>AIWorkflow[],private clock=Date.now){}
 private unlocked(){if(!this.store.key)throw new AppError(423,'Unlock the Vault to receive notifications.');return this.store.key;}
 private history():History{const value=this.store.get<string>('notifications.history');return value?JSON.parse(this.store.decrypt(value,this.unlocked())):{seq:0,seen:{},events:[]};}
 private saveHistory(h:History){this.store.put('notifications.history',this.store.encrypt(JSON.stringify(h),this.unlocked()));}
 tick(){
  if(!this.store.key)return;
  try{this.capture();this.queueError=null;}catch{this.queueError='Notifications could not be prepared. Delivery is paused while Support retries.';}
 }
 capture(){
  if(!this.store.key)return;
  const h=this.history(),before=JSON.stringify(h),now=this.clock(),prefs=this.store.snapshot().config.notifications,cutoff=now-this.store.snapshot().config.retentionDays*86400000;
  const current=new Set<string>();
  const hadBaseline=this.store.get<boolean>('notifications.baseline')??false;
  for(const w of this.workflows()){
   current.add(w.id);const prior=h.seen[w.id];
   const signature=hash(JSON.stringify([w.state,w.stage,w.latestRun,w.updatedAt,w.disposition]));
   if(prior?.signature!==signature&&hadBaseline&&!w.disposition){
    const kind:Kind|undefined=w.stage==='Ticket reopened'||(prior?.state==='completed'&&!['completed','stopped'].includes(w.state))?'reopened':w.state==='blocked'?'blocked':w.state==='completed'?'completion':w.state==='waiting'&&reviewStages.has(w.stage)?'reviews':undefined;
    // Alerts waiting for a handling decision never notify. Handled alerts notify like YouTrack tickets.
    if(kind&&prefs[kind]&&!(w.source==='alert'&&w.stage==='Intake decision')){
     // Keep only well-formed ticket keys. Keys and titles reach the browser only when previews are allowed.
     const key=/^(?:[A-Z][A-Z0-9_]{0,15}-\d{1,10}|ALERT-[a-f0-9]{8}|SLACK-[a-f0-9]{8})$/.test(w.key)?w.key:undefined;
     const route=routeHash({page:w.source==='alert'?'alerts':w.source==='slack'?'slack':'youtrack',issue:w.issueId,connection:w.connection,step:workflowStep(w.stage)});
     const title=w.title?shortTitle(w.title):undefined;
     h.events.push({id:randomUUID(),seq:++h.seq,at:now,kind,workflow:w.id,signature,key,title,stage:w.stage,source:w.source==='alert'?'alert':w.source==='slack'?'slack':'youtrack',route});
    }
   }
   if(prior?.signature!==signature)h.seen[w.id]={signature,state:w.state,at:now};
  }
  for(const [id,s] of Object.entries(h.seen))if(!current.has(id)&&s.at<cutoff)delete h.seen[id];
  // Retire expired, disabled and superseded notifications.
  h.events=h.events.filter(e=>e.at>=cutoff&&(e.kind==='test'||prefs[e.kind])&&(!e.workflow||(current.has(e.workflow)&&h.seen[e.workflow]?.signature===e.signature))).slice(-500);
  if(JSON.stringify(h)!==before)this.saveHistory(h);if(!hadBaseline)this.store.put('notifications.baseline',true);
 }
 /**
  * Returns up to 20 notifications with a sequence number above `after`, oldest first.
  * Without `after`, or when `after` is above the latest sequence number, returns no events and the latest sequence number.
  * `seq` in the result is the value to send as `after` in the next call.
  */
 list(after?:number):NotificationPage{
  this.unlocked();
  const h=this.history();
  if(after===undefined||after>h.seq)return {seq:h.seq,paused:false,events:[]};
  if(this.queueError)return {seq:after,paused:true,reason:this.queueError,events:[]};
  const prefs=this.store.snapshot().config.notifications,cutoff=this.clock()-this.store.snapshot().config.retentionDays*86400000;
  const pending=h.events.filter(e=>e.seq>after&&e.at>=cutoff&&(e.kind==='test'||prefs[e.kind])).slice(0,pageSize);
  const seq=pending.length===pageSize?pending[pageSize-1].seq:h.seq;
  return {seq,paused:false,events:pending.map(e=>({id:e.id,seq:e.seq,at:e.at,...message(e,prefs.privatePreview),route:e.route}))};
 }
 /** Adds a test notification. Rejects a second test within 10 seconds. */
 test(){
  this.unlocked();const h=this.history(),now=this.clock();
  if(h.events.some(e=>e.kind==='test'&&now-e.at<10000))throw new AppError(429,'Wait a few seconds before sending another test.');
  h.events.push({id:randomUUID(),seq:++h.seq,at:now,kind:'test',route:'#/settings?section=Notifications'});h.events=h.events.slice(-500);this.saveHistory(h);return {queued:true};
 }
}

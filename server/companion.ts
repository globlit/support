import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {Store,AppError} from './store.js';
import type {AIWorkflow} from '../src/ai-model.js';
import {routeHash} from '../src/navigation.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const matches=(value:string,digest:string)=>timingSafeEqual(Buffer.from(hash(value),'hex'),Buffer.from(digest,'hex'));
const secret=()=>randomBytes(32).toString('base64url');
const reviewStages=new Set(['Request review','Plan approval','Diff approval','Fix approval','Summary approval','Closure approval','Diagnosis review','Ticket approval','Reply approval','Intake decision','Direct reply']);
type Kind='reviews'|'blocked'|'reopened'|'completion'|'test';
type Device={id:string;name:string;hash:string;createdAt:number;lastSeen?:number;lastAck?:number;startSeq:number;acked:string[];offered:string[]};
type Event={id:string;seq:number;at:number;kind:Kind;workflow?:string;signature?:string;key?:string;route:string;device?:string};
type History={seq:number;seen:Record<string,{signature:string;state:string;at:number}>;events:Event[]};
const text:Record<Kind,[string,string]>={reviews:['Review ready','Open Support to review the next step.'],blocked:['Work needs attention','Open Support to check what is blocking progress.'],reopened:['Work reopened','Open Support to review the updated request.'],completion:['Work completed','Open Support to view the result.'],test:['Support is connected','Notifications from your workspace can reach this Mac.']};
export const pairInput=z.object({code:z.string().regex(/^[A-Za-z0-9_-]{43}$/),name:z.string().trim().min(1).max(60).regex(/^[^\x00-\x1f\x7f]+$/)}).strict();
export const ackInput=z.object({ids:z.array(z.string().uuid()).min(1).max(20)}).strict();
/** Native credentials work on delivery endpoints only. */
export function companionScope(path:string,authorization:string|undefined){
 if(authorization&&!['/api/companion/events','/api/companion/ack'].includes(path))throw new AppError(403,'Companion credentials only allow notification delivery.');
}
export class Companion {
 private attempts={at:0,count:0};
 private queueError:string|null=null;
 constructor(private store:Store,private workflows:()=>AIWorkflow[],private clock=Date.now){}
 private unlocked(){if(!this.store.key)throw new AppError(423,'Unlock the Vault to manage Mac notifications.');return this.store.key;}
 private devices(){return this.store.get<Device[]>('companion.devices')??[];}
 private saveDevices(devices:Device[]){this.store.put('companion.devices',devices);}
 private history():History{const value=this.store.get<string>('companion.history');return value?JSON.parse(this.store.decrypt(value,this.unlocked())):{seq:0,seen:{},events:[]};}
 private saveHistory(h:History){this.store.put('companion.history',this.store.encrypt(JSON.stringify(h),this.unlocked()));}
 status(){
  this.unlocked();const now=this.clock(),pair=this.store.get<{expiresAt:number}>('companion.pairing');
  return {queueError:this.queueError,devices:this.devices().map(({id,name,createdAt,lastSeen,lastAck})=>({id,name,createdAt,lastSeen,lastAck,connected:!!lastSeen&&now-lastSeen<30000})),pairingExpiresAt:pair&&pair.expiresAt>now?pair.expiresAt:null};
 }
 begin(){
  this.unlocked();if(this.devices().length>=5)throw new AppError(409,'Remove a paired Mac before adding another (maximum 5).');
  const code=secret(),expiresAt=this.clock()+300000;this.store.put('companion.pairing',{hash:hash(code),expiresAt});return {code,expiresAt};
 }
 cancel(){this.unlocked();this.store.put('companion.pairing',null);return this.status();}
 pair(input:z.infer<typeof pairInput>){
  this.unlocked();const now=this.clock();if(now-this.attempts.at>=60000)this.attempts={at:now,count:0};
  if(++this.attempts.count>10)throw new AppError(429,'Too many pairing attempts. Wait a minute.');
  const pending=this.store.get<{hash:string;expiresAt:number}>('companion.pairing');
  if(!pending||now>=pending.expiresAt||!matches(input.code,pending.hash))throw new AppError(401,'Pairing code expired or invalid. Generate a new code in Support.');
  const devices=this.devices();if(devices.length>=5)throw new AppError(409,'Maximum paired Macs reached.');
  // Set a baseline so a new Mac receives no old work.
  this.capture();const token=secret(),id=randomUUID(),h=this.history();
  this.store.transaction(()=>{devices.push({id,name:input.name,hash:hash(token),createdAt:now,startSeq:h.seq,acked:[],offered:[]});this.saveDevices(devices);this.store.put('companion.pairing',null);});
  return {id,token};
 }
 revoke(id:string){this.unlocked();const devices=this.devices().filter(d=>d.id!==id);this.store.transaction(()=>{this.saveDevices(devices);if(!devices.length){this.store.put('companion.history',null);this.store.put('companion.baseline',false);this.queueError=null;}});return this.status();}
 private auth(authorization:string|undefined){
  const value=authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const devices=this.devices(),device=value?devices.find(d=>matches(value,d.hash)):undefined;
  if(!device)throw new AppError(401,'Pair this Mac in Support Settings → Notifications.');
  return {devices,device};
 }
 tick(){
  if(!this.store.key||!this.devices().length)return;
  try{this.capture();this.queueError=null;}catch{this.queueError='Notifications could not be prepared. Delivery is paused while Support retries.';}
 }
 capture(){
  if(!this.store.key)return;
  const h=this.history(),before=JSON.stringify(h),now=this.clock(),prefs=this.store.snapshot().config.notifications,cutoff=now-this.store.snapshot().config.retentionDays*86400000;
  const current=new Set<string>();
  const hadBaseline=this.store.get<boolean>('companion.baseline')??false;
  for(const w of this.workflows()){
   current.add(w.id);const prior=h.seen[w.id];
   const signature=hash(JSON.stringify([w.state,w.stage,w.latestRun,w.updatedAt,w.disposition]));
   if(prior?.signature!==signature&&hadBaseline&&!w.disposition){
    const kind:Kind|undefined=w.stage==='Ticket reopened'||(prior?.state==='completed'&&!['completed','stopped'].includes(w.state))?'reopened':w.state==='blocked'?'blocked':w.state==='completed'?'completion':w.state==='waiting'&&reviewStages.has(w.stage)?'reviews':undefined;
    if(kind&&this.store.snapshot().config.notifications[kind]){
     // Send the source key only.
     const key=/^(?:[A-Z][A-Z0-9_]{0,15}-\d{1,10}|ALERT-[a-f0-9]{8}|SLACK-[a-f0-9]{8})$/.test(w.key)?w.key:undefined;
     const route=routeHash({page:w.source==='alert'?'alerts':w.source==='slack'?'slack':'youtrack',issue:w.issueId,connection:w.connection});
     h.events.push({id:randomUUID(),seq:++h.seq,at:now,kind,workflow:w.id,signature,key,route});
    }
   }
   if(prior?.signature!==signature)h.seen[w.id]={signature,state:w.state,at:now};
  }
  for(const [id,s] of Object.entries(h.seen))if(!current.has(id)&&s.at<cutoff)delete h.seen[id];
  h.events=h.events.filter(e=>e.at>=cutoff&&(e.kind==='test'||prefs[e.kind])&&(!e.workflow||(current.has(e.workflow)&&h.seen[e.workflow]?.signature===e.signature))).slice(-500);
  const valid=new Set(h.events.map(e=>e.id));
  const devices=this.devices();for(const d of devices){d.acked=d.acked.filter(id=>valid.has(id));d.offered=d.offered.filter(id=>valid.has(id));}
  if(JSON.stringify(devices)!==JSON.stringify(this.devices()))this.saveDevices(devices);if(JSON.stringify(h)!==before)this.saveHistory(h);if(!hadBaseline)this.store.put('companion.baseline',true);
 }
 poll(authorization:string|undefined){
  const {devices,device}=this.auth(authorization);device.lastSeen=this.clock();
  if(!this.store.key||this.queueError){this.saveDevices(devices);return this.store.key?{paused:true,reason:this.queueError,events:[]}:{paused:true,events:[]};}
  const prefs=this.store.snapshot().config.notifications,h=this.history();
  // Retire disabled or superseded notifications.
  const pending=h.events.filter(e=>e.at>=this.clock()-this.store.snapshot().config.retentionDays*86400000&&e.seq>device.startSeq&&(!e.device||e.device===device.id)&&!device.acked.includes(e.id));
  for(const e of pending)if(e.kind!=='test'&&!prefs[e.kind])device.acked.push(e.id);
  const events=pending.filter(e=>!device.acked.includes(e.id)).slice(0,20);
  device.offered=[...new Set([...device.offered,...events.map(e=>e.id)])].slice(-500);this.saveDevices(devices);
  return {paused:false,events:events.map(e=>({id:e.id,at:e.at,title:text[e.kind][0],body:!prefs.privatePreview&&e.key?`${e.key} · ${text[e.kind][1]}`:text[e.kind][1],route:e.route}))};
 }
 ack(authorization:string|undefined,ids:string[]){
  const {devices,device}=this.auth(authorization);
  if(ids.some(id=>!device.offered.includes(id)&&!device.acked.includes(id)))throw new AppError(409,'Only delivered notifications can be acknowledged.');
  device.acked=[...new Set([...device.acked,...ids])].slice(-500);device.offered=device.offered.filter(id=>!ids.includes(id));device.lastAck=this.clock();this.saveDevices(devices);return {ok:true};
 }
 test(id:string){
  this.unlocked();if(!this.devices().some(d=>d.id===id))throw new AppError(404,'Paired Mac not found.');
  const h=this.history();if(h.events.some(e=>e.kind==='test'&&e.device===id&&this.clock()-e.at<10000))throw new AppError(429,'Wait a few seconds before sending another test.');
  h.events.push({id:randomUUID(),seq:++h.seq,at:this.clock(),kind:'test',route:'#/settings?section=Notifications',device:id});h.events=h.events.slice(-500);this.saveHistory(h);return {queued:true};
 }
}

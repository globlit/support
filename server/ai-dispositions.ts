import {humanAttribution} from './identity.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Store,AppError} from './store.js';
import type {AIOverview,AIWorkflow,AIRunSummary,AIDisposition} from '../src/ai-model.js';
export const dispositionInput=z.object({action:z.enum(['resolved','dropped','restore']),targets:z.array(z.object({kind:z.enum(['workflow','run']),id:z.string().min(1).max(300),signature:z.string().length(64)}).strict()).min(1).max(200)}).strict();
export function decorateDispositions(store:Store,overview:AIOverview){
 for(const [kind,items] of [['workflow',overview.workflows],['run',overview.runs]] as const)for(const item of items){
  item.signature=createHash('sha256').update(JSON.stringify([item.id,item.state,item.updatedAt,'latestRun' in item?item.latestRun:null,'reason' in item?item.reason:item.step])).digest('hex');
  const row=store.db.prepare('SELECT action,at,actor FROM ai_dispositions WHERE kind=? AND id=? AND signature=?').get(kind,item.id,item.signature) as AIDisposition|undefined;
  if(row&&item.state==='blocked')item.disposition=row;
 }
 return overview;
}
export function updateDispositions(store:Store,overview:AIOverview,input:z.infer<typeof dispositionInput>){
 if(!store.key)throw new AppError(423,'Unlock the Vault first.');
 const targets=dispositionInput.parse(input);
 store.transaction(()=>{
  const items: {kind:string;item:AIWorkflow|AIRunSummary}[]=[];
  for(const target of targets.targets){
   const item=(target.kind==='workflow'?overview.workflows:overview.runs).find(i=>i.id===target.id);
   if(!item||item.signature!==target.signature||item.state!=='blocked'||(targets.action==='restore'?!item.disposition:!!item.disposition))throw new AppError(409,'Activity changed. Refresh and select the blocked items again.');
   items.push({kind:target.kind,item});
  }
  const at=new Date().toISOString(),actor=humanAttribution(store).actorId;
  for(const {kind,item} of items){
   if(targets.action==='restore')store.db.prepare('DELETE FROM ai_dispositions WHERE kind=? AND id=?').run(kind,item.id);
   else store.db.prepare('INSERT OR REPLACE INTO ai_dispositions VALUES (?,?,?,?,?,?)').run(kind,item.id,item.signature!,targets.action,at,actor);
  }
 });
}

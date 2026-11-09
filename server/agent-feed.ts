import {EventEmitter} from 'node:events';
import type {Store} from './store.js';
import {AppError} from './store.js';

export type FeedKind='run-start'|'step'|'tool'|'command'|'output'|'result'|'error'|'run-end';
export type FeedRoute={page:string;issue:string};
export type FeedEntry={seq:number;at:string;runId:string;title:string;route?:FeedRoute;kind:FeedKind;text:string};
export type RunningAgent={runId:string;title:string;route:FeedRoute;startedAt:string;lastStep:string};
const entryLimit=2000,textLimit=4000;

/**
 * Live record of what the agent does. Keeps the last 2,000 entries in memory and emits 'entry' for each new entry
 * and 'state' when runs start, end or the agent is stopped. Nothing is persisted: the investigation history is the record.
 */
export class AgentFeed extends EventEmitter {
 private entries:FeedEntry[]=[];private seq=0;readonly running=new Map<string,RunningAgent>();
 constructor(){super();this.setMaxListeners(100);}
 /** Adds an entry. Text longer than 4,000 characters is cut. */
 publish(runId:string,kind:FeedKind,text:string){
  const run=this.running.get(runId);
  const entry:FeedEntry={seq:++this.seq,at:new Date().toISOString(),runId,title:run?.title??runId,route:run?.route,kind,text:text.length>textLimit?text.slice(0,textLimit)+'…':text};
  this.entries.push(entry);if(this.entries.length>entryLimit)this.entries.splice(0,this.entries.length-entryLimit);
  if(run&&kind!=='output')run.lastStep=entry.text.split('\n')[0].slice(0,200);
  this.emit('entry',entry);
 }
 start(run:Omit<RunningAgent,'lastStep'>){this.running.set(run.runId,{...run,lastStep:'Starting'});this.publish(run.runId,'run-start',`Started: ${run.title}`);this.emit('state');}
 end(runId:string,text:string){if(!this.running.has(runId))return;this.publish(runId,'run-end',text);this.running.delete(runId);this.emit('state');}
 /** Entries after `after`, or the last `limit` entries when `after` is undefined or older than the buffer. */
 since(after?:number,limit=300){const i=after===undefined?-1:this.entries.findIndex(e=>e.seq>after);return after!==undefined&&i>=0?this.entries.slice(i):after!==undefined&&this.entries.at(-1)?.seq===after?[]:this.entries.slice(-limit);}
}
export const agentFeed=new AgentFeed();

const haltKey='agentHalted';
/** True when the kill switch is on. The value is stored, so a restart keeps the agent stopped. */
export function agentHalted(store:Store){return store.get<boolean>(haltKey)===true;}
export function setAgentHalted(store:Store,halted:boolean){store.put(haltKey,halted);agentFeed.emit('state');}
/** Throws 423 when the kill switch is on. */
export function assertAgentRunning(store:Store){if(agentHalted(store))throw new AppError(423,'The agent is stopped. Resume it in the agent console.');}

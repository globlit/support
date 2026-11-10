import type {Store} from '../server/store.js';
import type {Claude} from '../server/claude.js';
import {AgentQueue,type QueueAdapter} from '../server/agent-queue.js';
import type {SourceKind} from '../src/intake-model.js';

/** Agent queue connected to `agent` the way server/index.ts connects it. */
export function wireQueue(store:Store,agent:Claude,adapters:Partial<Record<SourceKind,QueueAdapter>>,now?:()=>number){
 const queue=new AgentQueue(store,id=>agent.isActive(id),now);
 agent.onRun({started:r=>queue.started(r),finished:(id,state,error)=>queue.finished(id,state,error)});
 for(const [kind,adapter] of Object.entries(adapters))queue.register(kind as SourceKind,adapter);
 return queue;
}

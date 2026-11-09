import type {Store} from './store.js';
import {connectionNames,type ConnectionName} from '../src/model.js';
import type {ToolHealth} from '../src/telemetry-model.js';
export const healthIntervalMs=60_000;
export const healthTimeouts:Record<ConnectionName,number>={Alertmanager:3000,Prometheus:5000,YouTrack:8000,GitLab:10000,Outline:8000,Slack:5000,Toolbox:15000,Model:12000};
export type HealthResult={ok:boolean;detail:string;code?:number};
type Observation={result:HealthResult;failures:number;at:string;revision:number;epoch:number;durationMs:number};
const observations=new WeakMap<Store,Map<ConnectionName,Observation>>();
export function recordHealthProbe(store:Store,name:ConnectionName,result:HealthResult,durationMs=0,now=Date.now()){
 if(!store.key)return;
 let map=observations.get(store);if(!map){map=new Map();observations.set(store,map)}
 const revision=store.snapshot().configRevision,epoch=store.credentialEpoch,old=map.get(name);
 const failures=result.ok?0:(old?.revision===revision&&old.epoch===epoch?old.failures:0)+1;
 map.set(name,{result,failures,at:new Date(now).toISOString(),revision,epoch,durationMs});
}
export function toolHealth(store:Store,now=Date.now()):ToolHealth[]{
 const snapshot=store.snapshot();return connectionNames.map(name=>{
  const base={name,intervalSeconds:healthIntervalMs/1000,timeoutSeconds:healthTimeouts[name]/1000};
  if(!snapshot.config.connections[name].enabled)return {...base,state:'off',label:'Disabled',detail:'This connection is disabled in Settings.'};
  if(!store.key)return {...base,state:'yellow',label:'Paused',detail:'Unlock the Vault to resume scheduled checks.'};
  const o=observations.get(store)?.get(name);
  if(!o||o.revision!==snapshot.configRevision||o.epoch!==store.credentialEpoch)return {...base,state:'yellow',label:'Checking',detail:'Waiting for the first scheduled check.'};
  const common={...base,at:o.at,failures:o.failures,durationMs:o.durationMs};
  if(o.failures)return {...common,state:o.failures>=2?'red':'yellow',label:o.failures>=2?'Failed':'Stale',detail:`${o.failures} consecutive failed check${o.failures===1?'':'s'}. ${o.result.detail}`};
  if(now-Date.parse(o.at)>healthIntervalMs+healthTimeouts[name]+10000)return {...common,state:'yellow',label:'Stale',detail:'The next scheduled check is overdue. '+o.result.detail};
  return {...common,state:'green',label:name==='Toolbox'||snapshot.config.modelAuth==='claude_cli'&&name==='Model'?'Local tool ready':'Reachable',detail:o.result.detail};
 });
}

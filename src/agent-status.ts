import type {ToolHealth} from './telemetry-model';
export type AgentStatusInput={halted:boolean;sandbox:{configured:boolean;reachable:boolean;lastOkAt?:string};model?:{lastOkAt?:string;lastError?:string;limit?:{at:string;resetAt?:string}};modelHealth?:ToolHealth;gateway?:{listening:boolean};kubernetes?:ToolHealth};
export type AgentCard={key:'agent'|'model'|'sandbox'|'gateway'|'kubernetes';title:string;tone:'green'|'yellow'|'red'|'off';text:string;detail?:string;resume?:boolean};
const time=(at:string)=>new Date(at).toLocaleString();
/** Builds one status card per component the agent depends on. */
export function agentCards(s:AgentStatusInput,now=Date.now()):AgentCard[]{
 const limit=s.model?.limit,limited=!!limit&&(!limit.resetAt||Date.parse(limit.resetAt)>now);
 const model:AgentCard=limited?{key:'model',title:'Model',tone:'yellow',text:'Usage limit',detail:limit!.resetAt?`Resets ${time(limit!.resetAt)}`:'Reset time not reported'}
  :s.modelHealth&&s.modelHealth.state!=='green'&&s.modelHealth.state!=='off'?{key:'model',title:'Model',tone:s.modelHealth.state,text:s.modelHealth.label,detail:s.modelHealth.detail}
  :s.model?.lastError?{key:'model',title:'Model',tone:'yellow',text:'Last run failed',detail:s.model.lastError}
  :{key:'model',title:'Model',tone:'green',text:'Reachable',detail:s.model?.lastOkAt?`Last run succeeded ${time(s.model.lastOkAt)}`:undefined};
 const k=s.kubernetes;
 return [
  s.halted?{key:'agent',title:'Agent',tone:'red',text:'Stopped by Stop all',resume:true}:{key:'agent',title:'Agent',tone:'green',text:'Running'},
  model,
  !s.sandbox.configured?{key:'sandbox',title:'Sandbox',tone:'red',text:'Not configured',detail:'SUPPORT_SANDBOX_URL is missing.'}:s.sandbox.reachable?{key:'sandbox',title:'Sandbox',tone:'green',text:'Reachable'}:{key:'sandbox',title:'Sandbox',tone:'red',text:'Unreachable',detail:s.sandbox.lastOkAt?`Last answered ${time(s.sandbox.lastOkAt)}`:'No answer since Support started.'},
  s.gateway?.listening?{key:'gateway',title:'Gateway',tone:'green',text:'Listening'}:{key:'gateway',title:'Gateway',tone:'red',text:'Not started',detail:'SUPPORT_RELAY_BIND is missing.'},
  !k||k.state==='off'?{key:'kubernetes',title:'Kubernetes',tone:'off',text:'Disabled'}:{key:'kubernetes',title:'Kubernetes',tone:k.state,text:k.label,detail:k.detail},
 ];
}

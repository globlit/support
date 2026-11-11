import {agentCards,type AgentStatusInput} from './agent-status';
/** Status strip of the components the agent depends on. */
export function AgentStatus({state,onResume,busy}:{state:AgentStatusInput|null;onResume:()=>void;busy:boolean}){
 if(!state)return <div className="agent-status" aria-busy="true"><p className="muted">Loading agent status…</p></div>;
 return <ul className="agent-status" aria-label="Agent status">{agentCards(state).map(c=><li key={c.key} className={'agent-card '+c.tone}><span className="agent-card-title"><i aria-hidden="true"/>{c.title}</span><strong>{c.text}</strong>{c.detail&&<small title={c.detail}>{c.detail}</small>}{c.resume&&<button className="text-button" disabled={busy} onClick={onResume}>Resume</button>}</li>)}</ul>;
}

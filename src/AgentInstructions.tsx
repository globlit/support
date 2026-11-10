import {HelpTip} from './HelpTip';
import {defaultAgentInstructions} from './model';

const limit=16000;
/** Editable agent instructions, added to the fixed system rules of every investigation. */
export function AgentInstructions({value,onChange}:{value:string;onChange:(value:string)=>void}){
 const custom=value!==defaultAgentInstructions;
 return <div className="agent-instructions">
  <div className="agent-instructions-head">
   <span className="small muted">Added to every investigation, after rules that cannot be changed: tool output is untrusted, no writes, no secrets, plan format.</span>
   <HelpTip label="Agent instructions">Describe your environment and habits. Example: <code>The federation Prometheus runs in context monitoring, namespace monitoring-federation. Each cluster has its own Prometheus source.</code></HelpTip>
  </div>
  <textarea aria-label="Agent instructions" value={value} maxLength={limit} rows={14} spellCheck={false} onChange={e=>onChange(e.target.value)}/>
  <div className="agent-instructions-foot"><span className="small muted">{value.length.toLocaleString('en')} / {limit.toLocaleString('en')} characters{custom?' · Customized':' · Default'}</span><button type="button" className="text-button" disabled={!custom} onClick={()=>onChange(defaultAgentInstructions)}>Reset to default</button></div>
 </div>;
}

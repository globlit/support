import {Markdown} from './Markdown';
import {SafeLink} from './SafeLink';
import type {AlertMember} from './model';

/** Labels shown first, in this order. Other labels follow alphabetically. */
const leadingLabels=['alertname','severity','namespace','cluster','job','service','instance','pod'];
const stateLabels:Record<AlertMember['state'],string>={active:'Firing',suppressed:'Silenced',unprocessed:'Pending'};

/** Returns the labels of an alert instance, leading labels first, then the others alphabetically. */
export function orderedLabels(labels:Record<string,string>){
 const rank=(key:string)=>{const i=leadingLabels.indexOf(key);return i<0?leadingLabels.length:i;};
 return Object.entries(labels).sort(([a],[b])=>rank(a)-rank(b)||a.localeCompare(b));
}

/**
 * Card per alert instance. The header shows the instance, its state and start time. The body shows the summary,
 * description and runbook link first, then other annotations, then the labels as key=value chips.
 * A single instance starts open.
 */
export function AlertInstances({members}:{members:AlertMember[]}){
 return <div className="alert-instances">{members.map(m=>{
  const {summary,description,runbook_url:runbook,...annotations}=m.annotations;
  return <details key={m.fingerprint} className="alert-instance" open={members.length===1}>
   <summary>
    <span className="alert-instance-title">{m.labels.instance??m.labels.pod??m.fingerprint.slice(0,12)}</span>
    <span className={'alert-state '+m.state}>{stateLabels[m.state]}</span>
    <time dateTime={m.startsAt}>Since {new Date(m.startsAt).toLocaleString()}</time>
   </summary>
   <div className="alert-instance-body">
    {summary&&<p className="alert-instance-summary">{summary}</p>}
    {description&&<Markdown>{description}</Markdown>}
    {runbook&&/^https?:\/\//.test(runbook)&&<SafeLink className="alert-runbook" href={runbook} target="_blank" rel="noreferrer">Open runbook ↗</SafeLink>}
    {Object.entries(annotations).map(([key,value])=><div key={key} className="alert-annotation"><h4>{key}</h4><Markdown>{value}</Markdown></div>)}
    <ul className="alert-labels" aria-label="Labels">{orderedLabels(m.labels).map(([key,value])=><li key={key} className={key==='severity'?'severity-'+value.toLowerCase():undefined}><span>{key}</span>{value}</li>)}</ul>
   </div>
  </details>;
 })}</div>;
}

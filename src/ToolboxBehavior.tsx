import type {ReactNode} from 'react';
import {HelpTip} from './HelpTip';
import {ListEditor} from './ListEditor';
import {NumberField} from './NumberField';
import {namespacePattern,type ToolboxSettings} from './model';

function Check({label,hint,help,checked,onChange}:{label:string;hint:string;help:ReactNode;checked:boolean;onChange:(checked:boolean)=>void}){
 return <div className="check-with-help"><label className="check"><input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)}/><span>{label}<small>{hint}</small></span></label><HelpTip label={label}>{help}</HelpTip></div>;
}
const Examples=({items}:{items:[string,string][]})=><dl className="help-examples">{items.map(([value,meaning])=><div key={value}><dt><code>{value}</code></dt><dd>{meaning}</dd></div>)}</dl>;

/** Settings written into the generated Toolbox configuration: namespace exclusions, permissions, limits and redaction. */
export function ToolboxBehavior({settings,onChange}:{settings:ToolboxSettings;onChange:(settings:ToolboxSettings)=>void}){
 const set=<K extends keyof ToolboxSettings>(key:K,value:ToolboxSettings[K])=>onChange({...settings,[key]:value});
 return <section className="credential-card toolbox-behavior" aria-label="Toolbox behaviour">
  <div className="heading"><div><strong>1. Toolbox behaviour</strong><p className="small muted">Saved with the other settings. Generating the configuration in step 2 writes these rules into it.</p></div></div>
  <ListEditor label="Excluded namespaces" values={settings.excludedNamespaces} onChange={v=>set('excludedNamespaces',v)} placeholder="kube-*" validate={v=>namespacePattern.safeParse(v).success?undefined:'Use a namespace name, or a pattern with *, such as kube-* or *gitlab*.'}
   help={<>Namespaces Toolbox never reads. Use exact names or <code>*</code> patterns:<Examples items={[['kube-system','this namespace'],['kube-*','starts with kube-'],['*gitlab*','contains gitlab']]}/></>}/>
  <Check label="Read ConfigMaps" hint="In the allowed namespaces." checked={settings.allowConfigMaps} onChange={v=>set('allowConfigMaps',v)}
   help={<>Reads ConfigMaps in allowed namespaces. Values may contain sensitive data. RBAC: <code>get</code>, <code>list</code> on <code>configmaps</code>.</>}/>
  <Check label="Read cluster-wide resources" hint="Nodes, namespaces, persistent volumes, storage classes…" checked={settings.allowClusterScoped} onChange={v=>set('allowClusterScoped',v)}
   help={<>Reads resources outside namespaces, such as nodes and storage classes. Exclusions do not apply to them. RBAC: a ClusterRole with <code>get</code>, <code>list</code>.</>}/>
  <Check label="Allow port forwarding" hint="Temporary tunnels to pods, services or deployments." checked={settings.allowPortForward} onChange={v=>set('allowPortForward',v)}
   help={<>Opens temporary tunnels to pods or services in allowed namespaces. Tunnel traffic is not sanitized. RBAC: <code>create</code> on <code>pods/portforward</code>.</>}/>
  <div className="form-grid">
   <NumberField label="Request timeout (seconds)" help="Longest time one read may take. 1–120, default 30." value={settings.timeoutSeconds} min={1} max={120} onChange={v=>set('timeoutSeconds',v)}/>
   <NumberField label="Maximum output (MiB)" help="Largest output of one read. 1–8, default 1." value={settings.maxOutputMiB} min={1} max={8} onChange={v=>set('maxOutputMiB',v)}/>
   <NumberField label="Tunnel lifetime (seconds)" help="Longest time a tunnel stays open. 1–3600, default 300." value={settings.portForwardMaxSeconds} min={1} max={3600} disabled={!settings.allowPortForward} onChange={v=>set('portForwardMaxSeconds',v)}/>
  </div>
  <ListEditor label="Redacted words" values={settings.redactionLiterals} onChange={v=>set('redactionLiterals',v)} placeholder="internal.example.com"
   help={<>Exact text replaced with <code>[REDACTED]</code> in every output:<Examples items={[['internal.example.com','a hostname'],['ACME Corp','a customer name']]}/></>}/>
  <ListEditor label="Redaction patterns" values={settings.redactionPatterns} onChange={v=>set('redactionPatterns',v)} placeholder="tok-[a-z0-9]{32}"
   help={<>Go RE2 regular expressions replaced with <code>[REDACTED]</code>:<Examples items={[['tok-[a-z0-9]{32}','tokens'],['(?i)password=\\S+','password=…, any case']]}/></>}/>
 </section>;
}

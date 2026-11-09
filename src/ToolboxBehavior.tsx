import type {ReactNode} from 'react';
import {Field} from './Field';
import {HelpTip} from './HelpTip';
import {ListEditor} from './ListEditor';
import {namespacePattern,type ToolboxSettings} from './model';

function Check({label,hint,help,checked,onChange}:{label:string;hint:string;help:ReactNode;checked:boolean;onChange:(checked:boolean)=>void}){
 return <div className="check-with-help"><label className="check"><input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)}/><span>{label}<small>{hint}</small></span></label><HelpTip label={label}>{help}</HelpTip></div>;
}
const Examples=({items}:{items:[string,string][]})=><dl className="help-examples">{items.map(([value,meaning])=><div key={value}><dt><code>{value}</code></dt><dd>{meaning}</dd></div>)}</dl>;

/** Settings written into the generated Toolbox configuration: namespace exclusions, permissions, limits and redaction. */
export function ToolboxBehavior({settings,onChange}:{settings:ToolboxSettings;onChange:(settings:ToolboxSettings)=>void}){
 const set=<K extends keyof ToolboxSettings>(key:K,value:ToolboxSettings[K])=>onChange({...settings,[key]:value});
 const number=(key:'timeoutSeconds'|'maxOutputMiB'|'portForwardMaxSeconds')=>(e:{target:{value:string}})=>set(key,Number(e.target.value));
 return <section className="credential-card toolbox-behavior" aria-label="Toolbox behaviour">
  <div className="heading"><div><strong>1. Toolbox behaviour</strong><p className="small muted">Saved with the other settings. Generating the configuration in step 2 writes these rules into it.</p></div></div>
  <ListEditor label="Excluded namespaces" values={settings.excludedNamespaces} onChange={v=>set('excludedNamespaces',v)} placeholder="kube-*" validate={v=>namespacePattern.safeParse(v).success?undefined:'Use a namespace name, or a pattern with *, such as kube-* or *gitlab*.'}
   help={<>Namespaces that Toolbox must never read. When you generate the configuration, Support lists each cluster's namespaces and allows every namespace that matches none of these entries. Add one entry at a time:<Examples items={[['kube-system','this namespace only'],['kube-*','every namespace starting with kube-'],['*gitlab*','every namespace containing gitlab']]}/>Toolbox accepts at most 100 allowed namespaces per context. Namespaces created later are not readable until you generate again. The Kubernetes permissions (RBAC) of the kubeconfig user still apply: a namespace allowed here but not granted by RBAC stays unreadable.</>}/>
  <Check label="Read ConfigMaps" hint="In the allowed namespaces." checked={settings.allowConfigMaps} onChange={v=>set('allowConfigMaps',v)}
   help={<>Lets Toolbox, and the agent through it, read ConfigMaps in the allowed namespaces. Excluded namespaces stay excluded. Toolbox sanitizes ConfigMap data, but values can still contain sensitive information. The kubeconfig user also needs <code>get</code> and <code>list</code> on <code>configmaps</code> in those namespaces.</>}/>
  <Check label="Read cluster-wide resources" hint="Nodes, namespaces, persistent volumes, storage classes…" checked={settings.allowClusterScoped} onChange={v=>set('allowClusterScoped',v)}
   help={<>Lets the agent read resources that belong to no namespace: <code>nodes</code>, <code>namespaces</code>, <code>persistentvolumes</code>, <code>storageclasses</code>, <code>clusterissuers</code>, <code>gatewayclasses</code>, Cilium cluster resources and node metrics. Namespace exclusions cannot apply to them. The kubeconfig user needs a ClusterRole with <code>get</code> and <code>list</code> on them, for example Toolbox's <code>cluster-reader.optional.yaml</code>.</>}/>
  <Check label="Allow port forwarding" hint="Temporary tunnels to pods, services or deployments." checked={settings.allowPortForward} onChange={v=>set('allowPortForward',v)}
   help={<>Lets the agent open temporary tunnels to a pod, service or deployment in an allowed namespace, for at most the tunnel lifetime below. Tunnels listen on <code>127.0.0.1</code> inside Support only, and the agent has no tool to send traffic through them yet. Toolbox warns that tunnels allow writes and unsanitized traffic. The kubeconfig user needs <code>get</code> and <code>create</code> on <code>pods/portforward</code>.</>}/>
  <div className="form-grid">
   <Field label="Request timeout (seconds)" help={<>Longest time one Toolbox read may take. From 1 to 120 seconds. Default: 30.</>}><input type="number" min={1} max={120} value={settings.timeoutSeconds} onChange={number('timeoutSeconds')}/></Field>
   <Field label="Maximum output (MiB)" help={<>Largest output of one read. From 1 to 8 MiB. A larger result fails, and the agent narrows its query. Default: 1.</>}><input type="number" min={1} max={8} value={settings.maxOutputMiB} onChange={number('maxOutputMiB')}/></Field>
   <Field label="Tunnel lifetime (seconds)" help={<>Longest time a port-forward tunnel stays open. From 1 to 3,600 seconds. Default: 300. Used only when port forwarding is allowed.</>}><input type="number" min={1} max={3600} value={settings.portForwardMaxSeconds} disabled={!settings.allowPortForward} onChange={number('portForwardMaxSeconds')}/></Field>
  </div>
  <ListEditor label="Redacted words" values={settings.redactionLiterals} onChange={v=>set('redactionLiterals',v)} placeholder="internal.example.com"
   help={<>Exact text that Toolbox replaces with <code>[REDACTED]</code> in every output, in addition to its built-in secret detection. Add one entry at a time:<Examples items={[['internal.example.com','an internal hostname'],['ACME Corp','a customer name, spaces included']]}/></>}/>
  <ListEditor label="Redaction patterns" values={settings.redactionPatterns} onChange={v=>set('redactionPatterns',v)} placeholder="tok-[a-z0-9]{32}"
   help={<>Regular expressions, in Go RE2 syntax, whose matches Toolbox replaces with <code>[REDACTED]</code>. Add one entry at a time:<Examples items={[['tok-[a-z0-9]{32}','tokens such as tok-3f9a…'],['(?i)password=\\S+','password=… in any letter case']]}/>Toolbox rejects an invalid pattern when you generate the configuration.</>}/>
 </section>;
}

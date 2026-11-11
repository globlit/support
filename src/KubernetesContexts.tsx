import {useRef,useState} from 'react';
import {api} from './api';
import {Field} from './Field';
import {Switch} from './Toggle';
import {openVaultSettings} from './navigation';
import {useFeedback} from './Toasts';
import {kubernetesContextSchema,kubernetesCredential,type KubernetesContext,type Snapshot} from './model';
import type {CredentialName} from './ConnectionCredential';

type Secret={token:string;ca?:string;insecure?:boolean};
type Imported={name:string;server:string;secret?:Secret;unsupported?:string};
type Check={ok:boolean;detail:string};
type Props={contexts:KubernetesContext[];onChange:(contexts:KubernetesContext[])=>void;data:Snapshot;busy:boolean;pending:Partial<Record<CredentialName,unknown>>;setPending:(name:CredentialName,body:unknown)=>void};
const credential=(name:string)=>kubernetesCredential(name) as CredentialName;

/**
 * Editor for the Kubernetes contexts the agent can read. Contexts come from imported kubeconfig files or from the
 * manual form. Tokens and CA certificates are saved in the Vault with the other settings. Imported contexts start
 * disabled. **Test** reads /version through a saved context.
 */
export function KubernetesContexts({contexts,onChange,data,busy,pending,setPending}:Props){
 const unlocked=data.vault.unlocked,saved=data.config.kubernetesContexts,feedback=useFeedback(),fileInput=useRef<HTMLInputElement>(null);
 const [skipped,setSkipped]=useState<Imported[]>([]),[status,setStatus]=useState(''),[importing,setImporting]=useState(false);
 const [checks,setChecks]=useState<Record<string,Check|'running'>>({}),[form,setForm]=useState<{edit?:string}|null>(null);
 const tokenSaved=(name:string)=>data.vault.credentials.includes(kubernetesCredential(name)),tokenPending=(name:string)=>pending[credential(name)]!==undefined;

 /** Adds or updates contexts and queues their tokens. New contexts take `enabled`; existing ones keep their switch. */
 function upsert(entries:{name:string;server:string;secret:Secret}[],enabled:boolean){
  const next=[...contexts];
  for(const e of entries){
   const i=next.findIndex(c=>c.name===e.name);
   if(i>=0)next[i]={...next[i],server:e.server};else next.push({name:e.name,server:e.server,enabled});
   setPending(credential(e.name),{name:kubernetesCredential(e.name),kubernetes:e.secret});
  }
  onChange(next);
 }
 async function importFiles(list:FileList|null){
  if(!list?.length)return;
  setImporting(true);setStatus('');
  try{
   const files=await Promise.all([...list].map(async f=>({name:f.name,content:await f.text()})));
   const r=await api<{contexts:Imported[]}>('/kubernetes/import','POST',{files});
   const usable=r.contexts.filter((c):c is Imported&{secret:Secret}=>!!c.secret),added=usable.filter(c=>!contexts.some(x=>x.name===c.name)).length;
   upsert(usable,false);setSkipped(r.contexts.filter(c=>!c.secret));
   setStatus(`${usable.length} context${usable.length===1?'':'s'} with a token: ${added} new, ${usable.length-added} updated. New contexts are disabled: enable the ones the agent may read, then click Save settings.`);
  }catch(e){feedback.error(e instanceof Error?e.message:'The import failed.');}
  finally{setImporting(false);}
 }
 const remove=(name:string)=>{onChange(contexts.filter(c=>c.name!==name));setPending(credential(name),undefined);};
 const toggle=(name:string,enabled:boolean)=>onChange(contexts.map(c=>c.name===name?{...c,enabled}:c));
 const allEnabled=contexts.length>0&&contexts.every(c=>c.enabled);
 const toggleAll=(enabled:boolean)=>onChange(contexts.map(c=>({...c,enabled})));
 async function test(name:string){
  setChecks(c=>({...c,[name]:'running'}));
  try{const r=await api<Check>('/kubernetes/test','POST',{name});setChecks(c=>({...c,[name]:r}));}
  catch(e){setChecks(c=>({...c,[name]:{ok:false,detail:e instanceof Error?e.message:'Test failed.'}}));}
 }
 return <div className="kube-contexts">
  <p className="small muted">For each context, use a ServiceAccount token bound to a read-only role, such as the <code>view</code> ClusterRole. The agent runs kubectl and flux in the sandbox against these contexts. Support adds the token, forwards reads only, and refuses exec, attach, port-forward and proxy. Tokens never reach the sandbox.</p>
  {unlocked?<div className="actions">
   <input ref={fileInput} type="file" multiple hidden onChange={e=>{void importFiles(e.target.files);e.target.value='';}}/>
   <button type="button" disabled={busy||importing} onClick={()=>fileInput.current?.click()}>{importing?'Importing…':'Import kubeconfig files…'}</button>
   <button type="button" disabled={busy} aria-expanded={!!form&&!form.edit} onClick={()=>setForm(f=>f&&!f.edit?null:{})}>Add a context</button>
  </div>:<p className="small muted">Unlock the Vault to import or add contexts. <button type="button" className="text-button" onClick={openVaultSettings}>Unlock Vault</button></p>}
  {status&&<p className="small muted" role="status">{status}</p>}
  {skipped.length>0&&<details className="kube-skipped"><summary className="small">{skipped.length} context{skipped.length===1?'':'s'} not imported</summary><ul>{skipped.map(c=><li key={c.name} className="small"><code>{c.name}</code> <span className="muted">{c.unsupported}</span></li>)}</ul></details>}
  {form&&!form.edit&&<ContextForm taken={contexts.map(c=>c.name)} onCancel={()=>setForm(null)} onSubmit={e=>{upsert([e],true);setForm(null);}}/>}
  {contexts.length>1&&<div className="kube-all"><Switch label="Let the agent read all contexts" checked={allEnabled} onChange={toggleAll}/><span className="small">{allEnabled?'All contexts enabled':`${contexts.filter(c=>c.enabled).length} of ${contexts.length} enabled`}. Click Save settings to apply.</span></div>}
  {contexts.length?<ul className="kube-list">{contexts.map(c=>{
   const check=checks[c.name],unchanged=JSON.stringify(saved.find(x=>x.name===c.name))===JSON.stringify(c)&&tokenSaved(c.name)&&!tokenPending(c.name),issue=kubernetesContextSchema.safeParse(c);
   return <li key={c.name} className="kube-row">
    <Switch label={`Let the agent read ${c.name}`} checked={c.enabled} onChange={on=>toggle(c.name,on)}/>
    <div className="kube-main"><code className="kube-name">{c.name}</code><span className="kube-server">{c.server}</span>
     <span className="small"><i className={'credential-dot'+(tokenSaved(c.name)||tokenPending(c.name)?' saved':'')} aria-hidden="true"/>{tokenPending(c.name)?'Token saved when you click Save settings':tokenSaved(c.name)?'Token saved':'No token: add one'}</span></div>
    <div className="actions">
     <button type="button" disabled={!unlocked||!unchanged||check==='running'} title={unchanged?'Reads /version with the saved token.':'Save settings first.'} onClick={()=>void test(c.name)}>{check==='running'?'Testing…':'Test'}</button>
     <button type="button" className="text-button" disabled={!unlocked} onClick={()=>setForm(f=>f?.edit===c.name?null:{edit:c.name})}>{tokenSaved(c.name)?'Replace token':'Add token'}</button>
     <button type="button" className="text-button" onClick={()=>remove(c.name)}>Remove</button>
    </div>
    {!issue.success&&<p className="small error kube-detail">{issue.error.issues[0]?.message}</p>}
    {check&&check!=='running'&&<p className={'small kube-detail '+(check.ok?'ok':'error')} role="status">{check.detail}</p>}
    {form?.edit===c.name&&<div className="kube-detail"><ContextForm initial={c} taken={[]} onCancel={()=>setForm(null)} onSubmit={e=>{upsert([e],c.enabled);setForm(null);}}/></div>}
   </li>;})}</ul>:<p className="small muted">No context yet.</p>}
  {contexts.length>0&&<p className="small muted">Removing a context deletes its token from the Vault when you click Save settings.</p>}
 </div>;
}

/** Form for a context: name and API server URL, then its token and optional CA certificates. */
function ContextForm({initial,taken,onSubmit,onCancel}:{initial?:KubernetesContext;taken:string[];onSubmit:(e:{name:string;server:string;secret:Secret})=>void;onCancel:()=>void}){
 const [name,setName]=useState(initial?.name??''),[server,setServer]=useState(initial?.server??''),[token,setToken]=useState(''),[ca,setCa]=useState(''),[insecure,setInsecure]=useState(false);
 const parsed=kubernetesContextSchema.safeParse({name,server,enabled:true});
 const error=!parsed.success?parsed.error.issues[0]?.message:taken.includes(name.trim())?'Another context already uses this name.':ca.trim()&&!ca.includes('-----BEGIN CERTIFICATE-----')?'Use PEM certificates.':/\s/.test(token.trim())?'The token must not contain spaces.':'';
 const ready=!error&&!!token.trim();
 return <fieldset className="kube-form">
  {!initial&&<Field label="Context name" hint="Name shown to the agent, for example prod-paris."><input value={name} spellCheck={false} onChange={e=>setName(e.target.value)}/></Field>}
  <Field label="API server URL" hint="The server field of the kubeconfig, for example https://10.0.0.1:6443."><input value={server} spellCheck={false} onChange={e=>setServer(e.target.value)}/></Field>
  <Field label="ServiceAccount token" hint="Stored encrypted in the Vault when you click Save settings. Never shown again."><input type="password" value={token} autoComplete="off" onChange={e=>setToken(e.target.value)}/></Field>
  <Field label="CA certificate (PEM)" hint="Leave empty when the API server certificate is signed by a public authority."><textarea className="code-input" rows={4} value={ca} spellCheck={false} onChange={e=>setCa(e.target.value)}/></Field>
  <label className="check"><input type="checkbox" checked={insecure} onChange={e=>setInsecure(e.target.checked)}/><span>Skip TLS verification. Use only for test clusters.</span></label>
  {(name||server||token)&&error&&<p className="small error">{error}</p>}
  <div className="actions"><button type="button" className="primary" disabled={!ready} onClick={()=>onSubmit({name:name.trim(),server:server.trim(),secret:{token:token.trim(),...(ca.trim()?{ca:ca.trim()}:{}),...(insecure?{insecure:true}:{})}})}>{initial?'Use this token':'Add context'}</button><button type="button" onClick={onCancel}>Cancel</button></div>
 </fieldset>;
}

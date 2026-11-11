import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {Field} from './Field';
import {credentialHelp} from './field-help';
import {Select} from './Select';
import {openVaultSettings} from './navigation';
import type {ConnectionName,Snapshot,ToolboxSettings} from './model';
import {useFeedback} from './Toasts';

/** Credential name: a connection, or a Prometheus server (Prometheus/<id>). */
export type CredentialName=ConnectionName|`Prometheus/${string}`;
type Props={name:ConnectionName;data:Snapshot;run:(f:()=>Promise<void>)=>Promise<void>;reload:()=>Promise<Snapshot>;busy:boolean;dirty:boolean;pending:boolean;setPending:(name:CredentialName,body:unknown)=>void;toolboxSettings?:ToolboxSettings;settingsDirty?:boolean};
type ServiceAuthName='Alertmanager'|'Prometheus'|'Grafana';
/** Connections with a credential edited on their Connections page, in display order. */
export const credentialConnections=['YouTrack','GitLab','Slack','Outline','Alertmanager','Prometheus','Grafana','Toolbox'] as const satisfies readonly ConnectionName[];
const required:ConnectionName[]=['YouTrack','GitLab','Slack'];
const isServiceAuth=(name:ConnectionName):name is ServiceAuthName=>name==='Alertmanager'||name==='Prometheus'||name==='Grafana';
const replaceHint='The saved credential stays active until you save its replacement.',newHint='Stored encrypted in the Vault. Never shown again.';

/** Returns the credential status text for a connection. */
export function credentialStatus(data:Snapshot,name:ConnectionName){
 const saved=data.vault.credentials.includes(name);
 if(name==='Toolbox')return saved?'Kubeconfig and configuration saved':'No kubeconfig saved';
 if(isServiceAuth(name)){if(!saved)return 'No authentication configured';const scheme=data.vault.authSchemes?.[name];return scheme==='basic'?'Basic auth saved':scheme==='bearer'?'Bearer token saved':'Authentication saved';}
 if(name==='Outline')return saved?'Bearer token saved':'No authentication configured';
 return saved?'Token saved':'No token saved';
}

/** Credential block on a connection's settings page. */
export function ConnectionCredential(props:Props){
 const {name,data,busy}=props,[open,setOpen]=useState(false),saved=data.vault.credentials.includes(name);
 const title=name==='Toolbox'?'Kubeconfig and configuration':'Credentials';
 const intro=name==='Toolbox'?'Add the kubeconfig, choose its contexts, and generate the Toolbox configuration from the behaviour above.'
  :isServiceAuth(name)||name==='Outline'?`${name} does not require authentication by default. Add credentials only if the endpoint, or a proxy such as nginx or Envoy in front of it, requires them.`
  :`${name} requires a token.`;
 return <div className={'credential-card connection-credential'+(name==='Toolbox'?' toolbox-credential':'')}><div className="heading"><div><strong>{title}</strong><p className="small muted credential-status"><i className={'credential-dot'+(saved?' saved':'')} aria-hidden="true"/>{credentialStatus(data,name)}{props.pending?' · Change pending until you save settings':required.includes(name)&&!saved?' · Required':''}</p></div>
  {data.vault.unlocked?<button type="button" disabled={busy} onClick={()=>setOpen(v=>!v)}>{open?'Close':saved?(name==='Toolbox'?'Replace kubeconfig':'Change'):name==='Toolbox'?'Add kubeconfig':'Add'}</button>
   :<button type="button" onClick={openVaultSettings}>{data.vault.initialized?'Unlock Vault':'Create Vault'}</button>}</div>
  <p className="small muted credential-intro">{intro}{!data.vault.unlocked?' Unlock the Vault to change it.':''}</p>
  {name==='Toolbox'&&data.vault.unlocked&&<ToolboxSaved data={data} settingsDirty={props.settingsDirty} reload={props.reload}/>}
  {open&&data.vault.unlocked&&(name==='Toolbox'?<ToolboxEditor {...props} saved={saved} onClose={()=>setOpen(false)}/>:isServiceAuth(name)?<ServiceAuthEditor {...props} name={name} saved={saved} onClose={()=>setOpen(false)}/>:<TokenEditor {...props} saved={saved} onClose={()=>setOpen(false)}/>)}
 </div>;
}

type EditorProps=Props&{saved:boolean;onClose:()=>void};
function Actions({props,body,ready,onClose,remove}:{props:Omit<EditorProps,'name'>&{name:CredentialName};body:unknown;ready:boolean;onClose:()=>void;remove?:{label:string;body:unknown}}){
 const {name,setPending}=props,[removing,setRemoving]=useState(false);
 const value=removing&&remove?remove.body:ready?body:undefined,serialized=JSON.stringify(value??null);
 // Report only real edits, so reopening the editor keeps a change that is already pending.
 const initial=useRef(serialized),edited=useRef(false);
 useEffect(()=>{if(!edited.current&&serialized===initial.current)return;edited.current=true;setPending(name,value);},[serialized]);
 return <><div className="actions">{remove&&<button type="button" aria-pressed={removing} onClick={()=>setRemoving(v=>!v)}>{removing?'Keep the saved credential':remove.label}</button>}<button type="button" onClick={()=>{setPending(name,undefined);onClose();}}>Cancel</button></div>
  <p className="small muted">{value===undefined?'Changes are saved when you click Save settings.':removing?'The saved credential is removed when you click Save settings.':'Saved after the other settings when you click Save settings.'}</p></>;
}

function TokenEditor(props:EditorProps){
 const {name,saved,onClose}=props,[token,setToken]=useState('');
 return <div className="credential-editor"><Field label={`${name} ${name==='Outline'?'API key':'API token'}`} hint={saved?replaceHint:newHint} help={credentialHelp(name)}><input type="password" value={token} autoComplete="off" onChange={e=>setToken(e.target.value)}/></Field>
  <Actions props={props} body={{name,value:token}} ready={!!token} onClose={onClose} remove={name==='Outline'&&saved?{label:'Remove token',body:{name,remove:true}}:undefined}/></div>;
}

function ServiceAuthEditor(props:Omit<EditorProps,'name'>&{name:ServiceAuthName|`Prometheus/${string}`}){
 const {name,data,saved,onClose}=props,[mode,setMode]=useState<'none'|'bearer'|'basic'>(data.vault.authSchemes?.[name]??(saved?'bearer':'none')),[token,setToken]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState('');
 const usernameError=username.includes(':')?'The username must not contain ":".':'';
 const ready=mode==='none'?saved:mode==='bearer'?!!token:!!username&&!!password&&!usernameError;
 const body=mode==='none'?{name,remove:true}:mode==='bearer'?{name,value:token}:{name,basic:{username,password}};
 return <div className="credential-editor">
  <Field label="Authentication" help={credentialHelp(name.startsWith('Prometheus')?'Prometheus':name as ConnectionName)}><Select value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="none">None</option><option value="basic">Basic auth (username and password)</option><option value="bearer">Bearer token</option></Select></Field>
  {mode==='basic'&&<><Field label="Username" hint="Sent with the password in the Authorization header, as required by nginx auth_basic or an Envoy basic auth filter."><input value={username} autoComplete="username" spellCheck={false} onChange={e=>setUsername(e.target.value)}/></Field>{usernameError&&<p className="small error">{usernameError}</p>}<Field label="Password" hint={saved?replaceHint:newHint}><input type="password" value={password} autoComplete="current-password" onChange={e=>setPassword(e.target.value)}/></Field></>}
  {mode==='bearer'&&<Field label={`${name.startsWith('Prometheus/')?'Prometheus':name} bearer token`} hint={saved?replaceHint:newHint}><input type="password" value={token} autoComplete="off" onChange={e=>setToken(e.target.value)}/></Field>}
  {mode==='none'&&<p className="small muted">{saved?'Removes the saved credential. Requests are sent without an Authorization header.':'Requests are sent without an Authorization header.'}</p>}
  <Actions props={props} body={body} ready={ready} onClose={onClose}/>
 </div>;
}

type Generated={config:string;contexts:{name:string;namespaces:string[];excluded:number}[]};
function ToolboxEditor(props:EditorProps){
 const {saved,onClose,toolboxSettings,settingsDirty}=props,fileInput=useRef<HTMLInputElement>(null);
 const [kubeconfig,setKubeconfig]=useState(''),[available,setAvailable]=useState<string[]>([]),[selected,setSelected]=useState<string[]>([]);
 const [preview,setPreview]=useState<{key:string;result:Generated}|null>(null),[working,setWorking]=useState(''),[status,setStatus]=useState(''),feedback=useFeedback();
 // The preview is valid only for the kubeconfig, contexts and settings it was generated from.
 const key=JSON.stringify([kubeconfig,[...selected].sort(),toolboxSettings]),ready=!!preview&&preview.key===key;
 async function step(label:string,work:()=>Promise<void>){setWorking(label);setStatus('');try{await work();}catch(e){feedback.error(e instanceof Error?e.message:`${label} failed.`);}finally{setWorking('');}}
 const load=(list:FileList|null)=>{if(list?.length)void step('Loading',async()=>{
  const files=await Promise.all([...list].map(async f=>({name:f.name,content:await f.text()})));
  const r=await api<{kubeconfig:string;contexts:string[]}>('/toolbox/kubeconfig/merge','POST',{files});
  setKubeconfig(r.kubeconfig);setAvailable(r.contexts);setSelected(r.contexts);setPreview(null);
  setStatus(`${files.length===1?'Loaded 1 file':`Merged ${files.length} files`}. ${r.contexts.length} contexts found.`);
 });};
 const detect=()=>void step('Detecting',async()=>{const r=await api<{contexts:string[]}>('/toolbox/contexts','POST',{kubeconfig});setAvailable(r.contexts);setSelected(r.contexts);setPreview(null);setStatus(`${r.contexts.length} contexts found.`);});
 const generate=()=>void step('Generating',async()=>{const result=await api<Generated>('/toolbox/generate','POST',{kubeconfig,contexts:selected,settings:toolboxSettings});setPreview({key,result});});
 const toggle=(name:string)=>setSelected(s=>s.includes(name)?s.filter(n=>n!==name):[...s,name]);
 return <div className="credential-editor toolbox-editor">
  <Field label="kubeconfig" help={credentialHelp('Toolbox')} hint={'Paste a kubeconfig, or load files to merge them. '+(saved?replaceHint:newHint)}><textarea className="code-input" rows={8} value={kubeconfig} spellCheck={false} autoComplete="off" onChange={e=>{setKubeconfig(e.target.value);setAvailable([]);setSelected([]);setPreview(null);}}/></Field>
  <input ref={fileInput} type="file" multiple hidden onChange={e=>{load(e.target.files);e.target.value='';}}/>
  <div className="actions"><button type="button" disabled={!!working} onClick={()=>fileInput.current?.click()}>{working==='Loading'?'Loading…':'Load kubeconfig files…'}</button><button type="button" disabled={!!working||!kubeconfig.trim()} onClick={detect}>{working==='Detecting'?'Detecting…':'Detect contexts'}</button></div>
  {available.length>0&&<fieldset className="context-checklist"><legend>Contexts to include <span className="small muted">{selected.length} of {available.length}</span></legend>
   <div className="actions"><button type="button" className="text-button" onClick={()=>setSelected(available)}>Select all</button><button type="button" className="text-button" onClick={()=>setSelected([])}>Select none</button></div>
   {available.map(name=><label key={name} className="check"><input type="checkbox" checked={selected.includes(name)} onChange={()=>toggle(name)}/><span><code>{name}</code></span></label>)}
  </fieldset>}
  {available.length>0&&<div className="actions"><button type="button" disabled={!!working||!selected.length||!toolboxSettings} onClick={generate}>{working==='Generating'?'Generating…':'Generate configuration'}</button></div>}
  {working&&<p className="small muted" role="status">{working==='Generating'?'Listing the namespaces of each context and validating the configuration…':`${working}…`}</p>}
  {status&&<p className="small muted" role="status">{status}</p>}
  {preview&&<div className="toolbox-preview">{!ready&&<p className="small amber">The kubeconfig, contexts or behaviour changed. Generate again.</p>}
   <ContextTable contexts={preview.result.contexts.map(c=>({name:c.name,namespaces:c.namespaces.length,excluded:c.excluded}))}/>
   <details><summary>Show the generated configuration</summary><pre className="code-input">{preview.result.config}</pre></details></div>}
  {settingsDirty&&<p className="small muted">The configuration uses the behaviour as it is when you click Save settings.</p>}
  <Actions props={props} body={{name:'Toolbox',toolbox:{kubeconfig,contexts:selected}}} ready={ready} onClose={onClose} remove={saved?{label:'Remove kubeconfig and configuration',body:{name:'Toolbox',remove:true}}:undefined}/>
 </div>;
}

type ToolboxStatus={source:'none'|'path'|'custom'}|{source:'generated';contexts:{name:string;namespaces:number;excluded:number}[];generatedAt:string;stale:boolean};
/** Shows the saved Toolbox configuration: its contexts, and whether it still matches the saved behaviour. */
function ToolboxSaved({data,settingsDirty,reload}:{data:Snapshot;settingsDirty?:boolean;reload:()=>Promise<Snapshot>}){
 const [status,setStatus]=useState<ToolboxStatus|null>(null),[working,setWorking]=useState(false),[error,setError]=useState(''),feedback=useFeedback();
 const load=()=>{if(data.vault.unlocked)void api<ToolboxStatus>('/toolbox/status').then(setStatus).catch(e=>setError(e instanceof Error?e.message:'Status unavailable.'));};
 useEffect(load,[data.vault.unlocked,data.configRevision,data.vault.credentials.join(',')]);
 async function apply(){setWorking(true);try{await api('/toolbox/regenerate','POST',{});await reload();load();feedback.success('Toolbox configuration regenerated.');}catch(e){feedback.error(e)}finally{setWorking(false);}}
 if(!status)return error?<p className="small error">{error}</p>:null;
 if(status.source==='custom')return <p className="small amber">A configuration pasted before generation existed is in use. Replace the kubeconfig below to apply the behaviour above.</p>;
 if(status.source==='path')return <p className="small amber">A configuration file set by path is in use. Add a kubeconfig below to generate a configuration from the behaviour above.</p>;
 if(status.source!=='generated')return null;
 return <div className="toolbox-saved">
  <ContextTable contexts={status.contexts} generatedAt={status.generatedAt}/>
  {status.stale&&<div className="notice"><span>The saved behaviour changed since this configuration was generated.</span> <button type="button" disabled={working||settingsDirty} onClick={()=>void apply()}>{working?'Generating…':'Apply current settings'}</button>{settingsDirty&&<small> Save settings first.</small>}</div>}
  {error&&<p className="small error" role="alert">{error}</p>}
 </div>;
}

/** Credential of one Prometheus server, saved as Prometheus/<id> when settings are saved. */
export function ServerCredential({id,data,busy,pending,setPending,run,reload,dirty}:{id:string;pending:boolean}&Omit<Props,'name'|'pending'>){
 const name=`Prometheus/${id}` as const,saved=data.vault.credentials.includes(name),[open,setOpen]=useState(false),scheme=data.vault.authSchemes?.[name];
 const status=!saved?'No authentication':scheme==='basic'?'Basic auth saved':'Bearer token saved';
 return <div className="server-credential">
  <div className="server-credential-row"><span className="small"><i className={'credential-dot'+(saved?' saved':'')} aria-hidden="true"/>{status}{pending?' · Change pending until you save settings':''}</span>
   {data.vault.unlocked?<button type="button" className="text-button" disabled={busy} onClick={()=>setOpen(v=>!v)}>{open?'Close':saved?'Change':'Add credentials'}</button>:<button type="button" className="text-button" onClick={openVaultSettings}>Unlock Vault</button>}</div>
  {open&&data.vault.unlocked&&<ServiceAuthEditor name={name} data={data} busy={busy} pending={pending} setPending={setPending} run={run} reload={reload} dirty={dirty} saved={saved} onClose={()=>setOpen(false)}/>}
 </div>;
}

/** Contexts of a Toolbox configuration with their allowed and excluded namespace counts, as a compact table. */
function ContextTable({contexts,generatedAt}:{contexts:{name:string;namespaces:number;excluded:number}[];generatedAt?:string}){
 const allowed=contexts.reduce((n,c)=>n+c.namespaces,0),excluded=contexts.reduce((n,c)=>n+c.excluded,0);
 return <div className="context-table">
  <div className="context-table-summary"><strong>{contexts.length} context{contexts.length===1?'':'s'}</strong><span className="small muted">{allowed} namespaces allowed · {excluded} excluded{generatedAt?` · Generated ${new Date(generatedAt).toLocaleString()}`:''}</span></div>
  <div className="context-table-scroll"><table>
   <thead><tr><th scope="col">Context</th><th scope="col">Allowed</th><th scope="col">Excluded</th></tr></thead>
   <tbody>{contexts.map(c=><tr key={c.name}><td><code>{c.name}</code></td><td>{c.namespaces}</td><td className={c.excluded?'':'muted'}>{c.excluded||'–'}</td></tr>)}</tbody>
  </table></div>
 </div>;
}

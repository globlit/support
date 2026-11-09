import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {Field} from './Field';
import {credentialHelp} from './field-help';
import {Select} from './Select';
import {openVaultSettings} from './navigation';
import type {ConnectionName,Snapshot} from './model';

type Props={name:ConnectionName;data:Snapshot;run:(f:()=>Promise<void>)=>Promise<void>;reload:()=>Promise<Snapshot>;busy:boolean;dirty:boolean;pending:boolean;setPending:(name:ConnectionName,body:unknown)=>void};
type ServiceAuthName='Alertmanager'|'Prometheus';
/** Connections with a credential edited on their Connections page, in display order. */
export const credentialConnections=['YouTrack','GitLab','Slack','Outline','Alertmanager','Prometheus','Toolbox'] as const satisfies readonly ConnectionName[];
const required:ConnectionName[]=['YouTrack','GitLab','Slack'];
const isServiceAuth=(name:ConnectionName):name is ServiceAuthName=>name==='Alertmanager'||name==='Prometheus';
const replaceHint='The saved credential stays active until you save its replacement.',newHint='Stored encrypted in the Vault. Never shown again.';

/** Returns the credential status text for a connection. */
export function credentialStatus(data:Snapshot,name:ConnectionName){
 const saved=data.vault.credentials.includes(name);
 if(name==='Toolbox')return saved?'Pasted configuration saved':'Uses the configuration path';
 if(isServiceAuth(name)){if(!saved)return 'No authentication configured';const scheme=data.vault.authSchemes?.[name];return scheme==='basic'?'Basic auth saved':scheme==='bearer'?'Bearer token saved':'Authentication saved';}
 if(name==='Outline')return saved?'Bearer token saved':'No authentication configured';
 return saved?'Token saved':'No token saved';
}

/** Credential block on a connection's settings page. */
export function ConnectionCredential(props:Props){
 const {name,data,busy}=props,[open,setOpen]=useState(false),saved=data.vault.credentials.includes(name);
 const title=name==='Toolbox'?'Configuration':'Credentials';
 const intro=name==='Toolbox'?'Paste the Toolbox JSON configuration and its kubeconfig, or set the configuration path above. A pasted configuration takes priority over the path.'
  :isServiceAuth(name)||name==='Outline'?`${name} does not require authentication by default. Add credentials only if the endpoint, or a proxy such as nginx or Envoy in front of it, requires them.`
  :`${name} requires a token.`;
 return <div className="credential-card connection-credential"><div className="heading"><div><strong>{title}</strong><p className="small muted">{credentialStatus(data,name)}{props.pending?' · Change pending until you save settings':required.includes(name)&&!saved?' · Required':''}</p></div>
  {data.vault.unlocked?<button type="button" disabled={busy} onClick={()=>setOpen(v=>!v)}>{open?'Close':saved?'Change':name==='Toolbox'?'Paste configuration':'Add'}</button>
   :<button type="button" onClick={openVaultSettings}>{data.vault.initialized?'Unlock Vault':'Create Vault'}</button>}</div>
  <p className="small muted">{intro}{!data.vault.unlocked?' Unlock the Vault to change it.':''}</p>
  {open&&data.vault.unlocked&&(name==='Toolbox'?<ToolboxEditor {...props} saved={saved} onClose={()=>setOpen(false)}/>:isServiceAuth(name)?<ServiceAuthEditor {...props} name={name} saved={saved} onClose={()=>setOpen(false)}/>:<TokenEditor {...props} saved={saved} onClose={()=>setOpen(false)}/>)}
 </div>;
}

type EditorProps=Props&{saved:boolean;onClose:()=>void};
function Actions({props,body,ready,onClose,remove}:{props:EditorProps;body:unknown;ready:boolean;onClose:()=>void;remove?:{label:string;body:unknown}}){
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

function ServiceAuthEditor(props:EditorProps&{name:ServiceAuthName}){
 const {name,data,saved,onClose}=props,[mode,setMode]=useState<'none'|'bearer'|'basic'>(data.vault.authSchemes?.[name]??(saved?'bearer':'none')),[token,setToken]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState('');
 const usernameError=username.includes(':')?'The username must not contain ":".':'';
 const ready=mode==='none'?saved:mode==='bearer'?!!token:!!username&&!!password&&!usernameError;
 const body=mode==='none'?{name,remove:true}:mode==='bearer'?{name,value:token}:{name,basic:{username,password}};
 return <div className="credential-editor">
  <Field label="Authentication" help={credentialHelp(name)}><Select value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="none">None</option><option value="basic">Basic auth (username and password)</option><option value="bearer">Bearer token</option></Select></Field>
  {mode==='basic'&&<><Field label="Username" hint="Sent with the password in the Authorization header, as required by nginx auth_basic or an Envoy basic auth filter."><input value={username} autoComplete="username" spellCheck={false} onChange={e=>setUsername(e.target.value)}/></Field>{usernameError&&<p className="small error">{usernameError}</p>}<Field label="Password" hint={saved?replaceHint:newHint}><input type="password" value={password} autoComplete="current-password" onChange={e=>setPassword(e.target.value)}/></Field></>}
  {mode==='bearer'&&<Field label={`${name} bearer token`} hint={saved?replaceHint:newHint}><input type="password" value={token} autoComplete="off" onChange={e=>setToken(e.target.value)}/></Field>}
  {mode==='none'&&<p className="small muted">{saved?'Removes the saved credential. Requests are sent without an Authorization header.':'Requests are sent without an Authorization header.'}</p>}
  <Actions props={props} body={body} ready={ready} onClose={onClose}/>
 </div>;
}

function ToolboxEditor(props:EditorProps){
 const {saved,onClose}=props,[config,setConfig]=useState(''),[kubeconfig,setKubeconfig]=useState(''),[generating,setGenerating]=useState(false),[generated,setGenerated]=useState(''),[generateError,setGenerateError]=useState(''),[merging,setMerging]=useState(false),[merged,setMerged]=useState(''),[mergeError,setMergeError]=useState(''),fileInput=useRef<HTMLInputElement>(null);
 let configError='';if(config.trim()){try{const v=JSON.parse(config);if(!v||typeof v!=='object'||Array.isArray(v))configError='The Toolbox configuration must be a JSON object.';}catch{configError='The Toolbox configuration is not valid JSON.';}}
 async function load(list:FileList|null){
  if(!list?.length)return;
  setMerging(true);setMerged('');setMergeError('');
  try{
   const files=await Promise.all([...list].map(async f=>({name:f.name,content:await f.text()})));
   const r=await api<{kubeconfig:string;contexts:string[]}>('/toolbox/kubeconfig/merge','POST',{files});
   setKubeconfig(r.kubeconfig);setMerged(`${files.length===1?'Loaded 1 file':`Merged ${files.length} files`}. Contexts: ${r.contexts.join(', ')||'none'}.`);
  }catch(e){setMergeError(e instanceof Error?e.message:'The kubeconfig files could not be loaded.');}
  finally{setMerging(false);}
 }
 async function generate(){
  setGenerating(true);setGenerated('');setGenerateError('');
  try{const r=await api<{config:string;contexts:string[]}>('/toolbox/generate','POST',{kubeconfig});setConfig(r.config);setGenerated(r.contexts.length?`Detected contexts: ${r.contexts.join(', ')}. Each one allows only the default namespace. Edit the namespaces below, then list the contexts Support may read in Allowed context names above.`:'The kubeconfig defines no context.');}
  catch(e){setGenerateError(e instanceof Error?e.message:'Toolbox could not generate a configuration.');}
  finally{setGenerating(false);}
 }
 return <div className="credential-editor">
  <Field label="kubeconfig" help={credentialHelp('Toolbox')} hint={'Paste a kubeconfig, or load one or more kubeconfig files: several files are merged into one. Embed certificates with the *-data fields. Files referenced by path are not available. '+(saved?replaceHint:newHint)}><textarea className="code-input" rows={8} value={kubeconfig} spellCheck={false} autoComplete="off" onChange={e=>setKubeconfig(e.target.value)}/></Field>
  <input ref={fileInput} type="file" multiple hidden onChange={e=>{void load(e.target.files);e.target.value='';}}/>
  <div className="actions"><button type="button" disabled={merging} onClick={()=>fileInput.current?.click()}>{merging?'Loading…':'Load kubeconfig files…'}</button><button type="button" disabled={generating||!kubeconfig.trim()} onClick={()=>void generate()}>{generating?'Generating…':'Generate configuration from kubeconfig'}</button></div>
  {merged&&<p className="small muted" role="status">{merged}</p>}{mergeError&&<p className="small error" role="alert">{mergeError}</p>}
  {generated&&<p className="small muted" role="status">{generated}</p>}{generateError&&<p className="small error" role="alert">{generateError}</p>}
  <Field label="Toolbox JSON configuration" hint={'Generate it from the kubeconfig above, or paste your own. Set the kubeconfig path field to "{{kubeconfig}}". Support replaces it with the pasted kubeconfig for each run. Without the placeholder, Support replaces the single field whose name contains "kubeconfig".'}><textarea className="code-input" rows={8} value={config} spellCheck={false} autoComplete="off" onChange={e=>setConfig(e.target.value)}/></Field>
  {configError&&<p className="small error">{configError}</p>}
  <Actions props={props} body={{name:'Toolbox',toolbox:{config,kubeconfig}}} ready={!!config.trim()&&!configError&&!!kubeconfig.trim()} onClose={onClose} remove={saved?{label:'Remove pasted configuration',body:{name:'Toolbox',remove:true}}:undefined}/>
 </div>;
}

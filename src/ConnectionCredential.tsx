import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {Field} from './Field';
import {credentialHelp} from './field-help';
import {Select} from './Select';
import {openVaultSettings} from './navigation';
import type {ConnectionName,Snapshot} from './model';

/** Credential name: a connection, a Prometheus server (Prometheus/<id>) or a Kubernetes context (Kubernetes/<name>). */
export type CredentialName=ConnectionName|`Prometheus/${string}`|`Kubernetes/${string}`;
type Props={name:ConnectionName;data:Snapshot;run:(f:()=>Promise<void>)=>Promise<void>;reload:()=>Promise<Snapshot>;busy:boolean;dirty:boolean;pending:boolean;setPending:(name:CredentialName,body:unknown)=>void};
type ServiceAuthName='Alertmanager'|'Prometheus'|'Grafana';
/** Connections with a credential edited on their Connections page, in display order. */
export const credentialConnections=['YouTrack','GitLab','Slack','Outline','Alertmanager','Prometheus','Grafana','Kubernetes'] as const satisfies readonly ConnectionName[];
const required:ConnectionName[]=['YouTrack','GitLab','Slack'];
const isServiceAuth=(name:ConnectionName):name is ServiceAuthName=>name==='Alertmanager'||name==='Prometheus'||name==='Grafana';
const replaceHint='The saved credential stays active until you save its replacement.',newHint='Stored encrypted in the Vault. Never shown again.';

/** Returns the credential status text for a connection. */
export function credentialStatus(data:Snapshot,name:ConnectionName){
 const saved=data.vault.credentials.includes(name);
 if(name==='Kubernetes'){const n=data.vault.credentials.filter(c=>c.startsWith('Kubernetes/')).length;return n?`${n} context token${n===1?'':'s'} saved`:'No context token saved';}
 if(isServiceAuth(name)){if(!saved)return 'No authentication configured';const scheme=data.vault.authSchemes?.[name];return scheme==='basic'?'Basic auth saved':scheme==='bearer'?'Bearer token saved':'Authentication saved';}
 if(name==='Outline')return saved?'Bearer token saved':'No authentication configured';
 return saved?'Token saved':'No token saved';
}

/** Credential block on a connection's settings page. */
export function ConnectionCredential(props:Props){
 const {name,data,busy}=props,[open,setOpen]=useState(false),saved=data.vault.credentials.includes(name);
 const title='Credentials';
 const intro=isServiceAuth(name)||name==='Outline'?`${name} does not require authentication by default. Add credentials only if the endpoint, or a proxy such as nginx or Envoy in front of it, requires them.`
  :`${name} requires a token.`;
 return <div className="credential-card connection-credential"><div className="heading"><div><strong>{title}</strong><p className="small muted credential-status"><i className={'credential-dot'+(saved?' saved':'')} aria-hidden="true"/>{credentialStatus(data,name)}{props.pending?' · Change pending until you save settings':required.includes(name)&&!saved?' · Required':''}</p></div>
  {data.vault.unlocked?<button type="button" disabled={busy} onClick={()=>setOpen(v=>!v)}>{open?'Close':saved?'Change':'Add'}</button>
   :<button type="button" onClick={openVaultSettings}>{data.vault.initialized?'Unlock Vault':'Create Vault'}</button>}</div>
  <p className="small muted credential-intro">{intro}{!data.vault.unlocked?' Unlock the Vault to change it.':''}</p>
  {open&&data.vault.unlocked&&(isServiceAuth(name)?<ServiceAuthEditor {...props} name={name} saved={saved} onClose={()=>setOpen(false)}/>:<TokenEditor {...props} saved={saved} onClose={()=>setOpen(false)}/>)}
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

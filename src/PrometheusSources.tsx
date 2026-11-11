import {useEffect,useId,useState} from 'react';
import {api} from './api';
import {Field} from './Field';
import {ServerCredential,type CredentialName} from './ConnectionCredential';
import {newServerId,prometheusSourceSchema,type PrometheusSource,type Snapshot} from './model';

type Listed={sources:{name:string;kind:'url'|'grafana'|'tunnel';detail:string}[];unavailable?:string[]};
type Check={ok:boolean;detail:string};
const kinds={url:'URL',grafana:'Grafana',tunnel:'Kubernetes'};
const tunnelDefaults={target:'service/prometheus-operated',port:9090,pathPrefix:''};

/**
 * Editor for the Prometheus servers the agent can query. A server is reached by URL, with optional credentials saved in
 * the Vault, or through the API server of a Kubernetes context. **Test** checks a saved server. The list at the end also shows Grafana datasources.
 */
export function PrometheusSources({sources,onChange,data,busy,dirty,pending,setPending,run,reload}:{sources:PrometheusSource[];onChange:(sources:PrometheusSource[])=>void;data:Snapshot;busy:boolean;dirty:boolean;pending:Partial<Record<CredentialName,unknown>>;setPending:(name:CredentialName,body:unknown)=>void;run:(f:()=>Promise<void>)=>Promise<void>;reload:()=>Promise<Snapshot>}){
 const unlocked=data.vault.unlocked;
 const contexts=data.config.kubernetesContexts.map(c=>c.name),[listed,setListed]=useState<Listed|null>(null),[checks,setChecks]=useState<Record<string,Check|'running'>>({});
 const list=useId(),saved=data.config.prometheusSources;
 useEffect(()=>{
  if(!unlocked)return;
  void api<Listed>('/prometheus/sources').then(setListed).catch(()=>setListed(null));
 },[unlocked,data.configRevision]);
 const set=(id:string,next:PrometheusSource)=>{onChange(sources.map(s=>s.id===id?next:s));setChecks(c=>{const n={...c};delete n[id];return n;});};
 const kind=(s:PrometheusSource,k:PrometheusSource['kind'])=>{if(s.kind!==k)set(s.id,k==='url'?{id:s.id,name:s.name,kind:'url',endpoint:''}:{id:s.id,name:s.name,kind:'tunnel',context:contexts[0]??'',namespace:'',...tunnelDefaults});};
 const remove=(id:string)=>{onChange(sources.filter(s=>s.id!==id));setPending(`Prometheus/${id}`,undefined);};
 async function test(id:string){
  setChecks(c=>({...c,[id]:'running'}));
  try{const r=await api<Check>('/prometheus/test','POST',{id});setChecks(c=>({...c,[id]:r}));}
  catch(e){setChecks(c=>({...c,[id]:{ok:false,detail:e instanceof Error?e.message:'Test failed.'}}));}
 }
 return <div className="prom-sources">
  <p className="small muted">Use <strong>URL</strong> for Prometheus servers behind an ingress. Use <strong>Through Kubernetes</strong>, or the Grafana connection, for servers that are not exposed.</p>
  <datalist id={list}>{contexts.map(c=><option key={c} value={c}/>)}</datalist>
  {sources.map(s=>{const issues=prometheusSourceSchema.safeParse(s),duplicate=sources.filter(x=>x.name===s.name).length>1,check=checks[s.id];
   const unchanged=JSON.stringify(saved.find(x=>x.id===s.id))===JSON.stringify(s);
   return <fieldset key={s.id} className="prom-source">
    <div className="prom-source-head">
     <Field label="Name" hint="Shown to the agent, for example cluster-a."><input value={s.name} spellCheck={false} onChange={e=>set(s.id,{...s,name:e.target.value.toLowerCase()})}/></Field>
     <div className="segmented" role="group" aria-label="How Support reaches this server">
      <button type="button" aria-pressed={s.kind==='url'} onClick={()=>kind(s,'url')}>URL</button>
      <button type="button" aria-pressed={s.kind==='tunnel'} onClick={()=>kind(s,'tunnel')}>Through Kubernetes</button>
     </div>
    </div>
    {s.kind==='url'?<>
     <Field label="URL" hint="Base URL, without /api/v1. Example: https://prometheus.cluster-a.example.com"><input value={s.endpoint} spellCheck={false} onChange={e=>set(s.id,{...s,endpoint:e.target.value})}/></Field>
     <ServerCredential id={s.id} data={data} busy={busy} dirty={dirty} pending={pending[`Prometheus/${s.id}`]!==undefined} setPending={setPending} run={run} reload={reload}/>
    </>:<div className="prom-source-grid">
     <Field label="Context" hint="A Kubernetes context from Settings → Connections → Kubernetes. Its token needs get on services/proxy in the namespace."><input value={s.context} list={list} spellCheck={false} onChange={e=>set(s.id,{...s,context:e.target.value})}/></Field>
     <Field label="Namespace"><input value={s.namespace} spellCheck={false} onChange={e=>set(s.id,{...s,namespace:e.target.value})}/></Field>
     <Field label="Target" hint="service/NAME, or a pod name. Read through the API server proxy."><input value={s.target} spellCheck={false} onChange={e=>set(s.id,{...s,target:e.target.value})}/></Field>
     <Field label="Port"><input inputMode="numeric" value={String(s.port)} onChange={e=>set(s.id,{...s,port:Number(e.target.value.replace(/\D/g,'').slice(0,5))||0})}/></Field>
     <Field label="Path prefix" hint="Only when Prometheus uses --web.route-prefix."><input value={s.pathPrefix} placeholder="/" spellCheck={false} onChange={e=>set(s.id,{...s,pathPrefix:e.target.value})}/></Field>
    </div>}
    {!issues.success&&<p className="small error">{issues.error.issues[0]?.message}</p>}
    {duplicate&&<p className="small error">Another server already uses this name.</p>}
    {check&&check!=='running'&&<p className={'small '+(check.ok?'ok':'error')} role="status">{check.detail}</p>}
    <div className="actions">
     <button type="button" disabled={!unlocked||!unchanged||check==='running'} title={unchanged?'Uses the saved settings and credentials.':'Save settings first.'} onClick={()=>void test(s.id)}>{check==='running'?'Testing…':'Test'}</button>
     {!unchanged&&<span className="small muted">Save settings to test.</span>}
     <button type="button" className="text-button" onClick={()=>remove(s.id)}>Remove</button>
    </div>
   </fieldset>;})}
  <button type="button" disabled={sources.length>=30} onClick={()=>onChange([...sources,{id:newServerId(),name:sources.length?'':'prometheus',kind:'url',endpoint:''}])}>Add server</button>
  {listed&&<div className="prom-listed">
   <h4>Sources the agent sees</h4>
   {listed.sources.length?<ul>{listed.sources.map(s=><li key={s.name}><code>{s.name}</code><span className="badge">{kinds[s.kind]}</span><span className="small muted">{s.detail}</span></li>)}</ul>:<p className="small muted">No source yet. Add a server, or enable Grafana.</p>}
   {listed.unavailable?.map(u=><p key={u} className="small muted">{u}</p>)}
   <p className="small muted">From saved settings.</p>
  </div>}
 </div>;
}

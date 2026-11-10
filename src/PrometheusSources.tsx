import {useEffect,useId,useState} from 'react';
import {api} from './api';
import {Field} from './Field';
import {prometheusSourceSchema,type PrometheusSource} from './model';

type Listed={sources:{name:string;kind:'direct'|'grafana'|'tunnel';detail:string}[];unavailable?:string[]};
type Check={ok:boolean;detail:string};
const blank:PrometheusSource={name:'',context:'',namespace:'',target:'service/prometheus-operated',port:9090,pathPrefix:''};
const kinds={direct:'Direct',grafana:'Grafana',tunnel:'Kubernetes'};

/**
 * Editor for Prometheus servers reached through Toolbox tunnels, one per cluster, and the list of every source the agent
 * can query. **Test** opens a tunnel with the saved Toolbox settings and reads the Prometheus build info.
 */
export function PrometheusSources({sources,onChange,unlocked}:{sources:PrometheusSource[];onChange:(sources:PrometheusSource[])=>void;unlocked:boolean}){
 const [contexts,setContexts]=useState<string[]>([]),[listed,setListed]=useState<Listed|null>(null),[checks,setChecks]=useState<Record<number,Check|'running'>>({});
 const list=useId();
 useEffect(()=>{
  if(!unlocked)return;
  void api<{source:string;contexts?:{name:string}[]}>('/toolbox/status').then(s=>setContexts(s.contexts?.map(c=>c.name)??[])).catch(()=>{});
  void api<Listed>('/prometheus/sources').then(setListed).catch(()=>setListed(null));
 },[unlocked]);
 const set=(i:number,patch:Partial<PrometheusSource>)=>{onChange(sources.map((s,j)=>j===i?{...s,...patch}:s));setChecks(c=>{const n={...c};delete n[i];return n;});};
 async function test(i:number){
  setChecks(c=>({...c,[i]:'running'}));
  try{const r=await api<Check>('/prometheus/test','POST',{source:sources[i]});setChecks(c=>({...c,[i]:r}));}
  catch(e){setChecks(c=>({...c,[i]:{ok:false,detail:e instanceof Error?e.message:'Test failed.'}}));}
 }
 return <div className="prom-sources">
  <h4>Sources through Kubernetes</h4>
  <p className="small muted">For Prometheus servers that are not exposed, such as one per cluster. Support opens a Toolbox tunnel when the agent queries the source. Requires Toolbox port forwarding.</p>
  <datalist id={list}>{contexts.map(c=><option key={c} value={c}/>)}</datalist>
  {sources.map((s,i)=>{const issues=prometheusSourceSchema.safeParse(s),duplicate=sources.findIndex(x=>x.name===s.name)!==i,check=checks[i];
   return <fieldset key={i} className="prom-source">
    <div className="prom-source-grid">
     <Field label="Name" hint="Shown to the agent, for example cluster-a."><input value={s.name} spellCheck={false} onChange={e=>set(i,{name:e.target.value.toLowerCase()})}/></Field>
     <Field label="Context"><input value={s.context} list={list} spellCheck={false} onChange={e=>set(i,{context:e.target.value})}/></Field>
     <Field label="Namespace"><input value={s.namespace} spellCheck={false} onChange={e=>set(i,{namespace:e.target.value})}/></Field>
     <Field label="Target" hint="service/NAME or statefulset/NAME."><input value={s.target} spellCheck={false} onChange={e=>set(i,{target:e.target.value})}/></Field>
     <Field label="Port"><input inputMode="numeric" value={String(s.port)} onChange={e=>set(i,{port:Number(e.target.value.replace(/\D/g,'').slice(0,5))||0})}/></Field>
     <Field label="Path prefix" hint="Only when Prometheus uses --web.route-prefix."><input value={s.pathPrefix} placeholder="/" spellCheck={false} onChange={e=>set(i,{pathPrefix:e.target.value})}/></Field>
    </div>
    {!issues.success&&<p className="small error">{issues.error.issues[0]?.message}</p>}
    {duplicate&&<p className="small error">Another source already uses this name.</p>}
    {check&&check!=='running'&&<p className={'small '+(check.ok?'ok':'error')} role="status">{check.detail}</p>}
    <div className="actions"><button type="button" disabled={!issues.success||!unlocked||check==='running'} title="Uses the saved Toolbox settings." onClick={()=>void test(i)}>{check==='running'?'Testing…':'Test'}</button><button type="button" className="text-button" onClick={()=>onChange(sources.filter((_,j)=>j!==i))}>Remove</button></div>
   </fieldset>;})}
  <button type="button" disabled={sources.length>=30} onClick={()=>onChange([...sources,{...blank,name:sources.length?'':'monitoring'}])}>Add a source</button>
  {listed&&<div className="prom-listed">
   <h4>Sources the agent sees</h4>
   {listed.sources.length?<ul>{listed.sources.map(s=><li key={s.name}><code>{s.name}</code><span className="badge">{kinds[s.kind]}</span><span className="small muted">{s.detail}</span></li>)}</ul>:<p className="small muted">No source. Enable the direct connection, Grafana, or add a source through Kubernetes.</p>}
   {listed.unavailable?.map(u=><p key={u} className="small muted">{u}</p>)}
   <p className="small muted">Saved settings only. Save to refresh.</p>
  </div>}
 </div>;
}

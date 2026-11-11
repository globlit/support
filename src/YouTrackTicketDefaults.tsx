import {useEffect,useState} from 'react';
import {api} from './api';
import {Field} from './Field';
import {Select} from './Select';
import type {Config,TicketField,YouTrackProject} from './model';

type Defaults=Config['youtrackTicketDefaults'];
/**
 * Default project for tickets created from alerts and Slack requests, and default values for its required fields.
 * Projects come from the saved YouTrack connection. Each ticket draft can still choose another project.
 */
export function YouTrackTicketDefaults({value,onChange,unlocked}:{value:Defaults;onChange:(v:Defaults)=>void;unlocked:boolean}){
 const [projects,setProjects]=useState<YouTrackProject[]>([]),[fields,setFields]=useState<TicketField[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const load=(refresh=false)=>{if(!unlocked)return;setLoading(true);void api<{projects:YouTrackProject[]}>('/youtrack/projects'+(refresh?'?refresh=1':'')).then(r=>{setProjects(r.projects);setError('');}).catch(e=>setError(e instanceof Error?e.message:'Projects could not be loaded.')).finally(()=>setLoading(false));};
 useEffect(()=>load(),[unlocked]);
 useEffect(()=>{setFields([]);if(!unlocked||!value.projectId)return;let alive=true;void api<{fields:TicketField[]}>(`/youtrack/projects/${encodeURIComponent(value.projectId)}/fields`).then(r=>{if(alive)setFields(r.fields);}).catch(()=>{});return()=>{alive=false};},[value.projectId,unlocked]);
 return <div className="ticket-defaults">
  <h4>New tickets</h4>
  <Field label="Default project" hint="Preselected when a ticket is created from an alert or a Slack request. Each ticket can choose another project.">
   <span className="ticket-defaults-row"><Select value={value.projectId} disabled={!unlocked||loading} onChange={e=>onChange({projectId:e.target.value,fields:{}})}><option value="">No default</option>{value.projectId&&!projects.some(p=>p.id===value.projectId)&&<option value={value.projectId}>{value.projectId}</option>}{projects.map(p=><option key={p.id} value={p.id}>{p.shortName} · {p.name}</option>)}</Select>
   <button type="button" className="text-button" disabled={!unlocked||loading} onClick={()=>load(true)}>{loading?'Loading…':'Refresh the list'}</button></span>
  </Field>
  {error&&<p className="small error">{error} Save the YouTrack connection first.</p>}
  {fields.filter(f=>f.issueType&&f.options.length).length>0&&<div className="ticket-defaults-fields">
   <p className="small muted">Required fields of this project. Leave a field on "YouTrack default" to use the project's own default.</p>
   {fields.filter(f=>f.issueType&&f.options.length).map(f=><Field key={f.name} label={f.name}><Select value={value.fields[f.name]??''} onChange={e=>{const next={...value.fields};if(e.target.value)next[f.name]=e.target.value;else delete next[f.name];onChange({...value,fields:next});}}><option value="">YouTrack default{f.value?` (${f.value})`:''}</option>{f.options.map(o=><option key={o}>{o}</option>)}</Select></Field>)}
  </div>}
 </div>;
}

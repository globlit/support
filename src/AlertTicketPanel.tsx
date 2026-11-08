import {SafeLink} from './SafeLink';
import {ErrorRecoveryAction} from './ErrorNotice';
import {Select} from './Select';
import {Markdown,MarkdownPreview} from './Markdown';
import {useEffect,useState} from 'react';
import {AlertHandoffPanel} from './AlertHandoffPanel';
import {useWorkspaceApi} from './WorkspaceRuntime';
import type {AlertCase,YouTrackProject} from './model';

export function AlertTicketPanel({alert,busy,run,changed,openTicket,sourcePath='/alerts',hasPlan=false}:{sourcePath?:string;hasPlan?:boolean;openTicket:(ticket:NonNullable<AlertCase['ticket']>)=>void;alert:AlertCase;busy:boolean;run:(fn:()=>Promise<void>)=>Promise<void>;changed:(c:AlertCase)=>void}){const api=useWorkspaceApi();
 const d=alert.ticketCreation;
 const [projects,setProjects]=useState<YouTrackProject[]>([]),[loaded,setLoaded]=useState(false);
 const [projectId,setProjectId]=useState(d?.project.id??''),[title,setTitle]=useState(d?.title??''),[description,setDescription]=useState(d?.description??''),[ticketId,setTicketId]=useState('');
 useEffect(()=>{setProjectId(d?.project.id??'');setTitle(d?.title??'');setDescription(d?.description??'');},[d?.hash]);
 const dirty=!!d&&(projectId!==d.project.id||title!==d.title||description!==d.description);
 const act=(action:string,body:unknown={})=>run(async()=>{changed(await api<AlertCase>(sourcePath+'/'+alert.id+'/ticket/'+action,'POST',body));});
 if(alert.ticket)return <><div className="approval-box"><h2>Linked YouTrack ticket</h2><SafeLink href={alert.ticket.url} target="_blank" rel="noreferrer">{alert.ticket.key} ↗</SafeLink><p>{d?.message??'This link stays with recurring alerts.'}</p><p className="small muted">Retriggers reuse this ticket, including after it is closed. No automatic reopen, comment or new ticket.</p></div><button onClick={()=>openTicket(alert.ticket!)}>Continue in {alert.ticket.key} →</button>{sourcePath==='/alerts'&&hasPlan&&<AlertHandoffPanel alert={alert} busy={busy} run={run} openTicket={()=>openTicket(alert.ticket!)}/>}</>;
 return <section><div className="heading"><div><h2>Create a YouTrack ticket</h2><p className="subtitle">Review the destination and message before posting.</p></div><span className="badge">{d?.state==='pending'?'Checking creation':d?'Draft · Not posted':'Not linked'}</span></div>
 {d?.message&&<><p className={d.state==='pending'?'notice':'small muted'} role="status">{d.message}</p><ErrorRecoveryAction message={d.message} context="YouTrack"/></>}
 {d?.state==='pending'?<><p><strong>{d.title}</strong> → {d.project.shortName} · {d.project.name}</p><p className="small muted">{d.endpoint}</p><details className="plan-section"><summary>Approved description</summary><Markdown>{d.description+'\n\nSupport alert case: '+d.marker}</Markdown></details><button disabled={busy} onClick={()=>void act('reconcile')}>Check YouTrack status</button><p className="small muted">Read-only check. Creation is never retried automatically. If nothing is found, inspect YouTrack or check again after its search index updates.</p></>:<>
 <div className="actions"><button disabled={busy} onClick={()=>void run(async()=>{setProjects(await api<YouTrackProject[]>('/youtrack/projects'));setLoaded(true);})}>{loaded?'Refresh projects':'Load YouTrack projects'}</button></div>
 <label>Destination project<Select value={projectId} disabled={busy} onChange={e=>setProjectId(e.target.value)}><option value="">Select a project…</option>{d&&!projects.some(p=>p.id===d.project.id)&&<option value={d.project.id}>{d.project.shortName} · {d.project.name}</option>}{projects.map(p=><option key={p.id} value={p.id}>{p.shortName} · {p.name}</option>)}</Select></label>
 {loaded&&!projects.length&&<p className="muted">No available projects. Check your YouTrack token’s access.</p>}
 <button disabled={busy||!projectId||!alert.active} onClick={()=>void act('prepare',{projectId})}>{d?'Refresh draft from case':'Prepare ticket draft'}</button>
 {!alert.active&&<p className="small muted">The alert is no longer firing. Review the case before creating a ticket.</p>}
 {d&&<><p className="small muted">YouTrack instance: {d.endpoint} · Draft v{d.revision}</p><label>Ticket title<input maxLength={250} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Ticket description<textarea rows={16} maxLength={48000} value={description} onChange={e=>setDescription(e.target.value)}/></label><MarkdownPreview text={description}/>
 <p className="small muted">Included below the description:</p><p className="source-description">Support alert case: {d.marker}</p>
 <div className="actions"><button disabled={busy||!dirty||!title.trim()||!description.trim()||!projectId} onClick={()=>void act('save',{hash:d.hash,projectId,title,description})}>Save draft edits</button><button className="primary" disabled={busy||dirty||!alert.active} onClick={()=>void act('approve',{hash:d.hash})}>Approve & create ticket</button></div>
 <p className="small muted">{dirty?'Save edits before approving. ':''}Creates one issue using the project’s default fields, visibility and notification rules. No severity mapping or board assignment is guessed. Plan approval remains separate.</p></>}
 {sourcePath==='/alerts'&&<details className="plan-section"><summary>Link an existing ticket instead</summary><form onSubmit={e=>{e.preventDefault();void run(async()=>{const next=await api<{alert:AlertCase}>(sourcePath+'/'+alert.id+'/link','POST',{ticketId});changed(next.alert);});}}><label>YouTrack ticket ID<input value={ticketId} placeholder="INFRA-123" onChange={e=>setTicketId(e.target.value)} required/></label><button disabled={busy||!ticketId.trim()}>Link ticket</button><p className="small muted">Saves a local link only.</p></form></details>}
 </>}
 </section>;
}

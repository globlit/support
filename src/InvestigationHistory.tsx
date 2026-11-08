import {SafeLink} from './SafeLink';
import {sourcePage} from './intake-model';
import {ErrorNotice} from './ErrorNotice';
import {Markdown} from './Markdown';
import {routeHash} from './navigation';
import {RunSnapshots} from './RunSnapshots';
import {InvestigationTimeline} from './InvestigationTimeline';
import {Select} from './Select';
import {useEffect,useRef,useState} from 'react';
import {useWorkspaceApi} from './WorkspaceRuntime';
import type {AnalysisRun,LiveDetail} from './model';
export function InvestigationHistory({detail,run,running,error,disabled,start,cancel,onLatest,automatic=false,maxRuns=2,sourcePath='/youtrack/issues'}:{sourcePath?:string;detail:LiveDetail;run:AnalysisRun|null;running:boolean;error:string;disabled:boolean;start:()=>void;cancel:()=>void;onLatest?:(run:AnalysisRun)=>void;automatic?:boolean;maxRuns?:number}){const api=useWorkspaceApi();
 const [history,setHistory]=useState<AnalysisRun[]>([]),[selected,setSelected]=useState(''),[saved,setSaved]=useState<AnalysisRun|null>(null),[readError,setReadError]=useState(''),[view,setView]=useState<'timeline'|'technical'>('timeline');
 const latestRef=useRef(onLatest);latestRef.current=onLatest;
 useEffect(()=>{let alive=true;const read=()=>void api<AnalysisRun[]>(sourcePath+'/'+detail.issue.id+'/investigations').then(r=>{if(alive){setHistory(r);if(r[0])latestRef.current?.(r[0]);setReadError('')}}).catch(e=>{if(alive)setReadError(e.message)});void read();const timer=setInterval(()=>{if(document.visibilityState==='visible')void read()},5000);return()=>{alive=false;clearInterval(timer)}},[detail.issue.id,detail.session.revision,run?.state]);
 const latest=[run,history[0]].filter((r):r is AnalysisRun=>!!r).sort((a,b)=>b.startedAt.localeCompare(a.startedAt))[0];
 const viewedId=selected==='legacy'?'':selected||latest?.id||'';
 useEffect(()=>{if(!viewedId){setSaved(null);return}let alive=true;let timer:ReturnType<typeof setTimeout>;setSaved(null);setReadError('');async function poll(){try{const r=await api<AnalysisRun>('/analysis/'+viewedId);if(alive){setSaved(r);if(viewedId===latest?.id)latestRef.current?.(r);if(r.state==='running')timer=setTimeout(()=>void poll(),1500)}}catch(e){if(alive)setReadError((e as Error).message)}}void poll();return()=>{alive=false;clearTimeout(timer)}},[viewedId,latest?.id]);
 useEffect(()=>{if(run?.id)setSelected('')},[run?.id]);
 const shown=selected==='legacy'?null:saved?.id===viewedId?saved:run?.id===viewedId?run:history.find(r=>r.id===viewedId);
 const events:AnalysisRun['events']=selected==='legacy'?detail.session.analysis?.events??[]:shown?.events??[];
 const older=!!shown&&!!latest&&shown.id!==latest.id;
 const currentPlan=detail.session.plans.at(-1);
 const superseded=!!shown?.planVersion&&!!currentPlan&&shown.planVersion!==currentPlan.version;
 const snapshots=older||superseded;
 const planHref=routeHash({page:sourcePage(detail.issue.connection),issue:detail.issue.id,connection:detail.issue.connection,step:'plan'});
 const stale=shown?.sourceFingerprint&&shown.sourceFingerprint!==detail.issue.sourceFingerprint;
 return <section className="investigation-history"><div className="heading"><h2>Investigation</h2>{running||shown?.state==='running'?<button onClick={()=>{if(running)cancel();else if(shown)void api('/analysis/'+shown.id+'/cancel','POST',{}).catch(e=>setReadError(e.message))}}>Stop investigation</button>:<button className="primary" disabled={disabled||detail.issue.resolved} onClick={()=>{setSelected('');start()}}>{events.length?'Investigate again':'Start investigation'}</button>}</div><p className="section-description">Review what the agent checked and what it found. Open a check for its query, result, and conclusion.</p>
 <label className="run-picker">Investigation run<Select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">{latest?`Latest · ${latest.state==='ready'?'Plan v'+latest.planVersion+' ready':latest.state}`:'Latest run'}</option>{detail.session.analysis&&<option value="legacy">Earlier activity · summary only</option>}{history.map(r=><option key={r.id} value={r.id}>{new Date(r.startedAt).toLocaleString()} · {r.state}{r.planVersion?` · Plan v${r.planVersion}`:''}</option>)}</Select></label>
 {older&&<div className="earlier-run-notice"><span>Viewing an earlier investigation.{latest?.state==='ready'?` A newer run produced plan v${latest.planVersion}.`:''}</span><button type="button" className="text-button" onClick={()=>setSelected('')}>View latest run →</button></div>}
 {(error||readError)&&<ErrorNotice message={error||readError} context="Model"/>}{shown&&<p className="run-summary">{shown.state==='ready'?'Plan prepared':shown.state==='failed'?'Could not complete':shown.state==='cancelled'?'Stopped':'In progress'} · {shown.model??'Model not recorded'} · {new Date(shown.startedAt).toLocaleString()}{shown.planVersion?` · Produced plan v${shown.planVersion}`:''}</p>}{stale&&<p className="history-notice">The ticket priority, requirements or comments have changed since this run. Investigate again before relying on these findings.</p>}{shown?.error&&<div className="investigation-blocker"><h3>{older?'This earlier investigation failed':'This investigation did not produce a new plan'}</h3><ErrorNotice message={shown.error} context="Model"/><p className="small muted">Earlier plans are unchanged. Review the reported failure before investigating again.</p></div>}
 {!shown&&events.length>0&&<p className="small muted">Legacy activity: tool inputs and outputs were not stored for this older run.</p>}
 <nav className="investigation-views" aria-label="Investigation view"><button type="button" aria-pressed={view==='timeline'} onClick={()=>setView('timeline')}>Timeline</button><button type="button" aria-pressed={view==='technical'} onClick={()=>setView('technical')}>Technical details</button></nav>
 <div hidden={view!=='timeline'}><InvestigationTimeline key={viewedId||'legacy'} events={events} run={shown}
 outcomeTitle={shown?.state==='ready'?(snapshots?`Plan${shown.planVersion?` v${shown.planVersion}`:''} saved in this run`:detail.session.approval?'Plan approved':undefined):undefined}
 outcomeDescription={shown?.state==='ready'?(snapshots?'Historical snapshots are available below.':stale?'The ticket changed. Review the current requirements first.':detail.session.approval?'Continue in the Plan step.':'Review the proposal before any changes are prepared.'):undefined}
 outcome={shown?.state==='ready'&&!snapshots?<nav className="investigation-review-links" aria-label="Review investigation results">{shown.plan&&currentPlan&&<SafeLink href={planHref} aria-disabled={disabled||undefined} onClick={e=>{if(disabled)e.preventDefault()}}>{detail.session.approval?'View approved plan':'Review plan'} →</SafeLink>}</nav>:undefined}/>
 {shown&&snapshots&&(shown.plan||shown.replyDraft)&&<RunSnapshots run={shown} issueKey={detail.issue.key} planHref={planHref}/>}

 </div>
 {view==='technical'&&<section className="investigation-technical" aria-label="Run technical details"><h3>Run activity</h3><p className="small muted">Recorded progress messages for the selected investigation. Tool queries and results are available in Timeline.</p>{events.some(e=>!e.tool)?<ol>{events.filter(e=>!e.tool).map((event,i)=><li key={i}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time><span>{event.text}</span></li>)}</ol>:<p className="stage-waiting">No progress messages recorded for this run.</p>}{detail.session.notes.filter(n=>!n.text.startsWith('Revision requested: ')).length>0&&<details className="conversation-history"><summary>Earlier investigation notes</summary><p className="small muted">Saved before feedback moved to Plan review. These notes remain part of the work session.</p>{detail.session.notes.filter(n=>!n.text.startsWith('Revision requested: ')).map((n,i)=><article className="conversation-entry" key={n.id??i}><time>{new Date(n.at).toLocaleString()}</time><Markdown>{n.text}</Markdown></article>)}</details>}</section>}
 {!events.length&&<p className="stage-waiting">{viewedId&&!shown?'Loading this run…':automatic?`Queued for automatic investigation · up to ${maxRuns} at a time. Start investigation starts this request now if a slot is available.`:'No recorded actions yet. Start an investigation to prepare a plan.'}</p>}
 <p className="small muted">Investigate again to check the latest ticket and comments. To request changes, add feedback in Plan review.</p></section>;
}

import {SafeLink} from './SafeLink';
import {RecoveryState} from './RecoveryState';
import {IntakeDecision} from './IntakeDecision';
import {ErrorNotice} from './ErrorNotice';
import {youTrackRecovery} from './youtrack-recovery';
import {useSavedFilter} from './saved-filters';
import {IssueList,issueTone} from './IssueList';
import {useRouteChoice} from './navigation-hooks';
import {useWorkspaceNavigation} from './WorkspaceRuntime';
import {RefreshButton} from './RefreshButton';
import {PlanReview} from './PlanReview';
import {IssueFlow,currentStage,type ReviewStage} from './IssueFlow';
import {Markdown} from './Markdown';
import {useEffect,useRef,useState} from 'react';
import {HandoffContext} from './AlertHandoffPanel';
import {ChangesPanel} from './ChangesPanel';
import {AnalysisPanel} from './AnalysisPanel';
import {useWorkspaceApi} from './WorkspaceRuntime';
import {ApiError} from './api';
import type {AnalysisRun,ChangeSet,LiveDetail,SourceIssue,Snapshot,PlanAnnotation} from './model';
type Page={issues:SourceIssue[];hasMore:boolean;offset:number;loadedAt:string;query:string};
export function YouTrackTickets({data,initialIssue}:{data:Snapshot;initialIssue?:{id:string;connection:string}}){const {navigate,readRoute}=useWorkspaceNavigation();const api=useWorkspaceApi();
 const [loadStatus,setLoadStatus]=useState<number>();
 const filterScope='youtrack:'+data.config.connections.YouTrack.endpoint+':'+data.config.connections.YouTrack.scope;
 const [page,setPage]=useState<Page|null>(null),[detail,setDetail]=useState<LiveDetail|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[offset,setOffset]=useState(0),[view,setView]=useRouteChoice('section',['list','board'] as const,'list'),[search,setSearch]=useSavedFilter<string>(filterScope+'.search',''),[notice,setNotice]=useState('');const [analysisRequest,setAnalysisRequest]=useState(0);const [latestRun,setLatestRun]=useState<AnalysisRun|null>(null);const [selectedStage,updateStage]=useState<ReviewStage>((readRoute().step as ReviewStage)||'plan');const [planEditing,setPlanEditing]=useState(false);const [agentRunning,setAgentRunning]=useState(false);const [workChanges,setWorkChanges]=useState<ChangeSet[]>([]),[workLoaded,setWorkLoaded]=useState(false),[workError,setWorkError]=useState('');const loadedRevision=useRef(0);const sequence=useRef(0),opened=useRef<string|null>(null);
 // True while the stage follows the ticket's progress: the ticket opened without a step and no step was chosen.
 const autoStage=useRef(false);
 const setSelectedStage=(step:ReviewStage)=>{autoStage.current=false;updateStage(step);const route=readRoute();if(route.page==='youtrack'&&route.issue)navigate({...route,step});};
 useEffect(()=>{const sync=()=>{const step=readRoute().step;if(['request','investigation','plan','implementation','message'].includes(step??'')){autoStage.current=false;updateStage(step as ReviewStage);}};window.addEventListener('support:navigate',sync);window.addEventListener('popstate',sync);window.addEventListener('hashchange',sync);return()=>{window.removeEventListener('support:navigate',sync);window.removeEventListener('popstate',sync);window.removeEventListener('hashchange',sync)}},[]);
 const [refreshing,setRefreshing]=useState(false),[syncError,setSyncError]=useState('');
 const live=useRef({detail,page,busy,offset});live.current={detail,page,busy,offset};
 const syncing=useRef(false);
 async function refreshSource(){
  const current=live.current;if(current.busy||syncing.current||(!current.detail&&!current.page))return;
  syncing.current=true;setRefreshing(true);const seq=sequence.current;
  try{
   if(current.detail){
    const fresh=await api<LiveDetail>('/youtrack/issues/'+encodeURIComponent(current.detail.issue.id));
    const active=live.current.detail;
    if(seq===sequence.current&&!live.current.busy&&active?.issue.id===fresh.issue.id&&active.issue.connection===fresh.issue.connection&&fresh.session.revision>=active.session.revision)setDetail(fresh);
   }else{
    const fresh=await api<Page>('/youtrack/issues?offset='+current.offset);
    if(seq===sequence.current&&!live.current.busy&&!live.current.detail)setPage(fresh);
   }
   if(seq===sequence.current)setSyncError('');
  }catch(e){if(seq===sequence.current)setSyncError((e as Error).message)}finally{syncing.current=false;setRefreshing(false)}
 }
 const refreshSourceRef=useRef(refreshSource);refreshSourceRef.current=refreshSource;
 useEffect(()=>{
  if(!data.vault.unlocked)return;
  const check=()=>{if(document.visibilityState==='visible')void refreshSourceRef.current()};
  const timer=setInterval(check,30000);window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);
  return()=>{clearInterval(timer);window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',check)};
 },[data.vault.unlocked,data.configRevision]);
 async function load(id?:string,skip=offset){if(id&&opened.current!==id){opened.current=id;setLatestRun(null);const route=readRoute();const explicit=route.issue===id&&['request','investigation','plan','implementation','message'].includes(route.step??'');autoStage.current=!explicit;updateStage(explicit?route.step as ReviewStage:'request');}const seq=++sequence.current;setBusy(true);setError('');setLoadStatus(undefined);setNotice('');setSyncError('');setDetail(null);setPage(null);if(youTrackRecovery(data)){setBusy(false);return;}try{if(id){const r=await api<LiveDetail>('/youtrack/issues/'+encodeURIComponent(id));if(initialIssue?.id===id&&initialIssue.connection&&r.issue.connection!==initialIssue.connection)throw new Error('Restore the linked YouTrack connection before opening this work session.');if(seq===sequence.current){loadedRevision.current=data.configRevision;setDetail(r);if(autoStage.current)updateStage(currentStage(r,[]));const route=readRoute();if(route.issue!==id||!route.connection)navigate({page:'youtrack',issue:id,connection:r.issue.connection,step:route.issue===id?route.step:undefined});}}else{const r=await api<Page>('/youtrack/issues?offset='+skip);if(seq===sequence.current){setPage(r);setOffset(skip);if(readRoute().issue)navigate({page:'youtrack',section:view});}}}catch(e){if(seq===sequence.current){setError((e as Error).message);setLoadStatus(e instanceof ApiError?e.status:undefined)}}finally{if(seq===sequence.current)setBusy(false)}}
 useEffect(()=>{if(data.vault.unlocked&&detail&&loadedRevision.current===data.configRevision&&detail.issue.id===initialIssue?.id&&detail.issue.connection===initialIssue?.connection)return;void load(initialIssue?.id,0);return()=>{sequence.current++}},[data.configRevision,data.vault.unlocked,initialIssue?.id,initialIssue?.connection]);
 useEffect(()=>{if(!detail)return;let alive=true;setWorkLoaded(false);setWorkError('');setWorkChanges([]);api<ChangeSet[]>('/youtrack/issues/'+detail.issue.id+'/changes').then(c=>{if(alive){setWorkChanges(c);setWorkLoaded(true);if(autoStage.current){autoStage.current=false;updateStage(currentStage(detail,c,agentRunning));}}}).catch(e=>{if(alive){setWorkError(e.message);setWorkLoaded(true)}});return()=>{alive=false}},[detail?.issue.id,detail?.session.revision]);
 async function action(action:string,text?:string,annotation?:PlanAnnotation){if(!detail)return false;setBusy(true);setError('');try{const next=await api<LiveDetail>('/youtrack/issues/'+encodeURIComponent(detail.issue.id)+'/action','POST',{action,text,annotation,revision:detail.session.revision,sourceUpdated:detail.issue.updated});setDetail(next);setNotice(action==='approve'?'Plan approved. Select Implementation to prepare changes.':'Saved locally. YouTrack was not changed.');return true;}catch(e){setError((e as Error).message);return false;}finally{setBusy(false)}}

 const humanHeld=!!detail?.session.handling&&detail.session.handling.mode!=='investigate';
 const recovery=youTrackRecovery(data,error,loadStatus);
 const matches=page?.issues.filter(i=>`${i.key} ${i.title}`.toLowerCase().includes(search.toLowerCase()))??[];
 return <div className="page"><div className="heading"><div><h1>{detail?detail.issue.title:'YouTrack tickets'}</h1>{detail&&<p className="subtitle">{detail.issue.key} · {detail.issue.project}</p>}</div><div className="actions">{detail&&<><SafeLink className="source-link" href={detail.issue.url} target="_blank" rel="noreferrer">{detail.issue.key} in YouTrack ↗</SafeLink><RefreshButton label="Refresh ticket from YouTrack" disabled={busy} refreshing={refreshing} onClick={()=>void refreshSource()}/></>}</div></div>{error&&(page||detail)&&<ErrorNotice message={error} context="YouTrack"/>}{syncError&&<ErrorNotice message={syncError} context="YouTrack" detail="Ticket updates could not be checked." retry={()=>void refreshSource()}/>}{notice&&<p className="success" role="status">{notice}</p>}{busy&&<p className="muted" role="status">Reading YouTrack…</p>}
 {!busy&&!page&&!detail&&(recovery?<RecoveryState recovery={recovery} retry={()=>void load(initialIssue?.id,0)}/>:<div className="empty-state" role="status"><h2>No tickets loaded</h2><p>Load tickets from your configured YouTrack project.</p><button onClick={()=>void load(initialIssue?.id,0)}>Retry</button></div>)}
 {page&&<><div className="queue-toolbar"><div className="queue-search"><input type="search" aria-label="Search loaded YouTrack tickets" placeholder="Filter tickets…" value={search} onChange={e=>setSearch(e.target.value)}/><span className="queue-scope" title={page.query}>{page.query}</span></div><div className="actions"><div className="segmented"><button aria-pressed={view==='list'} onClick={()=>setView('list')}>List</button><button aria-pressed={view==='board'} onClick={()=>setView('board')}>Board</button></div><RefreshButton label="Refresh tickets from YouTrack" disabled={busy} refreshing={refreshing} onClick={()=>void refreshSource()}/></div></div>{view==='list'?<IssueList scope={filterScope} issues={matches} open={id=>void load(id)}/>:<div className="board">{[...new Set(matches.map(i=>i.status))].map(s=><section key={s}><div className="column-heading"><h2>{s}</h2><span>{matches.filter(i=>i.status===s).length}</span></div>{matches.filter(i=>i.status===s).map(i=><button key={i.id} className="ticket-card" onClick={()=>{void load(i.id)}}><span className="small muted">{i.key}</span><h3>{i.title}</h3><span className="small muted">{i.severity} · {i.assignee}</span></button>)}</section>)}</div>}{!matches.length&&<div className="empty-state">No matching tickets on this page.</div>}<div className="list-footer"><button disabled={busy||offset===0} onClick={()=>void load(undefined,Math.max(0,offset-50))}>← Previous</button><span>{page.issues.length} loaded · Page {offset/50+1} · Updated {new Date(page.loadedAt).toLocaleTimeString()}</span><button disabled={busy||!page.hasMore} onClick={()=>void load(undefined,offset+50)}>Next →</button></div></>}
 {detail&&<><div className="actions"><button disabled={busy||planEditing} onClick={()=>void load(undefined)}>← Go back</button><span className={'status-pill '+issueTone(detail.issue)}>{detail.issue.status}</span><span className="ticket-priority">Priority · {detail.issue.severity}</span>{detail.issue.assignee&&<span className="badge">{detail.issue.assignee}</span>}</div>{detail.session.sourceChangedAt&&<div className="source-update" role="status"><div><strong>Ticket updated in YouTrack</strong><p>Priority, requirements or comments may have changed. Any previous approval was cleared. Review the current request before continuing.</p></div><button className="text-button" disabled={planEditing} onClick={()=>setSelectedStage('request')}>Review request</button></div>}{humanHeld&&<div className="notice">{detail.session.handling?.mode==='human'?'Engineer handling this ticket':detail.session.handling?.mode==='refused'?'Ticket refused locally':'Resolved by engineer'} · Agent work is stopped. <button className="text-button" onClick={()=>setSelectedStage('request')}>Review handling →</button></div>}<div className="case-workspace"><IssueFlow latestRun={latestRun} selected={selectedStage} onSelect={setSelectedStage} disabled={planEditing} running={agentRunning} detail={detail} changes={workChanges} loaded={workLoaded} error={workError}/><main className="case-content" id="review-work">
 <section hidden={selectedStage!=='request'} className="case-stage"><IntakeDecision detail={detail} changed={setDetail}/><h2>Request</h2><Markdown>{detail.issue.description||'No description supplied.'}</Markdown>{detail.issue.comments?.length? <details><summary>Ticket comments · {detail.issue.comments.length}</summary>{detail.issue.comments.map(c=><article key={c.id} className="review-note"><small>{new Date(c.updated).toLocaleString()}</small><Markdown>{c.text}</Markdown></article>)}</details>:null}{detail.session.alertHandoffs?.map(h=><HandoffContext key={h.id} handoff={h}/>)}</section>
 <section hidden={selectedStage!=='investigation'} className="case-stage"><AnalysisPanel automatic={data.config.autoInvestigate&&data.config.connections.Model.enabled} maxRuns={data.config.maxRuns} startRequest={analysisRequest} onLatest={setLatestRun} historyView key={detail.issue.connection+detail.issue.id} detail={detail} onRunning={setAgentRunning} disabled={busy||planEditing||humanHeld} refresh={()=>void refreshSourceRef.current()}/></section>
 <div hidden={selectedStage!=='plan'}><PlanReview active={selectedStage==='plan'} key={detail.issue.connection+detail.issue.id} detail={detail} busy={busy||humanHeld} running={agentRunning} onEditing={setPlanEditing} action={action} investigate={()=>{if(!busy&&!agentRunning&&!detail.issue.resolved){setSelectedStage('investigation');setAnalysisRequest(n=>n+1)}}}/>{!detail.session.plans.length&&<button className="primary" onClick={()=>setSelectedStage('investigation')}>Start with investigation →</button>}{detail.session.approval&&<button onClick={()=>setSelectedStage('implementation')}>Continue to implementation →</button>}</div>
 <section hidden={selectedStage!=='implementation'&&selectedStage!=='message'} id="delivery-review" className="decision-section">
 {selectedStage!=='message'&&<><header className="decision-heading"><div><span className="section-caption">Review changes, then publish</span><h2>Implementation</h2></div><span className="small muted">Separate approval</span></header><p className="section-description">Uses the approved plan to prepare a branch. Review the diff and MR message before creating the merge request.</p></>}
 {humanHeld?<p className="stage-waiting">Agent delivery is paused. Return the ticket to the agent in Request before continuing.</p>:!workLoaded||workError?<p className="stage-waiting">{workError||'Loading saved changes…'}</p>:<ChangesPanel key={detail.issue.connection+detail.issue.id} view={selectedStage==='message'?'reply':'implementation'} detail={detail} data={data} onChanges={setWorkChanges} refresh={()=>void load(detail.issue.id)}/>}
 </section>

</main></div>
 </>}
 </div>
}

import {ErrorNotice,ErrorRecoveryAction} from './ErrorNotice';
import {InvestigationHistory} from './InvestigationHistory';
import {useEffect,useRef,useState} from 'react';
import {useWorkspaceApi,useWorkspacePreview} from './WorkspaceRuntime';
import type {AnalysisRun,LiveDetail} from './model';
import {useFeedback} from './Toasts';

export function AnalysisPanel({detail,disabled,refresh,sourcePath='/youtrack/issues',initialRun,onRunning,historyView=false,onLatest,startRequest=0,automatic=false,maxRuns=2}:{detail:LiveDetail;disabled:boolean;refresh:()=>void;sourcePath?:string;initialRun?:AnalysisRun;onRunning?:(running:boolean)=>void;historyView?:boolean;onLatest?:(run:AnalysisRun)=>void;startRequest?:number;automatic?:boolean;maxRuns?:number}){const api=useWorkspaceApi();const preview=useWorkspacePreview();
 const storageKey=`analysis:${detail.issue.connection}:${detail.issue.id}`;
 const [run,setRun]=useState<AnalysisRun|null>(initialRun??null),[starting,setStarting]=useState(false),[error,setError]=useState(''),feedback=useFeedback();
 const [runId,setRunId]=useState(()=>(preview?null:sessionStorage.getItem(storageKey))??(initialRun?.state==='running'?initialRun.id:null));
 const refreshRef=useRef(refresh);refreshRef.current=refresh;
 useEffect(()=>{
  if(!runId)return;let disposed=false;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const next=await api<AnalysisRun>('/analysis/'+runId);if(disposed)return;setRun(next);if(next.state==='running')timer=setTimeout(()=>void poll(),1200);else{sessionStorage.removeItem(storageKey);setRunId(null);if(next.state==='ready')refreshRef.current();}}catch(e){if(!disposed){setError((e as Error).message);setRunId(null);sessionStorage.removeItem(storageKey);}}};
  void poll();return()=>{disposed=true;clearTimeout(timer)};
 },[runId,storageKey]);
 async function start(){setStarting(true);setError('');try{const fresh=await api<LiveDetail>(sourcePath+'/'+detail.issue.id);const next=await api<AnalysisRun>(sourcePath+'/'+detail.issue.id+'/analyze','POST',{revision:fresh.session.revision,sourceUpdated:fresh.issue.updated});setRun(next);sessionStorage.setItem(storageKey,next.id);setRunId(next.id);feedback.info('Investigation started.');}catch(e){feedback.error(e,<ErrorRecoveryAction message={(e as Error).message} context="Model"/>)}finally{setStarting(false)}}
 const handledRequest=useRef(startRequest);useEffect(()=>{if(startRequest>handledRequest.current){handledRequest.current=startRequest;void start()}},[startRequest]);
 const running=starting||!!runId;
 useEffect(()=>{onRunning?.(running);return()=>onRunning?.(false)},[running,onRunning]);
 const imported=detail.session.alertHandoffs?.find(h=>h.targetPlanVersion===detail.session.plans.at(-1)?.version);
 const events=run?.events??(imported?imported.analysis?.events:detail.session.analysis?.events)??[];
 if(historyView)return <InvestigationHistory sourcePath={sourcePath} automatic={automatic} maxRuns={maxRuns} onLatest={latest=>{onLatest?.(latest);if(latest.state==='running'&&latest.id!==runId){setRunId(latest.id);sessionStorage.setItem(storageKey,latest.id)}}} detail={detail} run={run} running={running} error={error} disabled={disabled} start={()=>void start()} cancel={()=>{if(runId)void api('/analysis/'+runId+'/cancel','POST',{}).catch(e=>setError(e.message))}}/>;
 return <section className="analysis-panel" aria-label="Model analysis"><div className="heading"><div><h2>{running?'Agent investigating':run?.state==='failed'?'Agent needs attention':run?.state==='cancelled'?'Investigation stopped':detail.session.pendingRevision?'Ready to revise':detail.session.plans.length?'Agent waiting for you':'Agent ready'}</h2><p className="small muted">{running?'Reading the ticket and permitted tools. You can stop this investigation.':detail.session.pendingRevision?'Feedback saved. Start a new analysis to update the plan.':detail.session.plans.length?'A plan is ready. Review it before any changes are prepared.':'Start a read-only investigation to prepare a plan.'}</p></div><div className="actions"><button className={detail.session.plans.length?undefined:"primary"} disabled={disabled||running||detail.issue.resolved} onClick={()=>void start()}>{detail.session.plans.length?'Revise with agent':'Start investigation'}</button>{runId&&<button onClick={()=>void api('/analysis/'+runId+'/cancel','POST',{}).catch(e=>setError(e.message))}>Stop investigation</button>}</div></div>{error&&<ErrorNotice message={error} context="Model"/>}{run?.error&&<ErrorNotice message={run.error} context="Model"/>}{events.length>0&&<p className="agent-last-action small"><strong>Last activity</strong><br/>{events.at(-1)!.text}</p>}{events.length>0&&<details open={running}><summary>Activity · {running?'Running':run?.state??(imported?'Imported alert activity':'Plan ready')}</summary><ol className="analysis-events" aria-live="polite">{events.map((e,i)=><li key={i}><time>{new Date(e.at).toLocaleTimeString()}</time> {e.text}</li>)}</ol></details>}<p className="small muted">Investigation uses read tools only. Branch writes, MR creation and resolution messages require separate approvals.</p></section>
}

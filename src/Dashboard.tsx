import {RecoveryState,vaultRecovery} from './RecoveryState';
import {ErrorNotice} from './ErrorNotice';
import {TokenChart} from './TokenChart';
import {logTools} from './diagnostics-model';

import {runLink} from './dashboard-links';
import {ToolHealthGrid} from './ToolHealthGrid';
import {useRouteChoice} from './navigation-hooks';
import {useEffect,useState} from 'react';
import {useWorkspaceApi,useWorkspaceNavigation} from './WorkspaceRuntime';
import {Select} from './Select';
import {RefreshButton} from './RefreshButton';
import type {Snapshot} from './model';
import type {DashboardData} from './dashboard-model';
const duration=(seconds:number|null)=>seconds===null?'—':seconds<60?Math.round(seconds)+'s':seconds<3600?(seconds/60).toFixed(1)+'m':(seconds/3600).toFixed(1)+'h';
const stateLabels:Record<string,string>={running:'Running',waiting:'Awaiting next step',blocked:'Blocked / failed',stopped:'Stopped',completed:'Finished'};
export function Dashboard({data}:{data:Snapshot}){const api=useWorkspaceApi();const {navigate}=useWorkspaceNavigation();
 const [range,setRange]=useRouteChoice('step',['7','14','30'],'7');
 const [interval,setIntervalChoice]=useRouteChoice('section',['hour','day'] as const,'day');
 const days=Number(range),hourly=interval==='hour';
 const [summary,setSummary]=useState<DashboardData|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{if(!data.vault.unlocked){setSummary(null);return;}let alive=true;setSummary(null);async function load(){try{const next=await api<DashboardData>(`/dashboard?days=${days}&interval=${interval}`);if(alive){setSummary(next);setError('')}}catch(e){if(alive)setError((e as Error).message)}}void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load()},15000);return()=>{alive=false;clearInterval(timer)}},[days,interval,refresh,data.vault.unlocked]);
 const openWork=(step='all')=>navigate({page:'ai',section:'workflows',step,tool:'all',focus:'dashboard'});
 const openRuns=(state='all',bucket?:string)=>{if(summary)navigate(runLink(summary,state,bucket))};
 const openLogs=(tool='')=>navigate({page:'logs',tool,focus:'dashboard'});
 const max=Math.max(1,...(summary?.daily.map(d=>d.completed+d.failed+d.running+d.stopped)??[]));
 const totalEntries=summary?.tools.reduce((n,t)=>n+t.requests,0)??0,toolErrors=summary?.tools.reduce((n,t)=>n+t.errors,0)??0;
 if(!data.vault.unlocked)return <div className="page"><div className="heading"><h1>Dashboard</h1></div><RecoveryState recovery={vaultRecovery(data.vault,'view recorded activity')}/></div>;
 return <div className="page dashboard dashboard-dense"><div className="heading"><div><h1>Dashboard</h1></div><div className="actions"><div className="segmented" aria-label="Dashboard interval"><button aria-pressed={hourly} onClick={()=>setIntervalChoice('hour')}>Hourly</button><button aria-pressed={!hourly} onClick={()=>setIntervalChoice('day')}>Daily</button></div>{hourly?<span className="small muted">Last 24 hours</span>:<Select aria-label="Dashboard time range" value={days} onChange={e=>setRange(e.target.value)}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option></Select>}<RefreshButton label="Refresh dashboard" onClick={()=>setRefresh(n=>n+1)}/></div></div>
 {error?<ErrorNotice message={error}/>:!summary?<p role="status">Loading activity…</p>:<>
 <div className="dashboard-kpis">
 <button className="dashboard-kpi" onClick={()=>openWork('running')}><span>Running now</span><strong>{summary.workflows.running}</strong><small>View running workflows →</small></button>
 <button className="dashboard-kpi" onClick={()=>openWork('waiting')}><span>Awaiting next step</span><strong>{summary.workflows.waiting}</strong><small>Review or external work →</small></button>
 <button className="dashboard-kpi" onClick={()=>openWork('blocked')}><span>Blocked / failed</span><strong className={summary.workflows.blocked?'amber':''}>{summary.workflows.blocked}</strong><small>Errors or recovery needed →</small></button>
 <button className="dashboard-kpi" onClick={()=>openRuns('finished')}><span>Run completion</span><strong>{summary.completionRate===null?'—':summary.completionRate+'%'}</strong><small>{summary.completedRuns} / {summary.completedRuns+summary.failedRuns+summary.stoppedRuns} finished runs →</small></button>
 <button className="dashboard-kpi" onClick={()=>openRuns('finished')}><span>Median run time</span><strong>{duration(summary.medianSeconds)}</strong><small>Including failed runs →</small></button>
 <button className="dashboard-kpi" onClick={()=>openRuns()}><span>Tool checks</span><strong>{summary.checks}</strong><small>Across {summary.totalRuns} runs →</small></button>
 </div>
 <div className="dashboard-grid">
 <section className="chart-panel"><header><h2>Run activity</h2><span className="small muted">{summary.totalRuns} runs · {summary.timezone}</span></header><div className="chart-legend"><span className="legend-ready">Completed</span><span className="legend-failed">Failed</span><span className="legend-stopped">Stopped</span><span className="legend-running">Running</span></div>
 <div className="bar-chart" role="group" aria-label={`${hourly?'Hourly':'Daily'} run activity. Select a bar to view its runs.`}>{summary.daily.map((d,i)=><div className="chart-column" key={d.date} title={`${d.date} · ${d.label}: ${d.completed} completed, ${d.failed} failed, ${d.stopped} stopped, ${d.running} running`}><div className="chart-stack">{(['completed','failed','stopped','running'] as const).map(k=>d[k]>0&&<button key={k} className={'chart-segment '+k} aria-label={`${d.label}: ${d[k]} ${k} runs`} title={`${d[k]} ${k} · View runs`} onClick={()=>openRuns(k,d.date)} style={{height:(d[k]/max*96)+'px'}}/>)}</div><span>{(i%Math.ceil(summary.daily.length/8)===0&&i<summary.daily.length-Math.ceil(summary.daily.length/8))||i===summary.daily.length-1?(hourly?d.label.split(' ')[0]:d.label):'\u00a0'}</span></div>)}</div>
 <details className="chart-data"><summary>{summary.totalRuns?'Exact counts':'No runs in this period · view counts'}</summary><div className="table-wrap"><table><thead><tr><th>{hourly?'Hour':'Day'}</th><th>Completed</th><th>Failed</th><th>Stopped</th><th>Running</th></tr></thead><tbody>{summary.daily.map(d=><tr key={d.date}><td title={d.date}>{d.label}</td>{(['completed','failed','stopped','running'] as const).map(k=><td key={k}><button className="text-button" aria-label={`${d.label}: ${d[k]} ${k} runs`} onClick={()=>openRuns(k,d.date)}>{d[k]}</button></td>)}</tr>)}</tbody></table></div></details></section>
 <section className="chart-panel"><header><h2>Workflow states</h2><button className="text-button" onClick={()=>openWork()}>Open AI →</button></header>{Object.entries(summary.workflows).map(([state,count])=><button className="metric-row" key={state} onClick={()=>openWork(state)}><span>{stateLabels[state]}</span><div className="metric-track"><span className={'state-bar '+state} style={{width:`${count/Math.max(1,...Object.values(summary.workflows))*100}%`}}/></div><strong>{count}</strong></button>)}<p className="small muted">Awaiting: review or external work. Blocked: failure or recovery required.</p></section>
 <TokenChart data={summary}/>
 <section className="chart-panel model-usage"><header><h2>Model usage</h2><button className="text-button" onClick={()=>openLogs('Model')}>Open model logs →</button></header><div className="usage-stats"><div><strong>{summary.usage?.responses?summary.usage.input.toLocaleString():'—'}</strong><span>Input tokens</span></div><div><strong>{summary.usage?.responses?summary.usage.output.toLocaleString():'—'}</strong><span>Output tokens</span></div><div><strong>{summary.usage?.cacheReadReported?summary.usage.cacheRead.toLocaleString():'—'}</strong><span>Cached input¹</span></div>{!!summary.usage?.webSearches&&<div><strong>{summary.usage.webSearches.toLocaleString()}</strong><span>Web searches</span></div>}</div><p className="small muted">{summary.usage?.responses?`${summary.usage.responses} responses with reported usage. ¹Included in input.`:'No token counts recorded yet. New model responses will populate this view.'}</p>{!!summary.usage?.limits.length&&<div className="usage-limits"><span className="small muted">API rate limits · last reported {summary.usage.limitsAt?new Date(summary.usage.limitsAt).toLocaleString():''}</span>{summary.usage.limits.map(l=><p key={l.name}>{l.name}: {l.remaining!==undefined?`${l.remaining} remaining`:''}{l.limit!==undefined?` / ${l.limit}`:''}{l.reset?` · resets ${l.reset}`:''}</p>)}</div>}</section>
 <section className="chart-panel tool-health-panel"><header><h2>Tool health</h2><span className="small muted">Checks every minute · Hover for details</span></header><ToolHealthGrid items={summary.health??[]} openTool={tool=>logTools.includes(tool as typeof logTools[number])?openLogs(tool):navigate({page:'settings',section:'Connections',tool})}/><p className="small muted">{totalEntries} log entries · {toolErrors} errors in period. One failed check: stale · Two: failed</p></section>


 </div>
 </> }</div>;
}

import {Fragment,useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api';
import {navigate,type Route} from './navigation';

type FeedKind='run-start'|'step'|'tool'|'command'|'output'|'result'|'error'|'run-end';
export type FeedEntry={seq:number;at:string;runId:string;title:string;route?:{page:string;issue:string};kind:FeedKind;text:string};
type Running={runId:string;title:string;route:{page:string;issue:string};startedAt:string;lastStep:string};
export type AgentState={halted:boolean;running:Running[];sandbox:{configured:boolean;reachable:boolean;commandsEnabled:boolean}};
const markers:Record<FeedKind,string>={'run-start':'▸','step':'·','tool':'→','command':'$','output':' ','result':'←','error':'!','run-end':'■'};
const keep=1500;
const stored=(key:string,fallback:string)=>{try{return localStorage.getItem(key)??fallback}catch{return fallback}};
const store=(key:string,value:string)=>{try{localStorage.setItem(key,value)}catch{}};

/** Time as HH:MM:SS, 24-hour, so every line has the same width. */
export const clock=(at:string)=>new Date(at).toLocaleTimeString('en-GB',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
/** Ticket or alert key of a run title such as "INFRA-42 · Disk full". */
export const runKey=(title:string)=>title.split(' · ')[0];
type RunTab={runId:string;key:string;title:string;route?:{page:string;issue:string};running:boolean};
/** Running runs first, then the 5 most recent finished runs present in the feed. */
export function runTabs(entries:FeedEntry[],running:Running[]):RunTab[]{
 const tabs:RunTab[]=running.map(r=>({runId:r.runId,key:runKey(r.title),title:r.title,route:r.route,running:true}));
 const finished:RunTab[]=[];
 for(let i=entries.length-1;i>=0&&finished.length<5;i--){const e=entries[i];if(!tabs.some(t=>t.runId===e.runId)&&!finished.some(t=>t.runId===e.runId))finished.push({runId:e.runId,key:runKey(e.title),title:e.title,route:e.route,running:false});}
 return [...tabs,...finished];
}
/** Merges new entries into the list by sequence number and keeps the last 1,500. */
export function mergeEntries(list:FeedEntry[],added:FeedEntry[]){const seen=new Set(list.map(e=>e.seq));const next=[...list,...added.filter(e=>!seen.has(e.seq))].sort((a,b)=>a.seq-b.seq);return next.length>keep?next.slice(-keep):next;}

/**
 * Live view of the agent, present on every page. Streams the agent feed, shows running investigations,
 * stops one run, and stops everything with the kill switch. It can be minimised but not closed.
 */
export function AgentConsole(){
 const [entries,setEntries]=useState<FeedEntry[]>([]),[state,setState]=useState<AgentState|null>(null),[open,setOpen]=useState(()=>stored('support.agentConsole','min')==='open');
 const [filter,setFilter]=useState('all'),[follow,setFollow]=useState(true),[connected,setConnected]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState('');
 const body=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const source=new EventSource('/api/agent/feed');
  source.addEventListener('entry',e=>setEntries(list=>mergeEntries(list,[JSON.parse((e as MessageEvent).data)])));
  source.addEventListener('state',e=>setState(JSON.parse((e as MessageEvent).data)));
  source.onopen=()=>setConnected(true);source.onerror=()=>setConnected(false);
  return ()=>source.close();
 },[]);
 useEffect(()=>{store('support.agentConsole',open?'open':'min');},[open]);
 const shown=useMemo(()=>filter==='all'?entries:entries.filter(e=>e.runId===filter),[entries,filter]);
 useEffect(()=>{if(open&&follow&&body.current)body.current.scrollTop=body.current.scrollHeight;},[shown,open,follow]);
 const running=state?.running??[],halted=!!state?.halted,last=[...entries].reverse().find(e=>e.kind!=='output');
 const runs=useMemo(()=>runTabs(entries,running),[entries,running]);
 const selected=runs.find(r=>r.runId===filter);
 const act=async(label:string,path:string)=>{setBusy(label);setError('');try{setState(await api<AgentState>(path,'POST',{}));}catch(e){setError((e as Error).message);}finally{setBusy('');}};
 const dot=halted?'stopped':running.length?'running':'idle';
 const status=halted?'Agent stopped':running.length?`Agent · ${running.length} running`:'Agent idle';
 const stopAll=<button type="button" className="agent-kill" disabled={!!busy||halted} onClick={()=>void act('halt','/agent/halt')} title="Stop every investigation and command, and block new runs">{busy==='halt'?'Stopping…':'Stop all'}</button>;
 if(!open)return <aside className="agent-console minimized" aria-label="Agent console">
  <button type="button" className="agent-summary" onClick={()=>setOpen(true)} aria-expanded="false">
   <i className={'agent-dot '+dot}/><strong>{status}</strong><span className="agent-last">{last?`${runKey(last.title)} ${last.text}`:connected?'No activity yet':'Connecting…'}</span><span className="agent-chevron" aria-hidden="true">⌃</span>
  </button>
  {halted?<button type="button" className="agent-resume" disabled={!!busy} onClick={()=>void act('resume','/agent/resume')}>Resume</button>:stopAll}
 </aside>;
 return <aside className="agent-console open" aria-label="Agent console">
  <header>
   <i className={'agent-dot '+dot}/><strong>{status}</strong>
   <span className="agent-actions">
    {selected?.running&&<button type="button" disabled={!!busy} onClick={()=>void act('stop','/agent/runs/'+selected.runId+'/stop')}>{busy==='stop'?'Stopping…':'Stop run'}</button>}
    {halted?<button type="button" className="agent-resume" disabled={!!busy} onClick={()=>void act('resume','/agent/resume')}>Resume</button>:stopAll}
    <button type="button" className="agent-minimize" aria-label="Minimise agent console" onClick={()=>setOpen(false)}>⌄</button>
   </span>
  </header>
  {runs.length>0&&<nav className="agent-runs" aria-label="Runs">
   <button type="button" aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>All</button>
   {runs.map(r=><span key={r.runId} className={'agent-run-tab'+(filter===r.runId?' active':'')}>
    <button type="button" aria-pressed={filter===r.runId} title={r.title} onClick={()=>setFilter(r.runId)}>{r.running&&<i className="agent-dot running"/>}{r.key}</button>
    {filter===r.runId&&r.route&&<button type="button" className="agent-open" aria-label={`Open ${r.key}`} title={`Open ${r.title}`} onClick={()=>navigate({page:r.route!.page,issue:r.route!.issue} as Route)}>↗</button>}
   </span>)}
  </nav>}
  {selected&&<p className="agent-run-title" title={selected.title}>{selected.title}</p>}
  {halted&&<p className="agent-banner">The agent is stopped. Investigations, commands and tunnels were stopped, and new runs are blocked until you resume.</p>}
  {state&&!state.sandbox.configured&&<p className="agent-banner muted">No command sandbox is configured, so the agent cannot run commands.</p>}
  {state?.sandbox.configured&&!state.sandbox.reachable&&<p className="agent-banner">The command sandbox is unreachable. Check the support-sandbox service.</p>}
  {error&&<p className="agent-banner error" role="alert">{error}</p>}
  <div className="agent-log" role="log" aria-label="Agent activity" ref={body} onScroll={e=>{const el=e.currentTarget;setFollow(el.scrollHeight-el.scrollTop-el.clientHeight<24);}}>
   {shown.length?shown.map((e,i)=><Fragment key={e.seq}>
    {filter==='all'&&shown[i-1]?.runId!==e.runId&&<div className="agent-separator" title={e.title}><span>{runKey(e.title)}</span></div>}
    <div className={'agent-line '+e.kind}>
     <time dateTime={e.at}>{clock(e.at)}</time>
     <span className="agent-marker" aria-hidden="true">{markers[e.kind]}</span><span className="agent-text">{e.text}</span>
    </div>
   </Fragment>):<p className="agent-empty">{connected?'No agent activity yet. Investigations appear here as they run.':'Connecting to the agent feed…'}</p>}
  </div>
  {!follow&&<button type="button" className="agent-follow" onClick={()=>{setFollow(true);if(body.current)body.current.scrollTop=body.current.scrollHeight;}}>Jump to latest</button>}
 </aside>;
}

import {useEffect,useMemo,useRef,useState} from 'react';
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
 const act=async(label:string,path:string)=>{setBusy(label);setError('');try{setState(await api<AgentState>(path,'POST',{}));}catch(e){setError((e as Error).message);}finally{setBusy('');}};
 const dot=halted?'stopped':running.length?'running':'idle';
 const status=halted?'Agent stopped':running.length?`Agent · ${running.length} running`:'Agent idle';
 const stopAll=<button type="button" className="agent-kill" disabled={!!busy||halted} onClick={()=>void act('halt','/agent/halt')} title="Stop every investigation and command, and block new runs">{busy==='halt'?'Stopping…':'Stop all'}</button>;
 if(!open)return <aside className="agent-console minimized" aria-label="Agent console">
  <button type="button" className="agent-summary" onClick={()=>setOpen(true)} aria-expanded="false">
   <i className={'agent-dot '+dot}/><strong>{status}</strong><span className="agent-last">{last?`${last.title.split(' · ')[0]} ${last.text}`:connected?'No activity yet':'Connecting…'}</span><span className="agent-chevron" aria-hidden="true">⌃</span>
  </button>
  {halted?<button type="button" className="agent-resume" disabled={!!busy} onClick={()=>void act('resume','/agent/resume')}>Resume</button>:stopAll}
 </aside>;
 return <aside className="agent-console open" aria-label="Agent console">
  <header>
   <i className={'agent-dot '+dot}/><strong>{status}</strong>
   <select aria-label="Show activity of" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All runs</option>{running.map(r=><option key={r.runId} value={r.runId}>{r.title}</option>)}{filter!=='all'&&!running.some(r=>r.runId===filter)&&<option value={filter}>Finished run</option>}</select>
   <span className="agent-actions">
    {filter!=='all'&&running.some(r=>r.runId===filter)&&<button type="button" disabled={!!busy} onClick={()=>void act('stop','/agent/runs/'+filter+'/stop')}>{busy==='stop'?'Stopping…':'Stop run'}</button>}
    {halted?<button type="button" className="agent-resume" disabled={!!busy} onClick={()=>void act('resume','/agent/resume')}>Resume</button>:stopAll}
    <button type="button" className="agent-minimize" aria-label="Minimise agent console" onClick={()=>setOpen(false)}>⌄</button>
   </span>
  </header>
  {halted&&<p className="agent-banner">The agent is stopped. Investigations, commands and tunnels were stopped, and new runs are blocked until you resume.</p>}
  {state&&!state.sandbox.configured&&<p className="agent-banner muted">No command sandbox is configured, so the agent cannot run commands.</p>}
  {state?.sandbox.configured&&!state.sandbox.reachable&&<p className="agent-banner">The command sandbox is unreachable. Check the support-sandbox service.</p>}
  {error&&<p className="agent-banner error" role="alert">{error}</p>}
  <div className="agent-log" role="log" aria-label="Agent activity" ref={body} onScroll={e=>{const el=e.currentTarget;setFollow(el.scrollHeight-el.scrollTop-el.clientHeight<24);}}>
   {shown.length?shown.map(e=><div key={e.seq} className={'agent-line '+e.kind}>
    <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>
    {e.route?<button type="button" className="agent-run" title={e.title} onClick={()=>navigate({page:e.route!.page,issue:e.route!.issue} as Route)}>{e.title.split(' · ')[0]}</button>:<span className="agent-run">{e.title.split(' · ')[0]}</span>}
    <span className="agent-marker" aria-hidden="true">{markers[e.kind]}</span><span className="agent-text">{e.text}</span>
   </div>):<p className="agent-empty">{connected?'No agent activity yet. Investigations appear here as they run.':'Connecting to the agent feed…'}</p>}
  </div>
  {!follow&&<button type="button" className="agent-follow" onClick={()=>{setFollow(true);if(body.current)body.current.scrollTop=body.current.scrollHeight;}}>Jump to latest</button>}
 </aside>;
}

import type React from 'react';
import {Fragment,useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api';
import {navigate,type Route} from './navigation';
import {useFeedback} from './Toasts';
import {AgentComposer,type Reply} from './AgentComposer';

type FeedKind='run-start'|'step'|'tool'|'command'|'output'|'result'|'error'|'run-end'|'engineer'|'question';
export type FeedEntry={seq:number;at:string;runId:string;title:string;route?:{page:string;issue:string};kind:FeedKind;text:string;ref?:string};
type Running={runId:string;title:string;route:{page:string;issue:string};startedAt:string;lastStep:string;questions?:number};
export type QueueCounts={queued:number;running:number;review:number;dead:number;budgetFull:boolean};
export type AgentState={halted:boolean;running:Running[];sandbox:{configured:boolean;reachable:boolean;commandsEnabled:boolean};queue?:QueueCounts;parallelReview?:boolean};
type QueueItem={scope:string;title:string;state:'queued'|'running'|'review'|'dead';origin:'auto'|'manual';attempts:number;lastError:string|null;nextAttemptAt:string;route:{page:string;issue:string}};
const markers:Record<FeedKind,string>={'run-start':'▸','step':'·','tool':'→','command':'$','output':' ','result':'←','error':'!','run-end':'■','engineer':'›','question':'?'};
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
/** Console size clamped to 320 × 180 px and to the viewport minus 32 px. */
export function clampSize(w:number,h:number,viewW:number,viewH:number){return {w:Math.round(Math.max(320,Math.min(w,viewW-32))),h:Math.round(Math.max(180,Math.min(h,viewH-32)))};}
/** Merges new entries into the list by sequence number and keeps the last 1,500. */
export function mergeEntries(list:FeedEntry[],added:FeedEntry[]){const seen=new Set(list.map(e=>e.seq));const next=[...list,...added.filter(e=>!seen.has(e.seq))].sort((a,b)=>a.seq-b.seq);return next.length>keep?next.slice(-keep):next;}

/**
 * Live view of the agent, present on every page. Streams the agent feed, shows running investigations,
 * stops one run, and stops everything with the kill switch. It can be minimised but not closed.
 */
export function AgentConsole(){
 const [entries,setEntries]=useState<FeedEntry[]>([]),[state,setState]=useState<AgentState|null>(null),[open,setOpen]=useState(()=>stored('support.agentConsole','min')==='open');
 const [filter,setFilter]=useState('all'),[follow,setFollow]=useState(true),[connected,setConnected]=useState(false),[busy,setBusy]=useState(''),feedback=useFeedback();
 const body=useRef<HTMLDivElement>(null);
 const [reply,setReply]=useState<Reply&{runId:string}|null>(null),[answered,setAnswered]=useState<Set<string>>(()=>new Set()),[composeTo,setComposeTo]=useState('');
 const [size,setSize]=useState<{w:number;h:number}>(()=>{try{const v=JSON.parse(localStorage.getItem('support.agentConsole.size')??'');if(Number.isFinite(v?.w)&&Number.isFinite(v?.h))return v;}catch{}return {w:620,h:380};});
 useEffect(()=>{store('support.agentConsole.size',JSON.stringify(size));},[size]);
 const resize=(w:number,h:number)=>setSize(clampSize(w,h,window.innerWidth,window.innerHeight));
 const drag=(e:React.PointerEvent<HTMLButtonElement>)=>{
  e.preventDefault();const start={x:e.clientX,y:e.clientY,...clampSize(size.w,size.h,window.innerWidth,window.innerHeight)};const grip=e.currentTarget;grip.setPointerCapture(e.pointerId);
  const move=(m:PointerEvent)=>resize(start.w+start.x-m.clientX,start.h+start.y-m.clientY);
  const up=()=>{grip.removeEventListener('pointermove',move);grip.removeEventListener('pointerup',up);grip.removeEventListener('pointercancel',up);};
  grip.addEventListener('pointermove',move);grip.addEventListener('pointerup',up);grip.addEventListener('pointercancel',up);
 };
 const keyResize=(e:React.KeyboardEvent)=>{const step=e.shiftKey?60:20,d={ArrowLeft:[step,0],ArrowRight:[-step,0],ArrowUp:[0,step],ArrowDown:[0,-step]}[e.key];if(d){e.preventDefault();resize(size.w+d[0],size.h+d[1]);}};
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
 const delivered=useMemo(()=>new Set(entries.filter(e=>e.kind==='step'&&e.ref).map(e=>e.ref!)),[entries]);
 const questions=running.reduce((n,r)=>n+(r.questions??0),0);
 const targets=running.map(r=>({runId:r.runId,key:runKey(r.title)}));
 const composeTarget=reply?.runId??(selected?.running?selected.runId:composeTo||targets[0]?.runId);
 const act=async(label:string,path:string)=>{setBusy(label);try{setState(await api<AgentState>(path,'POST',{}));feedback.info(label==='halt'?'Agent stopped. New runs are blocked until you resume.':label==='resume'?'Agent resumed.':'Run stopped.');}catch(e){feedback.error(e);}finally{setBusy('');}};
 const dot=halted?'stopped':running.length?'running':'idle';
 const status=halted?'Agent stopped':running.length?`Agent · ${running.length} running`:'Agent idle';
 const stopAll=<button type="button" className="agent-kill" disabled={!!busy||halted} onClick={()=>void act('halt','/agent/halt')} title="Stop every investigation and command, and block new runs">{busy==='halt'?'Stopping…':'Stop all'}</button>;
 if(!open)return <aside key="min" className="agent-console minimized" aria-label="Agent console">
  <button type="button" className="agent-summary" onClick={()=>setOpen(true)} aria-expanded="false">
   <i className={'agent-dot '+dot}/><strong>{status}</strong><span className="agent-last">{last?`${runKey(last.title)} ${last.text}`:connected?'No activity yet':'Connecting…'}</span>{questions>0&&<span className="agent-question-badge">{questions} question{questions===1?'':'s'}</span>}<span className="agent-chevron" aria-hidden="true">⌃</span>
  </button>
  {halted?<button type="button" className="agent-resume" disabled={!!busy} onClick={()=>void act('resume','/agent/resume')}>Resume</button>:stopAll}
 </aside>;
 const fitted=typeof window==='undefined'?size:clampSize(size.w,size.h,window.innerWidth,window.innerHeight);
 return <aside key="open" className="agent-console open" aria-label="Agent console" style={{width:fitted.w,height:fitted.h}}>
  <button type="button" className="agent-resize" aria-label="Resize agent console" title="Drag to resize" onPointerDown={drag} onKeyDown={keyResize}/>
  <header>
   <i className={'agent-dot '+dot}/><strong>{status}</strong>
   <span className="agent-actions">
    {selected?.running&&<button type="button" disabled={!!busy} onClick={()=>void act('stop','/agent/runs/'+selected.runId+'/stop')}>{busy==='stop'?'Stopping…':'Stop run'}</button>}
    {halted?<button type="button" className="agent-resume" disabled={!!busy} onClick={()=>void act('resume','/agent/resume')}>Resume</button>:stopAll}
    <button type="button" className="agent-minimize" aria-label="Minimise agent console" onClick={()=>setOpen(false)}>⌄</button>
   </span>
  </header>
  <nav className="agent-runs" aria-label="Runs">
   <button type="button" aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>All</button>
   <button type="button" aria-pressed={filter==='queue'} onClick={()=>setFilter('queue')}>Queue {state?.queue?state.queue.queued+state.queue.review:0}{!!state?.queue?.dead&&<span className="agent-dead-count" title="Dead letter">{state.queue.dead}</span>}</button>
   {runs.map(r=><span key={r.runId} className={'agent-run-tab'+(filter===r.runId?' active':'')}>
    <button type="button" aria-pressed={filter===r.runId} title={r.title} onClick={()=>setFilter(r.runId)}>{r.running&&<i className="agent-dot running"/>}{r.key}</button>
    {filter===r.runId&&r.route&&<button type="button" className="agent-open" aria-label={`Open ${r.key}`} title={`Open ${r.title}`} onClick={()=>navigate({page:r.route!.page,issue:r.route!.issue} as Route)}>↗</button>}
   </span>)}
  </nav>
  {selected&&<p className="agent-run-title" title={selected.title}>{selected.title}</p>}
  {halted&&<p className="agent-banner">The agent is stopped. Investigations, commands and tunnels were stopped, and new runs are blocked until you resume.</p>}
  {state&&!state.sandbox.configured&&<p className="agent-banner muted">No command sandbox is configured, so the agent cannot run commands.</p>}
  {state?.sandbox.configured&&!state.sandbox.reachable&&<p className="agent-banner">The command sandbox is unreachable. Check the sandbox service.</p>}
  {filter==='queue'?<QueueView state={state}/>:<>
  <div className="agent-log" role="log" aria-label="Agent activity" ref={body} onScroll={e=>{const el=e.currentTarget;setFollow(el.scrollHeight-el.scrollTop-el.clientHeight<24);}}>
   {shown.length?shown.map((e,i)=><Fragment key={e.seq}>
    {filter==='all'&&shown[i-1]?.runId!==e.runId&&<div className="agent-separator" title={e.title}><span>{runKey(e.title)}</span></div>}
    <div className={'agent-line '+e.kind}>
     <time dateTime={e.at}>{clock(e.at)}</time>
     <span className="agent-marker" aria-hidden="true">{markers[e.kind]}</span><span className="agent-text">{e.kind==='engineer'&&<span className="agent-you">you</span>}{e.text}{e.kind==='engineer'&&e.ref&&<span className="agent-delivery">{delivered.has(e.ref)?'delivered':'queued'}</span>}{e.kind==='question'&&e.ref&&running.some(r=>r.runId===e.runId)&&!answered.has(e.ref)&&<button type="button" className="agent-reply" onClick={()=>setReply({id:e.ref!,text:e.text,runId:e.runId})}>Reply</button>}</span>
    </div>
   </Fragment>):<p className="agent-empty">{connected?'No agent activity yet. Investigations appear here as they run.':'Connecting to the agent feed…'}</p>}
  </div>
  {!follow&&<button type="button" className="agent-follow" onClick={()=>{setFollow(true);if(body.current)body.current.scrollTop=body.current.scrollHeight;}}>Jump to latest</button>}
  <AgentComposer targets={targets} target={composeTarget} onTarget={setComposeTo} reply={reply} onClearReply={()=>setReply(null)} onSent={()=>{if(reply)setAnswered(s=>new Set(s).add(reply.id));}}/></>}
 </aside>;
}

const sections:[QueueItem['state'],string][]=[['running','Running'],['review','Waiting for your review'],['queued','Queued'],['dead','Dead letter']];
/** Queue of automatic investigations: running, waiting for review, queued, and failed (dead letter) with retry and discard. */
function QueueView({state}:{state:AgentState|null}){
 const [items,setItems]=useState<QueueItem[]|null>(null),[busy,setBusy]=useState(''),feedback=useFeedback(),[now,setNow]=useState(()=>Date.now());
 useEffect(()=>{let alive=true;api<{entries:QueueItem[]}>('/agent/queue').then(r=>{if(alive)setItems(r.entries)}).catch(e=>feedback.error(e));return ()=>{alive=false};},[state,feedback]);
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(t);},[]);
 const act=async(action:'retry'|'discard',scope:string)=>{setBusy(scope);try{const r=await api<{entries:QueueItem[]}>('/agent/queue/'+action,'POST',{scope});setItems(r.entries);feedback.success(action==='retry'?'Queued again.':'Removed from the queue.');}catch(e){feedback.error(e);}finally{setBusy('');}};
 if(!items)return <p className="agent-empty">Loading the queue…</p>;
 return <div className="agent-queue">
  {state?.queue?.budgetFull&&<p className="agent-banner muted">New automatic investigations wait until you review a plan.</p>}
  {!items.length&&<p className="agent-empty">The queue is empty.</p>}
  {sections.map(([key,label])=>{const list=items.filter(i=>i.state===key);return list.length?<section key={key} className={'agent-queue-section '+key}>
   <h4>{label} <span>{list.length}</span></h4>
   <ol>{list.map((i,n)=>{const wait=Date.parse(i.nextAttemptAt)-now;return <li key={i.scope}>
    <button type="button" className="agent-queue-title" title={i.title} onClick={()=>navigate({page:i.route.page,issue:i.route.issue} as Route)}>{key==='queued'&&<span className="muted">{n+1}.</span>} {i.title}</button>
    <span className="agent-queue-meta">{key==='queued'&&wait>0?`retry in ${Math.ceil(wait/1000)} s`:key==='review'&&state?.parallelReview===false?'slot kept':i.origin==='manual'?'manual':''}</span>
    {key==='dead'&&<><span className="agent-queue-error" title={i.lastError??''}>{i.attempts>0?`${i.attempts} attempt${i.attempts===1?'':'s'} · `:''}{i.lastError}</span><span className="agent-queue-actions"><button type="button" disabled={!!busy} onClick={()=>void act('retry',i.scope)}>Retry</button><button type="button" disabled={!!busy} onClick={()=>void act('discard',i.scope)}>Discard</button></span></>}
   </li>;})}</ol>
  </section>:null;})}
 </div>;
}

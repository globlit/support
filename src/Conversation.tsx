import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {useWorkspaceApi} from './WorkspaceRuntime';
import {useFeedback} from './Toasts';
import {ErrorNotice} from './ErrorNotice';
import {Markdown} from './Markdown';
import {Select} from './Select';
import {SafeLink} from './SafeLink';
import {InvestigationTimeline} from './InvestigationTimeline';
import {ToolUsageChart} from './ToolUsageChart';
import {countTools} from './tool-usage';
import {routeHash} from './navigation';
import {sourcePage} from './intake-model';
import {branches,turnText} from './conversation-model';
import type {AnalysisRun,LiveDetail} from './model';

type Props={detail:LiveDetail;run:AnalysisRun|null;running:boolean;error:string;disabled:boolean;start:()=>void;cancel:()=>void;refresh:()=>void;onLatest?:(run:AnalysisRun)=>void;automatic?:boolean;maxRuns?:number;sourcePath?:string};
const clock=(at?:string)=>at?new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
const day=(at:string)=>new Date(at).toLocaleDateString([],{day:'numeric',month:'short'});
const duration=(r:AnalysisRun)=>{const ms=Date.parse(r.finishedAt??new Date().toISOString())-Date.parse(r.startedAt);const m=Math.round(ms/60000);return m<1?`${Math.max(1,Math.round(ms/1000))} s`:`${m} min`;};
const outcomeLabel:Record<string,string>={diagnosis:'Diagnosis',plan:'Plan',needs_input:'Needs your answers',inconclusive:'Inconclusive'};

/**
 * The investigation of a request as one conversation: each run is a work block between the engineer turn that started
 * it and its result. Plan versions appear as cards where they were produced. The message box continues the latest
 * session of the shown branch; its menu rechecks the request or starts over. Restarting from an older plan version
 * creates a branch; the branch switcher shows one path at a time. Only the conversation scrolls.
 */
export function Conversation({detail,run,running,error,disabled,start,cancel,refresh,onLatest,automatic=false,maxRuns=2,sourcePath='/youtrack/issues'}:Props){
 const api=useWorkspaceApi(),feedback=useFeedback();
 const [runs,setRuns]=useState<AnalysisRun[]>([]),[readError,setReadError]=useState(''),[leaf,setLeaf]=useState(''),[full,setFull]=useState<Record<string,AnalysisRun>>({}),[open,setOpen]=useState<Record<string,boolean>>({});
 const latestRef=useRef(onLatest);latestRef.current=onLatest;
 useEffect(()=>{let alive=true;const read=()=>void api<AnalysisRun[]>(sourcePath+'/'+detail.issue.id+'/investigations').then(r=>{if(!alive)return;setRuns(r);if(r[0])latestRef.current?.(r[0]);setReadError('');}).catch(e=>{if(alive)setReadError(e.message)});read();const t=setInterval(()=>{if(document.visibilityState==='visible')read()},4000);return()=>{alive=false;clearInterval(t)}},[detail.issue.id,detail.session.revision,run?.state,sourcePath]);
 const all=useMemo(()=>{const m=new Map(runs.map(r=>[r.id,r]));if(run)m.set(run.id,{...m.get(run.id),...run});return [...m.values()];},[runs,run]);
 const tree=useMemo(()=>branches(all,detail.session.plans),[all,detail.session.plans]);
 const branch=tree.find(b=>b.leaf===leaf)??tree[0];
 useEffect(()=>{if(run?.id&&tree.some(b=>b.leaf===run.id))setLeaf(run.id);},[run?.id,tree.length]);
 const live=branch?.runs.find(r=>r.state==='running');
 const last=branch?.runs.at(-1);
 // Load full runs (events) for the open blocks; the running block refreshes while it runs.
 const shown=(r:AnalysisRun)=>open[r.id]??(r.id===last?.id||r.state==='running');
 useEffect(()=>{let alive=true;const timers:ReturnType<typeof setTimeout>[]=[];
  for(const r of branch?.runs??[])if(shown(r)&&(!full[r.id]||r.state==='running'||full[r.id].state==='running')){
   const load=()=>void api<AnalysisRun>('/analysis/'+r.id).then(x=>{if(!alive)return;setFull(f=>({...f,[x.id]:x}));if(x.state==='running')timers.push(setTimeout(load,1500));}).catch(()=>{});
   load();
  }
  return()=>{alive=false;timers.forEach(clearTimeout)};
 },[branch?.leaf,JSON.stringify(open),branch?.runs.map(r=>r.id+r.state).join()]);
 // Follow new content while the reader is at the bottom.
 const scroller=useRef<HTMLDivElement>(null),[atBottom,setAtBottom]=useState(true),[unseen,setUnseen]=useState(0);
 const size=(branch?.runs??[]).reduce((n,r)=>n+(full[r.id]?.events.length??0),0)+(branch?.runs.length??0);
 const prevSize=useRef(size);
 useEffect(()=>{const el=scroller.current;if(!el)return;if(atBottom){el.scrollTop=el.scrollHeight;setUnseen(0);}else if(size>prevSize.current)setUnseen(n=>n+(size-prevSize.current));prevSize.current=size;},[size,branch?.leaf]);
 const toBottom=()=>{const el=scroller.current;if(el){el.scrollTo({top:el.scrollHeight,behavior:'smooth'});setUnseen(0);}};
 const act=async(path:string,body:unknown,done:string)=>{try{await api(path,'POST',body);feedback.success(done);refresh();}catch(e){feedback.error(e);}};
 const planHref=()=>routeHash({page:sourcePage(detail.issue.connection),issue:detail.issue.id,connection:detail.issue.connection,step:'plan'});
 const current=detail.session.plans.at(-1),approval=detail.session.approval;
 // The conversation fills the window below its top edge, so that the page itself never scrolls.
 const root=useRef<HTMLElement>(null),[height,setHeight]=useState<number>();
 // The height uses the position in the document, not in the viewport, so scrolling the page never changes it.
 useLayoutEffect(()=>{const fit=()=>{const el=root.current;if(!el||!el.offsetParent)return;const top=el.getBoundingClientRect().top+window.scrollY;const next=Math.max(420,Math.round(window.innerHeight-top-16));setHeight(h=>h===next?h:next);};fit();window.addEventListener('resize',fit);const observer=new ResizeObserver(fit);observer.observe(document.body);return()=>{window.removeEventListener('resize',fit);observer.disconnect();};},[]);
 return <section ref={root} className="conversation-view" aria-label="Investigation" style={height?{height}:undefined}>
  <header className="conversation-head">
   <div><h2>Investigation</h2><span className="small muted">{all.length?`${all.length} run${all.length===1?'':'s'}${tree.length>1?` · ${tree.length} branches`:''}`:automatic?`Queued for automatic investigation · up to ${maxRuns} at a time`:'No run yet'}</span></div>
   <div className="actions">
    {tree.length>1&&<Select aria-label="Branch" value={branch?.leaf} onChange={e=>{setLeaf(e.target.value);setAtBottom(true);}}>{tree.map((b,i)=><option key={b.leaf} value={b.leaf}>Branch {tree.length-i} of {tree.length} · {b.label}</option>)}</Select>}
    {(running||live)&&<button onClick={()=>{if(running)cancel();else if(live)void api('/analysis/'+live.id+'/cancel','POST',{}).catch(e=>setReadError(e.message));}}>Stop</button>}
   </div>
  </header>
  {(error||readError)&&<ErrorNotice message={error||readError} context="Model"/>}
  <div className="conversation-scroll" ref={scroller} onScroll={e=>{const el=e.currentTarget;const bottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;setAtBottom(bottom);if(bottom)setUnseen(0);}}>
   {!branch&&<div className="conversation-empty"><p>No investigation yet. Start one to let the agent read the request, the clusters, the code and the documentation.</p></div>}
   {branch?.runs.map(r=>{const f=full[r.id]??r,isOpen=shown(r),plan=r.planVersion&&r.basedOn?.kind!=='implement'?detail.session.plans.find(p=>p.version===r.planVersion):undefined,checks=f.events.filter(e=>e.tool&&e.tool!=='note');
    return <article key={r.id} className="conversation-run">
     <div className="conversation-turn"><span className="conversation-who">{r.basedOn?.by??'Support'}</span><p>{turnText(r)}</p><time dateTime={r.startedAt}>{day(r.startedAt)} {clock(r.startedAt)}</time></div>
     <div className={'conversation-block '+r.state}>
      <button type="button" className="conversation-block-head" aria-expanded={isOpen} title={isOpen?'Hide the steps of this run':'Show the steps of this run'} onClick={()=>setOpen(o=>({...o,[r.id]:!isOpen}))}>
       <svg className="conversation-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
       <span className={'conversation-dot '+r.state} aria-hidden="true"/>
       <strong>{r.state==='running'?'Working':r.state==='failed'?'Stopped on an error':r.state==='cancelled'?'Stopped':'Worked'} {duration(r)}</strong>
       <span className="small muted">{full[r.id]?`${checks.length} step${checks.length===1?'':'s'}`:''}{r.model?` · ${r.model}`:''}</span>
       <span className="conversation-toggle">{isOpen?'Hide steps':'Show steps'}</span>
      </button>
      {isOpen&&<div className="conversation-block-body">
       {full[r.id]?<>{checks.length>0&&<details className="conversation-tools"><summary>Tool usage</summary><ToolUsageChart compact counts={countTools(f.events)} title="Tool calls in this run"/></details>}
        <div className={'conversation-steps'+(checks.length>40?' long':'')}><InvestigationTimeline events={f.events} run={null}/></div>
        {(f.messages??[]).length>0&&<ul className="conversation-messages">{f.messages!.map(m=><li key={m.id}><span className="conversation-who">{m.by}</span> {m.text}<small>{m.delivered?`delivered ${clock(m.delivered)}`:'queued'}</small></li>)}</ul>}</>:<p className="small muted">Loading the steps…</p>}
      </div>}
     </div>
     {r.state==='running'&&(f.questions??[]).length>0&&<Questions run={f} live answerable={!disabled} onSent={refresh}/>}
     {r.error&&<ErrorNotice message={r.error} context="Model"/>}
     {r.state!=='running'&&(r.outcome||plan)&&<div className="conversation-result">
      {plan?<div className={'plan-card'+(plan.version===current?.version?' current':'')}>
        <header><strong>Plan v{plan.version}</strong>{plan.version===current?.version&&<span className="badge">Current</span>}{approval?.version===plan.version&&<span className="badge green">Approved</span>}</header>
        <div className="plan-card-text"><Markdown>{plan.text.split('\n').slice(0,8).join('\n')}</Markdown></div>
        <div className="actions">
         <SafeLink className="button primary" href={planHref()}>Review plan →</SafeLink>
         {plan.version!==current?.version&&<button disabled={disabled||!!live} title="Starts a new branch from this version. Later versions stay readable in their branch." onClick={()=>void act('/agent/restart',{connection:detail.issue.connection,issueId:detail.issue.id,planVersion:plan.version},`Restarting from plan v${plan.version}.`)}>Restart from this version</button>}
        </div>
       </div>:<div className={'outcome-card '+(r.outcome??'')}>
        <header><span className="badge">{outcomeLabel[r.outcome!]??r.outcome}</span>{r.basedOn?.kind==='implement'&&<span className="small muted">{r.proposals?.length?`${r.proposals.length} proposal${r.proposals.length===1?'':'s'} in the implementation step`:'No proposal submitted'}</span>}</header>
        {r.report&&<div className="plan-card-text"><Markdown>{r.report}</Markdown></div>}
        {(r.questions??[]).length>0&&<Questions run={full[r.id]??r} answerable={r.id===last?.id&&!!r.sessionId&&!disabled} onSent={refresh}/>}
       </div>}
     </div>}
    </article>;})}
  </div>
  {unseen>0&&!atBottom&&<button type="button" className="conversation-jump" onClick={toBottom}>Jump to latest ↓ <span>{unseen} new</span></button>}
  <Composer detail={detail} last={last} live={live} disabled={disabled} start={start} running={running} onSent={()=>{setAtBottom(true);refresh();}}/>
 </section>;
}

/**
 * Message box of the conversation. While a run works, text goes to its session. Otherwise Send continues the latest
 * session of the branch; Recheck and Start over are in the menu. Without any run, it starts the first investigation.
 */
function Composer({detail,last,live,disabled,start,running,onSent}:{detail:LiveDetail;last?:AnalysisRun;live?:AnalysisRun;disabled:boolean;start:()=>void;running:boolean;onSent:()=>void}){
 const api=useWorkspaceApi(),feedback=useFeedback();
 const [text,setText]=useState(''),[sending,setSending]=useState(false),[menu,setMenu]=useState(false);
 const canContinue=!!last?.sessionId;
 async function send(kind:'continue'|'recheck'|'over'){
  const value=text.trim();if(sending)return;if(kind==='continue'&&!value)return;setSending(true);setMenu(false);
  try{
   if(live)await api(`/agent/runs/${live.id}/message`,'POST',{text:value});
   else if(kind==='over')await api('/agent/start-over','POST',{connection:detail.issue.connection,issueId:detail.issue.id,...(value?{text:value}:{})});
   else if(last&&canContinue)await api(`/agent/runs/${last.id}/continue`,'POST',{text:value||'Recheck the request with its current data.',kind});
   else{start();}
   setText('');feedback.success(live?'Message sent to the running session.':kind==='over'?'Started over in a new session.':kind==='recheck'?'Rechecking the request.':'The agent continues.');onSent();
  }catch(e){feedback.error(e);}finally{setSending(false);}
 }
 if(!last)return <div className="conversation-composer"><p className="small muted">The agent reads the request, the clusters, the code and the documentation, then reports a diagnosis, a plan or questions.</p><button className="primary" disabled={disabled||running||detail.issue.resolved} onClick={start}>{running?'Starting…':'Start investigation'}</button></div>;
 return <div className="conversation-composer">
  <textarea rows={2} value={text} maxLength={16000} disabled={disabled||sending} aria-label="Message the agent"
   placeholder={live?'Message the running agent…':canContinue?'Message the agent: a comment, a hint, or something else to check…':'This run has no session to continue. Use Start over in the menu.'}
   onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send('continue');}}}/>
  <div className="conversation-composer-actions">
   <button className="primary" disabled={disabled||sending||!text.trim()||(!live&&!canContinue)} onClick={()=>void send('continue')}>{live?'Send to the agent':'Send'}</button>
   {!live&&<div className="composer-menu"><button type="button" aria-haspopup="menu" aria-expanded={menu} disabled={disabled||sending} onClick={()=>setMenu(m=>!m)}>More ▾</button>
    {menu&&<div role="menu" className="composer-menu-panel">
     <button role="menuitem" disabled={!canContinue} onClick={()=>void send('recheck')}><strong>Recheck the request</strong><small>Same session, with the current ticket data. Your text is added as a note.</small></button>
     <button role="menuitem" onClick={()=>void send('over')}><strong>Start over</strong><small>New session without memory of this conversation. Earlier runs stay readable as another branch.</small></button>
    </div>}
   </div>}
   <span className="small muted">Enter to send · Shift+Enter for a new line</span>
  </div>
 </div>;
}

/**
 * Questions of the agent with their answers. Prepared answers are buttons; "Something else" opens a text field.
 * During a run, each answer is sent at once to the running session. After a run, answers are collected and sent
 * together, which continues the session. Questions of older runs are read-only.
 */
function Questions({run,live=false,answerable,onSent}:{run:AnalysisRun;live?:boolean;answerable:boolean;onSent:()=>void}){
 const api=useWorkspaceApi(),feedback=useFeedback();
 const [answers,setAnswers]=useState<Record<string,string>>({}),[writing,setWriting]=useState<Record<string,boolean>>({}),[sending,setSending]=useState(false);
 const pending=(run.messages??[]).filter(m=>m.replyTo&&!m.delivered).map(m=>m.replyTo);
 const ready=Object.entries(answers).filter(([,v])=>v.trim());
 async function reply(questionId:string,text:string){
  if(!text.trim())return;setSending(true);
  try{await api(`/agent/runs/${run.id}/message`,'POST',{text,replyTo:questionId});setAnswers(a=>({...a,[questionId]:''}));setWriting(w=>({...w,[questionId]:false}));feedback.success('Answer sent to the running agent.');onSent();}
  catch(e){feedback.error(e);}finally{setSending(false);}
 }
 async function sendAll(){
  setSending(true);
  try{await api(`/agent/runs/${run.id}/continue`,'POST',{answers:ready.map(([questionId,text])=>({questionId,text}))});setAnswers({});setWriting({});feedback.success('Answers sent. The agent continues.');onSent();}
  catch(e){feedback.error(e);}finally{setSending(false);}
 }
 return <div className="agent-questions">
  <ol>{(run.questions??[]).map(q=>{const value=answers[q.id]??'',queued=pending.includes(q.id);
   return <li key={q.id} className={q.answer?'answered':''}>
    <p>{q.text}</p>
    {q.answer?<p className="agent-answer"><span>Your answer</span>{q.answer.text}</p>:queued?<p className="agent-answer"><span>Your answer</span>queued for the agent</p>:answerable&&<>
     {(q.options?.length??0)>0&&<div className="answer-options" role="group" aria-label="Prepared answers">{q.options!.map(o=><button key={o} type="button" aria-pressed={value===o&&!writing[q.id]} disabled={sending} onClick={()=>{if(live)void reply(q.id,o);else{setWriting(w=>({...w,[q.id]:false}));setAnswers(a=>({...a,[q.id]:a[q.id]===o?'':o}));}}}>{o}</button>)}
      <button type="button" className="text-button" aria-pressed={!!writing[q.id]} onClick={()=>{setWriting(w=>({...w,[q.id]:!w[q.id]}));setAnswers(a=>({...a,[q.id]:''}));}}>Something else…</button></div>}
     {((q.options?.length??0)===0||writing[q.id])&&<div className="answer-write">{(q.options?.length??0)===0&&!writing[q.id]?<button type="button" className="answer-open" onClick={()=>setWriting(w=>({...w,[q.id]:true}))}>Answer this question</button>:<>
      <textarea rows={2} maxLength={4000} value={value} placeholder="Your answer" aria-label={`Answer to: ${q.text}`} onChange={e=>setAnswers(a=>({...a,[q.id]:e.target.value}))} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&live){e.preventDefault();void reply(q.id,value);}}}/>
      {live&&<button type="button" disabled={sending||!value.trim()} onClick={()=>void reply(q.id,value)}>Send</button>}</>}</div>}
    </>}
   </li>;})}</ol>
  {!live&&answerable&&ready.length>0&&<div className="actions"><button className="primary" disabled={sending} onClick={()=>void sendAll()}>{sending?'Sending…':`Send ${ready.length} answer${ready.length===1?'':'s'} and continue`}</button><span className="small muted">Unanswered questions stay open. The agent continues with everything it already found.</span></div>}
 </div>;
}

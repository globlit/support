import {useState} from 'react';
import {api} from './api';
import {Markdown} from './Markdown';
import {useFeedback} from './Toasts';
import type {AnalysisRun} from './model';

const labels:Record<NonNullable<AnalysisRun['outcome']>,{title:string;tone:string}>={
 diagnosis:{title:'Diagnosis',tone:'green'},
 plan:{title:'Plan',tone:'green'},
 needs_input:{title:'Needs your answers',tone:'amber'},
 inconclusive:{title:'Inconclusive',tone:'muted'},
};

/**
 * Result of an agent session: its outcome and report, and a form to continue the same session. Continuing sends the
 * engineer's text as a new message to the agent, which keeps everything it learned in the session.
 */
export function AgentOutcome({run,latest,onContinued}:{run:AnalysisRun;latest:boolean;onContinued?:()=>void}){
 const [text,setText]=useState(''),[sending,setSending]=useState(false),feedback=useFeedback();
 if(run.state==='running'||(!run.outcome&&!run.sessionId))return null;
 const label=run.outcome?labels[run.outcome]:undefined,open=(run.questions??[]).filter(q=>!q.answer);
 async function send(){
  const value=text.trim();if(!value||sending)return;setSending(true);
  try{await api(`/agent/runs/${run.id}/continue`,'POST',{text:value});setText('');feedback.success('The agent continues the session.');onContinued?.();}
  catch(e){feedback.error(e);}finally{setSending(false);}
 }
 return <section className="agent-outcome" aria-label="Agent result">
  {label&&<header><span className={'badge '+label.tone}>{label.title}</span>{run.outcome==='plan'&&run.planVersion?<span className="small muted">Saved as plan v{run.planVersion} for review.</span>:run.outcome==='plan'?null:<span className="small muted">Not a plan: nothing to approve.</span>}</header>}
  {run.report&&!(run.outcome==='plan'&&run.planVersion)&&<div className="agent-report"><Markdown>{run.report}</Markdown></div>}
  {open.length>0&&<div className="agent-open-questions"><strong>Questions from the agent</strong><ol>{open.map(q=><li key={q.id}>{q.text}</li>)}</ol></div>}
  {latest&&run.sessionId&&<form className="agent-continue" onSubmit={e=>{e.preventDefault();void send();}}>
   <label>{open.length?'Your answers':'Continue this session'}<textarea rows={3} maxLength={16000} value={text} placeholder={open.length?'Answer the questions. The agent continues with everything it already found.':'Ask a follow-up, give a hint, or ask the agent to check something else.'} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();void send();}}}/></label>
   <div className="actions"><button className="primary" disabled={sending||!text.trim()}>{sending?'Sending…':open.length?'Send answers':'Continue session'}</button><span className="small muted">Ctrl+Enter to send. No new investigation is started.</span></div>
  </form>}
 </section>;
}

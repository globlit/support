import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {useFeedback} from './Toasts';

export type ComposerTarget={runId:string;key:string};
export type Reply={id:string;text:string};

/**
 * Message box for running investigations. Enter sends, Shift+Enter adds a line. The agent reads the message before its
 * next step. With several running runs, a selector picks the run. A reply answers one of the agent's questions.
 */
export function AgentComposer({targets,target,onTarget,reply,onClearReply,onSent,compact=false}:{targets:ComposerTarget[];target?:string;onTarget?:(runId:string)=>void;reply?:Reply|null;onClearReply?:()=>void;onSent?:(id:string,runId:string)=>void;compact?:boolean}){
 const [text,setText]=useState(''),[sending,setSending]=useState(false),feedback=useFeedback(),input=useRef<HTMLTextAreaElement>(null);
 const runId=target&&targets.some(t=>t.runId===target)?target:targets[0]?.runId;
 useEffect(()=>{if(reply)input.current?.focus();},[reply]);
 useEffect(()=>{const el=input.current;if(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,96)+'px';}},[text]);
 async function send(){
  const value=text.trim();if(!value||!runId||sending)return;
  setSending(true);
  try{const m=await api<{id:string}>(`/agent/runs/${runId}/message`,'POST',{text:value,...(reply?{replyTo:reply.id}:{})});setText('');onClearReply?.();onSent?.(m.id,runId);}
  catch(e){feedback.error(e);}finally{setSending(false);}
 }
 const disabled=!runId;
 return <div className={'agent-composer'+(compact?' compact':'')}>
  {reply&&<div className="agent-composer-reply"><span>Replying to: <em>{reply.text}</em></span><button type="button" className="text-button" aria-label="Cancel reply" onClick={onClearReply}>×</button></div>}
  <div className="agent-composer-row">
   {targets.length>1&&<select aria-label="Send to" value={runId} onChange={e=>onTarget?.(e.target.value)}>{targets.map(t=><option key={t.runId} value={t.runId}>To {t.key}</option>)}</select>}
   <textarea ref={input} rows={1} value={text} disabled={disabled||sending} maxLength={4000} aria-label="Message the agent"
    placeholder={disabled?'No investigation is running.':reply?'Write your answer…':'Message the agent… Enter to send, Shift+Enter for a new line'}
    onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}if(e.key==='Escape'&&reply){e.preventDefault();onClearReply?.();}}}/>
   <button type="button" className="agent-send" aria-label="Send message" disabled={disabled||sending||!text.trim()} onClick={()=>void send()}>
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5"/></svg>
   </button>
  </div>
 </div>;
}

/** Questions the agent asked during a run, with their answers, and a message box for the run while it is running. */
export function RunConversation({run}:{run:{id:string;title?:string;state:string;questions?:{id:string;text:string;at:string;answer?:{text:string}}[];messages?:{id:string;text:string;at:string;delivered?:string;replyTo?:string}[]}}){
 const [reply,setReply]=useState<Reply|null>(null);
 const questions=run.questions??[],messages=(run.messages??[]).filter(m=>!m.replyTo);
 const live=run.state==='running';
 if(!live&&!questions.length&&!messages.length)return null;
 return <div className="run-conversation">
  {questions.map(q=><div key={q.id} className={'run-question'+(q.answer?' answered':'')}>
   <span className="run-question-label">Agent question</span><p>{q.text}</p>
   {(()=>{const pending=run.messages?.find(m=>m.replyTo===q.id);return q.answer||pending?<p className="run-answer"><span>Your answer</span>{q.answer?.text??pending!.text}{!q.answer&&<small>queued</small>}</p>:null;})()}
   {q.answer||run.messages?.some(m=>m.replyTo===q.id)?null:live?<button type="button" className="text-button" onClick={()=>setReply({id:q.id,text:q.text})}>Reply</button>:<p className="small muted">Not answered. Listed in the plan.</p>}
  </div>)}
  {messages.map(m=><p key={m.id} className="run-message"><span>You</span>{m.text}<small>{m.delivered?'delivered':'queued'}</small></p>)}
  {live&&<AgentComposer compact targets={[{runId:run.id,key:(run.title??'').split(' · ')[0]}]} reply={reply} onClearReply={()=>setReply(null)}/>}
 </div>;
}

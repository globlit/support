import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export type SelectionAnchor={left:number;top:number};
export function SelectionComment({anchor,disabled,onClose,onSave,onQuick}:{anchor:SelectionAnchor;disabled:boolean;onClose:()=>void;onSave:(text:string,send:boolean)=>Promise<boolean>;onQuick:(kind:'recheck'|'remove')=>Promise<boolean>}){
 const [expanded,setExpanded]=useState(false),[text,setText]=useState('');
 const root=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{if(expanded)input.current?.focus()},[expanded]);
 useEffect(()=>{
  const dismiss=(event:Event)=>{if(!root.current?.contains(event.target as Node)&&!text.trim())onClose()};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose()};
  document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);window.addEventListener('scroll',dismiss,true);window.addEventListener('resize',dismiss);
  return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);window.removeEventListener('scroll',dismiss,true);window.removeEventListener('resize',dismiss)};
 },[onClose,text]);
 const width=Math.min(360,window.innerWidth-24),left=Math.max(12,Math.min(anchor.left,window.innerWidth-(expanded?width:110)-12));
 const top=Math.max(12,Math.min(anchor.top,window.innerHeight-(expanded?250:42)-12));
 return createPortal(<div ref={root} className="selection-comment" style={{left,top,width:expanded?width:undefined}}>
  <div className="selection-tools" role="toolbar" aria-label="Selected plan text"><button type="button" aria-label="Comment on selected text" title="Comment on selected text" aria-expanded={expanded} onMouseDown={e=>e.preventDefault()} onClick={()=>setExpanded(v=>!v)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z"/></svg></button><button type="button" aria-label="Recheck selected passage" title="Queue a recheck of this passage" disabled={disabled} onMouseDown={e=>e.preventDefault()} onClick={()=>void onQuick('recheck').then(ok=>{if(ok)onClose()})}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M19.3 12a7.5 7.5 0 1 0-1.9 5.1M20 12l-2.7-5"/></svg></button><button type="button" aria-label="Request removal of selected passage" title="Queue removal of this passage" disabled={disabled} onMouseDown={e=>e.preventDefault()} onClick={()=>void onQuick('remove').then(ok=>{if(ok)onClose()})}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg></button></div>
  {expanded&&<form className="selection-comment-input" aria-label="Comment on this plan passage" onSubmit={e=>{e.preventDefault();if(!disabled&&text.trim())void onSave(text,true).then(ok=>{if(ok)onClose()})}}>
   <textarea ref={input} aria-label="Comment for AI revision" placeholder="Add comments to this plan for AI revision…" value={text} required maxLength={4000} onChange={e=>setText(e.target.value)}/>
   <div className="actions"><button type="button" onClick={onClose}>Cancel</button><button type="button" disabled={disabled||!text.trim()} onClick={()=>void onSave(text,false).then(ok=>{if(ok)onClose()})}>Add comment</button><button className="primary" disabled={disabled||!text.trim()}>Send for revision</button></div>
   <p className="small muted">Add comments to several passages, then send them together for revision.</p>
  </form>}
 </div>,document.body);
}

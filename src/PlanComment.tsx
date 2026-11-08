import {useState} from 'react';
import {Markdown} from './Markdown';
import type {WorkSession} from './model';
export function PlanComment({note,queued,disabled,onDelete}:{note:WorkSession['notes'][number];queued:boolean;disabled:boolean;onDelete:()=>void}){
 const [expanded,setExpanded]=useState(false);
 const legacyQuote=note.text.match(/\nSelected text:\n([\s\S]*?)\n\nRequested change:\n/)?.[1]?.replace(/^> ?/gm,'');
 const quote=note.annotation?.quote??legacyQuote??'',rich=note.annotation?.markdown;
 const message=note.text.split('\nRequested change:\n').slice(1).join('\nRequested change:\n')||note.text.replace(/^Revision requested: (?:\[Plan v\d+\]\n)?/,'');
 const long=quote.length>180||quote.split('\n').length>3;
 return <article className="plan-comment">
  <header><span>{note.annotation?.kind==='recheck'?'Recheck':note.annotation?.kind==='remove'?'Remove passage':'Comment'} · {queued?'Queued':'Included'}</span>{note.id&&<button className="comment-delete" aria-label="Delete plan comment" title="Delete comment" disabled={disabled} onClick={onDelete}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg></button>}</header>
  {quote&&<div className="comment-passage"><div className={'comment-selection'+(expanded?' expanded':'')}>{rich?<Markdown>{rich}</Markdown>:<span>{quote}</span>}</div>{long&&<button className="text-button" onClick={()=>setExpanded(v=>!v)}>{expanded?'Collapse selection':'Expand selection'}</button>}</div>}
  <div className="comment-message" tabIndex={0} aria-label="Comment text"><Markdown>{message}</Markdown></div><time dateTime={note.at}>{new Date(note.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>
 </article>;
}

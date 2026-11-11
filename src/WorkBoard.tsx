import {useState} from 'react';
import {age,boardColumns,recentDone,sortCards,type BoardCard} from './board-model';

/**
 * Board of requests by what they need: to triage, agent working, needs you, waiting on others, and done (collapsed).
 * Each card shows the key, severity, how long it has been in its state, the title and the next step.
 */
export function WorkBoard({cards,open,emptyText='Nothing here.'}:{cards:BoardCard[];open:(id:string)=>void;emptyText?:string}){
 const [showDone,setShowDone]=useState(false);
 const shown=recentDone(cards);
 return <div className="work-board">
  {boardColumns.map(col=>{const items=sortCards(shown.filter(c=>c.column===col.id)),collapsed=col.id==='done'&&!showDone;
   return <section key={col.id} className={'work-column '+col.id} aria-label={col.title}>
    <header title={col.hint}><h2>{col.title}</h2><span className="work-count">{items.length}</span>{col.id==='done'&&items.length>0&&<button type="button" className="text-button" onClick={()=>setShowDone(v=>!v)}>{showDone?'Hide':'Show'}</button>}</header>
    {collapsed?<p className="small muted work-collapsed">{items.length?`${items.length} finished in the last 7 days.`:'Nothing finished in the last 7 days.'}</p>:
     items.length?<ol>{items.map(c=><li key={c.id}><button type="button" className={'work-card '+c.tone} onClick={()=>open(c.id)}>
      <span className="work-card-top"><span className="work-key">{c.key}</span>{c.severity&&<span className="work-severity">{c.severity}</span>}<span className="work-age" title={new Date(c.since).toLocaleString()}>{age(c.since)}</span></span>
      <strong className="work-title">{c.title}</strong>
      <span className="work-state"><i aria-hidden="true"/>{c.state}</span>
      {c.meta&&<span className="work-meta">{c.meta}</span>}
     </button></li>)}</ol>:<p className="small muted work-collapsed">{emptyText}</p>}
   </section>;})}
 </div>;
}

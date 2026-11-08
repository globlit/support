import {PlanComment} from './PlanComment';
import {selectionMarkdown} from './plan-selection';
import {Select} from './Select';
import {SelectionComment,type SelectionAnchor} from './SelectionComment';
import {useState,useEffect,useRef} from 'react';
import type {LiveDetail,PlanAnnotation} from './model';
import {Markdown,MarkdownPreview} from './Markdown';
type Props={active?:boolean;investigate?:()=>void;detail:LiveDetail;busy:boolean;running:boolean;onEditing?:(editing:boolean)=>void;action:(name:string,text?:string,annotation?:PlanAnnotation)=>Promise<boolean>};
export function PlanReview({detail,busy,running,action,onEditing,active=true,investigate}:Props){
 const {session,issue}=detail,latest=session.plans.at(-1);
 const [version,setVersion]=useState<number|null>(null),[editing,setEditing]=useState(false),[text,setText]=useState(''),[base,setBase]=useState(session.revision);
 useEffect(()=>{onEditing?.(editing);return()=>onEditing?.(false)},[editing,onEditing]);
 const [anchor,setAnchor]=useState<SelectionAnchor|null>(null);
 const [selectionOffsets,setSelectionOffsets]=useState<{start:number;end:number}|undefined>();
 const [quoteMarkdown,setQuoteMarkdown]=useState('');
 const [quote,setQuote]=useState(''),[comment,setComment]=useState(''),[commentOpen,setCommentOpen]=useState(false);const planBody=useRef<HTMLDivElement>(null);
 function selectQuote(){
  const selection=window.getSelection();
  if(!selection||selection.isCollapsed||!planBody.current?.contains(selection.anchorNode)||!planBody.current?.contains(selection.focusNode)){setAnchor(null);return}
  const rects=selection.getRangeAt(0).getClientRects(),rect=rects[rects.length-1];
  if(rect){const range=selection.getRangeAt(0),before=range.cloneRange();before.selectNodeContents(planBody.current!);before.setEnd(range.startContainer,range.startOffset);const start=before.toString().length;setSelectionOffsets({start,end:start+range.toString().length});setQuote(selection.toString().slice(0,3000));setQuoteMarkdown(selectionMarkdown(selection));setCommentOpen(false);setAnchor({left:rect.left,top:rect.bottom+8})}
 }
 useEffect(()=>{if(!active||editing)setAnchor(null)},[active,editing]);

 const selected=session.plans.find(p=>p.version===version)??latest;
 const planNotes=session.notes.filter(n=>n.text.startsWith(`Revision requested: [Plan v${selected?.version}]`)||(selected?.version===latest?.version&&n.text.startsWith('Revision requested: ')&&!/^Revision requested: \[Plan v\d+\]/.test(n.text)));
 const queued=session.notes.filter(n=>n.text.startsWith('Revision requested: ')&&n.at>=(latest?.at??''));
 async function addComment(value:string,send:boolean,kind:PlanAnnotation['kind']='comment'){
  if(!selected||busy||running||issue.resolved)return false;
  const saved=await action('revise',`[Plan v${selected.version}]\n${quote?'Selected text:\n'+quote+'\n\n':''}Requested change:\n${value}`,{...selectionOffsets,version:selected.version,quote,markdown:quoteMarkdown,kind});
  if(saved){setCommentOpen(false);setComment('');setQuote('');setQuoteMarkdown('');setSelectionOffsets(undefined);setAnchor(null);if(send)investigate?.()}
  return saved;
 }
 const historical=!!selected&&selected.version!==latest?.version,stale=editing&&base!==session.revision;
 function edit(){setAnchor(null);setText(selected?.text??'');setBase(session.revision);setEditing(true)}
 async function save(){if(stale)return;if(await action('plan',text)){setEditing(false);setVersion(null)}}
 const approveButton=selected&&!historical&&!editing?<button className="approve-button" title={`Approve plan version ${selected.version}`} disabled={busy||running||issue.resolved||session.pendingRevision||!!session.approval||commentOpen} onClick={()=>void action('approve')}>{session.approval?'Approved':'Approve'}</button>:null;
 return <section id="plan-review" className="decision-section"><header className="decision-heading"><div><h2>Plan</h2></div><div className="actions">{approveButton}{latest&&<Select aria-label="Plan version" value={selected?.version} disabled={editing||busy} onChange={e=>{setVersion(Number(e.target.value));setAnchor(null);setQuote('');setCommentOpen(false);setComment('')}}>{[...session.plans].reverse().map(p=><option key={p.version} value={p.version}>Version {p.version}{p.version===latest.version?' · Current':' · History'}</option>)}</Select>}<button disabled={busy||running||issue.resolved} onClick={()=>editing?setEditing(false):edit()}>{editing?'Cancel edit':latest?'Edit plan':'Write a plan'}</button></div></header>
 <p className="section-description">Review the proposal, then approve it or request edits. Select a passage to comment, recheck or request removal. Queue comments, then send them together for revision.</p>
 {historical&&<p className="history-notice">Viewing version {selected!.version}. Version {latest!.version} remains active. To use this older plan, restore it as a new version and review it against the current request.</p>}
 <div className={(!editing&&(commentOpen||planNotes.length||queued.length))?'plan-layout with-comments':'plan-layout'}><div className="plan-document">{editing?<form onSubmit={e=>{e.preventDefault();void save()}}><label>Plan text · Markdown<textarea className="plan-editor" required maxLength={16000} value={text} onChange={e=>setText(e.target.value)}/></label><MarkdownPreview text={text}/>{stale&&<p className="error">The session changed while you were editing. Copy your edits, cancel, and review the latest version before saving.</p>}<div className="actions"><button className="primary" disabled={busy||running||stale||!text.trim()}>Save as new version</button></div></form>:selected?<div ref={planBody} onMouseUp={selectQuote} onKeyUp={selectQuote}><Markdown annotations={planNotes.map(n=>n.annotation??{version:selected.version,kind:'comment',quote:n.text.match(/\nSelected text:\n([\s\S]*?)\n\nRequested change:\n/)?.[1]?.replace(/^> ?/gm,'')??''})}>{selected.text}</Markdown></div>:<div className="plan-empty"><p>No plan yet.</p><p className="small muted">Start an investigation in the agent panel. Its proposed plan will appear here.</p></div>}
 </div>{!editing&&selected&&<aside className="plan-comments" aria-label="Plan comments">
 {queued.length>0&&<div className="queued-comments"><strong>{queued.length} comment{queued.length===1?'':'s'} to address</strong><button className="primary" disabled={busy||running||issue.resolved||!investigate} onClick={investigate}>Send for revision</button><small>Includes all queued comments. The plan stays unchanged until the agent returns a new version.</small></div>}
 {commentOpen&&<form onSubmit={e=>{e.preventDefault();void addComment(comment,true)}}><h3>Comment on version {selected.version}</h3><label>Your comment<textarea required maxLength={4000} value={comment} onChange={e=>setComment(e.target.value)} placeholder="Add comments to this plan for AI revision…"/></label><div className="actions"><button type="button" disabled={busy||running||issue.resolved||!comment.trim()} onClick={()=>void addComment(comment,false)}>Add comment</button><button className="primary" disabled={busy||running||issue.resolved||!comment.trim()}>Send for revision</button><button type="button" onClick={()=>setCommentOpen(false)}>Cancel</button></div></form>}
 {planNotes.map((n,i)=><PlanComment key={n.id??i} note={n} queued={queued.includes(n)} disabled={busy||running} onDelete={()=>void action('delete-note',n.id)}/>)}
 </aside>}</div>
 {!editing&&selected&&<div className="decision-footer">{historical?<button disabled={busy||running||issue.resolved} onClick={()=>void action('plan',selected.text).then(ok=>{if(ok)setVersion(null)})}>Restore v{selected.version} as a new version</button>:<>{approveButton}<button disabled={busy||running||issue.resolved} onClick={()=>{setAnchor(null);setQuote('');setQuoteMarkdown('');setSelectionOffsets(undefined);setCommentOpen(true)}}>Request edits</button></>}<p className="small muted">{historical?'Restoring preserves history and clears any existing approval.':session.pendingRevision?'A revision is requested. Save an updated plan or ask the agent to revise it.':'Approval covers this plan only. Implementation and outgoing messages require separate review.'}</p></div>}
 {active&&!editing&&selected&&anchor&&<SelectionComment key={`${selected.version}:${quote}`} anchor={anchor} disabled={busy||running||issue.resolved} onClose={()=>setAnchor(null)} onSave={(text,send)=>addComment(text,send)} onQuick={kind=>addComment(kind==='recheck'?'Recheck this passage against current information. Explain any correction or uncertainty.':'Remove this passage from the next plan revision and adjust any dependent steps.',false,kind)}/>}
 </section>;
}

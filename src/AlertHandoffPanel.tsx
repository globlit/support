import {Markdown} from './Markdown';
import {useState} from 'react';
import {useWorkspaceApi} from './WorkspaceRuntime';
import type {AlertCase,AlertHandoff,HandoffReview,HandoffResult} from './model';

export function HandoffContext({handoff:h}:{handoff:AlertHandoff}){
 return <details className="plan-section"><summary>Imported from alert · {h.alertTitle}</summary>
 <p className="small muted">This ticket started from an alert investigation. {h.actor} copied its plan into ticket plan v{h.targetPlanVersion} on {new Date(h.at).toLocaleString()}. This record is background context, not a separate approval.</p>
 <p className="small muted">The alert was {h.alertActive?'firing':'not firing'} when copied ({h.occurrences} occurrences). This is a historical snapshot. Review the current ticket plan in Plan; investigate again if the alert or request has changed.</p>
 {h.notes.length>0&&<><h3>Alert feedback</h3>{h.notes.map((n,i)=><div className="review-note" key={i}><small>{new Date(n.at).toLocaleString()}</small><Markdown>{n.text}</Markdown></div>)}</>}
 {h.analysis&&<><h3>Investigation activity</h3><p className="small muted">Model: {h.analysis.model} · Recorded during the alert investigation.</p><ol className="analysis-events">{h.analysis.events.map((e,i)=><li key={i}><time>{new Date(e.at).toLocaleString()}</time> {e.text}</li>)}</ol></>}
 {h.replyDraft&&<><h3>Alert reply draft · Not sent</h3><Markdown>{h.replyDraft}</Markdown></>}
 </details>;
}
export function AlertHandoffPanel({alert,busy,run,openTicket}:{alert:AlertCase;busy:boolean;run:(fn:()=>Promise<void>)=>Promise<void>;openTicket:()=>void}){const api=useWorkspaceApi();
 const [review,setReview]=useState<HandoffReview|null>(null),[result,setResult]=useState<HandoffResult|null>(null);
 const stale=review&&review.source.updated!==alert.updated;
 return <section className="analysis-panel"><div className="heading"><div><h2>Continue in the ticket</h2><p className="small muted">Carry the full plan, investigation activity and feedback into the linked local work session.</p></div><button disabled={busy} onClick={openTicket}>Open work session</button></div>
 <button disabled={busy} onClick={()=>void run(async()=>{setResult(null);setReview(null);setReview(await api<HandoffReview>('/alerts/'+alert.id+'/handoff/preview','POST',{}));})}>{review?'Refresh handoff review':'Review handoff'}</button>
 {review&&<><h3>{review.target.key} · {review.target.title}</h3><p className="small muted">Alert plan v{review.source.planVersion} → {review.alreadyImported?`already carried as ticket plan v${review.alreadyImported}`:`new ticket plan v${review.target.planCount+1}`}.</p>
 <div className="notice">Local copy only. Nothing is posted to YouTrack or GitLab. Fresh approval is required in the ticket before preparing GitLab changes.{review.target.hasReplyDraft?' The ticket’s existing reply draft will be kept.':''}{review.target.pendingRevision?' Its pending revision request will also remain; address it before approval.':''}</div>
 <details className="plan-section" open><summary>Full plan to carry</summary><Markdown>{review.plan}</Markdown></details>
 <details className="plan-section"><summary>Investigation context · {review.notes.length} notes · {review.analysis?.events.length??0} activity entries</summary>{review.notes.map((n,i)=><Markdown key={i}>{n.text}</Markdown>)}{review.analysis?.events.map((e,i)=><p key={i} className="small muted">{new Date(e.at).toLocaleString()} · {e.text}</p>)}{review.replyDraft&&<><h3>Reply draft · Not sent</h3><Markdown>{review.replyDraft}</Markdown></>}</details>
 {stale&&<p className="notice">The alert changed. Refresh the handoff review.</p>}
 {!review.alreadyImported&&!result&&<button className="primary" disabled={busy||!!stale} onClick={()=>void run(async()=>{setResult(await api<HandoffResult>('/alerts/'+alert.id+'/handoff/carry','POST',{hash:review.hash}));})}>Carry plan to ticket</button>}
 {review.alreadyImported&&!result&&<p className="success">This version is already in the ticket. Existing work and approval have been kept.</p>}
 </>}
 {result&&<div className="approval-box"><p className="success">{result.alreadyImported?'Already carried':'Carried'} to {result.detail.issue.key} as plan v{result.handoff.targetPlanVersion}.{!result.alreadyImported?' Fresh engineer approval is required.':''}</p><button className="primary" disabled={busy} onClick={openTicket}>Review ticket plan →</button></div>}
 </section>;
}

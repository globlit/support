import {SafeLink} from './SafeLink';
import {Markdown} from './Markdown';
import type {AnalysisRun} from './model';

function downloadSnapshot(run:AnalysisRun,issueKey:string,kind:'plan'|'reply'){
 const text=kind==='plan'?run.plan:run.replyDraft;
 if(!text)return;
 const label=kind==='plan'?`Plan${run.planVersion?` v${run.planVersion}`:''}`:'Reply draft';
 const document=`# ${issueKey} · ${label}\n\nHistorical snapshot from ${run.startedAt}. This download does not approve a plan or send a reply.\n\n---\n\n${text}\n`;
 const url=URL.createObjectURL(new Blob([document],{type:'text/markdown;charset=utf-8'}));
 const link=window.document.createElement('a');link.href=url;
 link.download=`${issueKey.replace(/[^a-zA-Z0-9_-]/g,'_')}-${kind}-${run.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.md`;
 link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function RunSnapshots({run,issueKey,planHref}:{run:AnalysisRun;issueKey:string;planHref:string}){
 return <section className="investigation-snapshots" aria-label="Historical snapshots">
  <h3>Snapshots from this run</h3>
  <p className="small muted">Saved when this investigation finished. Reply drafts describe the proposal at that time, not completed work.</p>
  {(['plan','reply'] as const).map(kind=>{
   const text=kind==='plan'?run.plan:run.replyDraft;if(!text)return null;
   return <details className="investigation-snapshot" key={run.id+kind}><summary>{kind==='plan'?`Plan${run.planVersion?` v${run.planVersion}`:''}`:'Reply draft'} <span>Historical snapshot</span></summary>
    <div className="snapshot-actions"><button type="button" className="text-button" onClick={()=>downloadSnapshot(run,issueKey,kind)}>Download Markdown ↓</button>{kind==='plan'&&<SafeLink href={planHref}>View current plan →</SafeLink>}</div>
    <div className="snapshot-document" tabIndex={0} aria-label={`${kind==='plan'?'Plan':'Reply'} snapshot content`}><Markdown>{text}</Markdown></div>
   </details>;
  })}
 </section>;
}

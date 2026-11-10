import {useEffect,useState} from 'react';
import {api} from './api';
import type {ChangeProposal} from './model';

/** Unified-style line diff of two texts: unchanged lines are kept as context only near changes. */
export function lineDiff(before:string|null,after:string|null,context=3){
 const a=(before??'').split('\n'),b=(after??'').split('\n');
 if(before===null)return b.map(l=>'+'+l);if(after===null)return a.map(l=>'-'+l);
 // Longest common subsequence on lines, bounded to keep the browser responsive.
 if(a.length*b.length>4_000_000)return [...a.map(l=>'-'+l),...b.map(l=>'+'+l)];
 const dp=Array.from({length:a.length+1},()=>new Uint32Array(b.length+1));
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
 const out:string[]=[];let i=0,j=0;
 while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){out.push(' '+a[i]);i++;j++;}else if(i<a.length&&(j===b.length||dp[i+1][j]>=dp[i][j+1])){out.push('-'+a[i]);i++;}else{out.push('+'+b[j]);j++;}}
 const keep=out.map((l,k)=>l[0]!==' '||out.slice(Math.max(0,k-context),k+context+1).some(x=>x[0]!==' '));
 return out.flatMap((l,k)=>keep[k]?[l]:k===0||keep[k-1]?['…']:[]);
}

/**
 * Code changes the agent proposed with the current plan. Each proposal shows its files and diff. When the plan is
 * approved, "Create branch from proposal" starts the usual branch, diff review and merge request flow.
 */
export function ProposalList({connection,issueId,approved,disabled,onCreate}:{connection:string;issueId:string;approved:boolean;disabled?:boolean;onCreate:(proposal:ChangeProposal)=>void}){
 const [proposals,setProposals]=useState<ChangeProposal[]>([]);
 useEffect(()=>{let alive=true;api<{proposals:ChangeProposal[]}>(`/proposals?connection=${encodeURIComponent(connection)}&issue=${encodeURIComponent(issueId)}`).then(r=>{if(alive)setProposals(r.proposals)}).catch(()=>{});return ()=>{alive=false};},[connection,issueId]);
 if(!proposals.length)return null;
 return <section className="proposals" aria-label="Proposed code changes">
  <h3>Proposed by the agent</h3>
  {proposals.map(p=><article key={p.id} className="proposal">
   <header><div><strong>{p.title}</strong><span className="small muted"><code>{p.project}</code> · {p.files.length} file{p.files.length===1?'':'s'} · from {p.commit.slice(0,8)}</span></div>
    <button type="button" className="primary" disabled={!approved||disabled} title={approved?undefined:'Approve the plan first.'} onClick={()=>onCreate(p)}>Create branch from proposal</button></header>
   <p className="proposal-summary">{p.summary}</p>
   {p.files.map(f=><details key={f.path} className="proposal-file"><summary><code>{f.path}</code><span className={'proposal-kind '+(f.before===null?'added':f.after===null?'deleted':'modified')}>{f.before===null?'added':f.after===null?'deleted':'modified'}</span></summary>
    <pre className="proposal-diff">{lineDiff(f.before,f.after).map((l,k)=><span key={k} className={l[0]==='+'?'add':l[0]==='-'?'del':l==='…'?'gap':''}>{l}{'\n'}</span>)}</pre>
   </details>)}
  </article>)}
 </section>;
}

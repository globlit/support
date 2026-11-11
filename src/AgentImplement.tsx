import {useState} from 'react';
import {api} from './api';
import {useFeedback} from './Toasts';
import type {LiveDetail} from './model';

/**
 * Asks the agent to implement the approved plan in its existing session: it edits worktrees, validates the changes
 * and submits them as proposals. Shown once a plan is approved.
 */
export function AgentImplement({detail}:{detail:LiveDetail}){
 const [busy,setBusy]=useState(false),feedback=useFeedback();
 if(!detail.session.approval)return null;
 async function implement(){setBusy(true);try{await api('/agent/implement','POST',{connection:detail.issue.connection,issueId:detail.issue.id});feedback.success('The agent is implementing the approved plan. Follow it in the agent console.');}catch(e){feedback.error(e);}finally{setBusy(false);}}
 return <div className="agent-implement"><div><strong>Let the agent implement plan v{detail.session.approval.version}</strong><p className="small muted">The agent continues its session: it edits a worktree of each repository, runs lint and tests, and submits the result as a proposal below. Nothing is written to GitLab until you create the branch and approve the merge request.</p></div><button className="primary" disabled={busy} onClick={()=>void implement()}>{busy?'Starting…':'Implement with the agent'}</button></div>;
}

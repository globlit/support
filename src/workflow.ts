import type {ChangeSet,LiveDetail} from './model';
export function nextReview(detail:LiveDetail,changes:ChangeSet[]){
 const c=[...changes].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
 const step=(stage:number,title:string,body:string,tab:string,action:string)=>({stage,title,body,tab,action});
 if(detail.issue.resolved)return step(5,'Ticket closed','YouTrack marks this ticket as resolved. Review the history before starting more work.','Issue','Read ticket');
 if(c?.resolution?.state==='reopened')return step(4,'Ticket reopened','The previous resolution needs another look. Review the source and previous changes.','Changes','Review resolution');
 if(c?.resolution?.state==='posted')return step(4,'Review ticket closure','The resolution summary was posted. Closing the ticket requires a separate review.','Changes','Review closure');
 if(c?.resolution?.state==='draft')return step(4,'Review the resolution message','Read and edit the summary before approving its publication to YouTrack.','Changes','Review message');
 if(c?.tracking?.state==='merged')return step(4,'Verify and resolve','The MR is merged. Verify the target pipeline, then prepare the resolution summary.','Changes','Review completion');
 if(c?.fixes?.some(f=>f.state==='proposed'))return step(3,'Review the proposed fix','The agent prepared a fix locally. Review its diff before allowing a push.','Changes','Review fix');
 if(c?.mr)return step(3,'Follow the merge request','Review the latest pipeline status. Failed jobs can be investigated; merging remains in GitLab.','Changes','Open delivery');
 if(c&&['branch_pending','mr_pending','generating','failed','changed'].includes(c.state))return step(2,'Changes need attention',c.message,'Changes','Inspect changes');
 if(c?.state==='review')return step(2,'Review the code and MR message','A support branch was prepared. Inspect every changed file and edit the message before creating an MR.','Changes','Review diff & message');
 if(detail.session.pendingRevision)return step(1,'Revision requested','Your feedback is saved. Ask the agent to revise the plan before approving it.','Plan','Read feedback & revise');
 if(detail.session.approval)return step(2,'Choose the change scope','The plan is approved. Select the repository and files, then prepare the support branch.','Changes','Prepare changes');
 if(detail.session.plans.length)return step(1,'Review the proposed plan','Read the plan below. Approve it, or send feedback and request a new version. Approval alone does not execute it.','Plan','Review plan');
 return step(0,'Ready for investigation','Start the agent to read the ticket and configured tools. It will return a plan for your review.','Plan','Open investigation');
}

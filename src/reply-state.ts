import type {ChangeSet} from './model';

// Only a verified resolution draft can become a reply for review. Investigation
// drafts and source-branch CI results never establish implementation completion.
export function replyStatus(change?:ChangeSet){
 const state=change?.resolution?.state;
 if(state==='posting')return 'Confirming delivery';
 if(state==='reopened')return 'Sent · ticket reopened';
 if(state==='closed')return 'Sent · ticket closed';
 if(state==='closing')return 'Sent · closing ticket';
 if(state==='posted')return 'Sent';
 if(state==='draft')return 'Ready for review';
 if(change?.tracking?.state==='merged')return 'Verify implementation';
 return 'Waiting for implementation';
}
export function latestChange(changes:ChangeSet[]){return [...changes].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];}

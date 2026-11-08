import type { Ticket,Step } from '../src/model.js';
const secretSteps:Step[]=[
['target','Confirm the target','Check payment-api in the payments namespace on preprod-eu-02. Match the live resource to the SealedSecret in the Flux repository. Stop if the target or repository differs.'],
['configuration','Check the current configuration','Read the manifest and Git history. Confirm DATABASE_URL is the only key being replaced. Preserve other keys, labels, annotations and ownership settings.'],
['input','Check the secure input','Use the approved secure input. Never copy the value into this ticket, tool output or commit message. Ask for a new input if it is missing or expired.'],
['branch','Prepare a branch','Record the main commit and prepare an isolated working copy. Create support/SUP-1842. Do not change the engineer’s checkout.'],
['seal','Seal the replacement','Use the certificate for the target cluster and preserve the existing scope. Keep plaintext out of Git and remove temporary input after sealing.'],
['manifest','Update the manifest','Replace only encryptedData.DATABASE_URL in apps/payments/sealed-secret.yaml. Compare with the original and check for unrelated changes.'],
['checks','Run checks','Validate the manifest, namespace, resource name and sealing scope. Recheck the base commit before writing. If it changed, pause for a new review.'],
['mr','Open a merge request','Commit on the support branch and open an MR linked to SUP-1842. Include the changed key name and checks. Do not merge.'],
['report','Report and recover','Prepare the completion message separately for approval. If a step fails, report what completed and what remains. A revert requires a separate approved plan.']
].map(([id,title,body])=>({id,title,body}));
export function samples():Ticket[]{const now=new Date().toISOString();return [
['SUP-1842','Update payments secret','YouTrack','Medium','Preproduction','preprod-eu-02 / payments','Review','Approve plan'],
['SUP-1835','Payments error rate','Alertmanager','Critical','Preproduction','preprod-eu-02 / payments','Review','Review reopened case'],
['SUP-1846','Dev cluster access','Slack','Low','Development','dev-eu-03','Review','Approve reply'],
['SUP-1848','Missing application logs','YouTrack','Medium','Development','dev-eu-04 / logging','In progress','Checking collector configuration'],
['SUP-1849','Container restart spike','Alertmanager','Warning','Preproduction','preprod-eu-01 / checkout','In progress','Reading pod events'],
['SUP-1841','DNS for preview environment','YouTrack','Medium','Development','preview.dev.internal','Waiting','Manual change needed'],
['SUP-1839','Service dashboard','YouTrack','Low','Development','dev-eu-03','Waiting','Waiting for requester'],
['SUP-1850','Add queue metrics','YouTrack','Medium','Development','dev-eu-02 / workers','Backlog','Queued'],
['SUP-1832','Development kubeconfig','YouTrack','Low','Development','dev-eu-01','Done','Access verified']
].map(([id,title,source,severity,environment,target,status,next])=>({id,title,source,severity,environment,target,status:status as Ticket['status'],next,needsYou:status==='Review'||id==='SUP-1841',reopened:id==='SUP-1835',sample:true,revision:1,plans:[{version:1,steps:id==='SUP-1842'?secretSteps:[{id:'read',title:'Check the request',body:'Read the request and relevant configuration. Identify any missing information before proposing changes.'},{id:'review',title:'Prepare the next step',body:'Draft a response or procedure for engineer review. External actions require separate approval.'}],scope:id==='SUP-1842'?'Seal one supplied value, commit on an isolated branch and open one merge request. No merge, rollout or direct cluster writes.':'Read configuration and prepare a response. No external writes.',createdAt:now,change:'Initial sample plan'}],notes:[],events:[{at:now,title:'Sample ticket loaded',detail:'Illustrative content. No tools have been called.'}],approval:null,draft:'Which namespace and key should be updated? Please share the approved secure location, not the secret value.',updatedAt:now}));}

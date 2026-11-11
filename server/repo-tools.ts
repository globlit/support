import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError,type Store} from './store.js';
import {GitLab,projectPath} from './gitlab.js';
import {uploadRepo,repoChanges,runSandboxCommand,folderChanges,type RepoChange} from './sandbox.js';
import {assertNoCredentials,credentialFile,filePath} from './changes.js';
import type {ChangeProposal} from '../src/model.js';

/** Folder name of a project checkout in the sandbox: the project path in lower case, with "/" replaced by "--". */
export const repoSlug=(project:string)=>project.toLowerCase().replace(/\//g,'--').replace(/[^a-z0-9._-]/g,'-').slice(0,100);
const fileLimit=1_000_000;

/**
 * Checks out a GitLab repository in the run's sandbox folder at repos/<slug>.
 * With `cloneUrl` (the Git read proxy), the sandbox runs `git clone` with full history and marks the checked-out commit
 * with refs/support/base. Without it, Support downloads the archive with the Vault token and uploads it to the sandbox.
 * The token is never sent to the sandbox. Returns the checkout folder, commit and file count.
 */
export async function repoCheckout(store:Store,input:unknown,runId:string,signal:AbortSignal,fetcher:typeof fetch,cloneUrl?:(project:string)=>string){
 const {project,ref}=z.object({project:projectPath,ref:z.string().trim().min(1).max(255).optional()}).strict().parse(input);
 const g=new GitLab(store,project,fetcher);const info=await g.info();
 if(!info)throw new AppError(404,`GitLab project ${project} not found, or the token cannot access it.`);
 const target=ref??info.default_branch;if(!target)throw new AppError(400,`${project} has no default branch. Give a ref.`);
 const commit=await g.commitOf(target),slug=repoSlug(project),path=`repos/${slug}`;
 if(cloneUrl){
  const command=['set -e','mkdir -p repos',`rm -rf ${path}`,`git clone -q --filter=blob:none --no-checkout '${cloneUrl(project)}' ${path}`,`cd ${path}`,`git -c advice.detachedHead=false checkout -q ${commit}`,'git update-ref refs/support/base HEAD','echo "files=$(git ls-files | wc -l)"'].join('\n');
  const r=await runSandboxCommand({runId,command,timeoutSeconds:300,signal,fetcher});
  if(r.exitCode!==0)throw new AppError(502,`git clone failed in the sandbox: ${r.output.trim().split('\n').slice(-3).join(' ').slice(0,500)}`);
  const files=Number(r.output.match(/files=\s*(\d+)/)?.[1]??0);
  return {project,ref:target,commit,path,files,history:true,note:'Full Git history is available (git log, git blame, git fetch origin <branch>). Edit files there with run_command. Call propose_change when the fix is ready. Pushing is refused.'};
 }
 const archive=await g.archive(commit);
 const result=await uploadRepo(runId,slug,archive.body!,signal,fetcher);
 return {project,ref:target,commit,path:result.path,files:result.files,history:false,note:'Snapshot without Git history. Edit files there with run_command. Call propose_change when the fix is ready.'};
}

/**
 * Reads the files changed in a sandbox checkout and builds a change proposal. Each file is checked for credentials,
 * and its content at the checked-out commit is read from GitLab. Nothing is written to GitLab.
 */
export async function proposeChange(store:Store,input:unknown,runId:string,checkouts:Map<string,string>,fetcher:typeof fetch):Promise<ChangeProposal>{
 const {project,title,summary}=z.object({project:projectPath,title:z.string().trim().min(3).max(200),summary:z.string().trim().min(1).max(8000)}).strict().parse(input);
 const commit=checkouts.get(project);if(!commit)throw new AppError(400,`Check out ${project} with repo_checkout before proposing a change.`);
 const changed=await repoChanges(runId,repoSlug(project),fetcher);
 if(!changed.length)throw new AppError(400,'The checkout has no changes to propose.');
 const g=new GitLab(store,project,fetcher),files:ChangeProposal['files']=[];
 for(const f of changed){
  if(!filePath.safeParse(f.path).success)throw new AppError(400,`${String(f.path).slice(0,200)} is not a valid repository path.`);
  if(credentialFile(f.path))throw new AppError(400,`${f.path} is a credential file. It cannot be changed by the agent.`);
  const after=f.content===null?null:Buffer.from(f.content,'base64').toString('utf8');
  if(after!==null){if(after.includes('\0')||Buffer.byteLength(after)>fileLimit)throw new AppError(400,`${f.path} is binary or larger than 1 MB.`);assertNoCredentials(store,after);}
  const before=f.status==='A'?null:await g.file(f.path,commit);
  files.push({path:f.path,before,after});
 }
 assertNoCredentials(store,summary);
 return {id:randomUUID(),project,commit,title,summary,at:new Date().toISOString(),files};
}

/**
 * Builds a change proposal from a Git folder of the agent sandbox, compared with commit `base`. The commit must exist
 * in the GitLab project, which provides the original content of each file. Each file is checked for credentials.
 * Nothing is written to GitLab.
 */
export async function proposeFromFolder(store:Store,input:unknown,fetcher:typeof fetch):Promise<ChangeProposal>{
 const {project,dir,base,title,summary}=z.object({project:projectPath,dir:z.string().min(2).max(1000).refine(v=>v.startsWith('/')&&!v.split('/').includes('..'),'Use the absolute path of the Git folder.'),base:z.string().regex(/^[0-9a-f]{7,64}$/,'base must be the commit SHA the edits started from.'),title:z.string().trim().min(3).max(200),summary:z.string().trim().min(1).max(8000)}).strict().parse(input);
 const g=new GitLab(store,project,fetcher);
 const commit=await g.commitOf(base).catch(()=>{throw new AppError(400,`Commit ${base} is not in ${project} on GitLab. Start the edits from a commit that GitLab has, for example the default branch head.`);});
 const changed=await folderChanges(dir,commit,fetcher);
 if(!changed.length)throw new AppError(400,'The folder has no changes since this commit.');
 return {...await buildProposal(store,g,project,commit,title,summary,changed)};
}
async function buildProposal(store:Store,g:GitLab,project:string,commit:string,title:string,summary:string,changed:RepoChange[]):Promise<ChangeProposal>{
 const files:ChangeProposal['files']=[];
 for(const f of changed){
  if(!filePath.safeParse(f.path).success)throw new AppError(400,`${String(f.path).slice(0,200)} is not a valid repository path.`);
  if(credentialFile(f.path))throw new AppError(400,`${f.path} is a credential file. It cannot be changed by the agent.`);
  const after=f.content===null?null:Buffer.from(f.content,'base64').toString('utf8');
  if(after!==null){if(after.includes('\0')||Buffer.byteLength(after)>fileLimit)throw new AppError(400,`${f.path} is binary or larger than 1 MB.`);assertNoCredentials(store,after);}
  const before=f.status==='A'?null:await g.file(f.path,commit);
  files.push({path:f.path,before,after});
 }
 assertNoCredentials(store,summary);
 return {id:randomUUID(),project,commit,title,summary,at:new Date().toISOString(),files};
}

import {claudeLoginStatus} from './claude-login.js';
import {chatGPT} from './chatgpt.js';
import {z} from 'zod';
import {GitLab,serviceBase,boundedJSON,gitLabProjects} from './gitlab.js';
import {modelKey} from './model-api.js';
import {Store,AppError} from './store.js';

export async function checkGitLabConnection(store:Store,fetcher:typeof fetch=fetch){
 const config=store.snapshot().config;
 if(!config.connections.GitLab.enabled)throw new AppError(400,'Enable GitLab in Connections first.');
 const projects=await gitLabProjects(store,fetcher);
 if(!projects.length)throw new AppError(400,'The saved GitLab token cannot access any project. Give the token access to the projects Support may change.');
 const checks=[{label:'Project access',ok:true,detail:`The token can access ${projects.length>=100?'at least 100 projects':projects.length===1?'1 project':projects.length+' projects'}. Support can prepare changes in each of them.`}];
 const first=projects[0];
 if(first.defaultBranch){
  const git=new GitLab(store,first.project,fetcher);
  const branch=await git.branch(first.defaultBranch);
  if(!branch)throw new AppError(400,`Default branch ${first.defaultBranch} was not found in ${first.project}.`);
  const pipelines=z.array(z.object({id:z.number(),status:z.string()})).parse(await git.request('pipelines',{ref:first.defaultBranch,per_page:'1'}));
  checks.push({label:first.project+' read access',ok:true,detail:`Read branch ${first.defaultBranch} (${branch.id.slice(0,8)}) and pipelines. Latest: ${pipelines[0]?.status??'none'}. No writes performed; write permissions are not tested.`});
 }
 return {checks,liveTest:true};
}

export async function checkModelConnection(store:Store,fetcher:typeof fetch=fetch){
 const s=store.snapshot(),c=s.config.connections.Model,epoch=store.credentialEpoch;
 if(!c.enabled||!c.endpoint||!c.scope)throw new AppError(400,'Enable Model and save its API base URL and model ID first.');
 if(s.config.modelAuth==='claude_subscription'){if(!store.key)throw new AppError(423,'Unlock the Vault first.');if(s.config.modelProvider!=='anthropic')throw new AppError(400,'The Claude subscription requires the Claude provider.');const status=await claudeLoginStatus();return {liveTest:true,checks:[{label:'Claude login in the sandbox',ok:status.connected,detail:status.connected?'Claude Code in the sandbox is signed in with a Claude account. No generation performed.':'Sign in inside the sandbox: docker compose exec -u admin sandbox claude auth login. Current method: '+status.method}]};}
 if(s.config.modelAuth==='chatgpt'){await modelKey(store);const models=await chatGPT(store).models();if(!models.some(m=>m.id===c.scope))throw new AppError(400,'Select a model from this ChatGPT account.');return {liveTest:true,checks:[{label:'ChatGPT model catalog',ok:true,detail:'Account model catalog read successfully. Only completed inference verifies subscription access.'}]};}
 const base=serviceBase(c.endpoint);if(/\/v1\/?$/.test(base.pathname))throw new AppError(400,'Use the API base URL without /v1.');
 const key=await modelKey(store);
 const headers:Record<string,string>=s.config.modelProvider==='openai'?{Authorization:'Bearer '+key}:{'x-api-key':key,'anthropic-version':'2023-06-01'};
 const model=z.object({id:z.string().min(1)}).parse(await boundedJSON(fetcher,new URL('v1/models/'+encodeURIComponent(c.scope),base),headers));
 if(epoch!==store.credentialEpoch||s.configRevision!==store.snapshot().configRevision||!store.key)throw new AppError(409,'Settings or credentials changed. Check again.');
 return {liveTest:true,checks:[{label:'Model read access',ok:true,detail:`Authenticated and read model ${model.id}. No ticket content sent or generation performed. Generation also requires API quota and tool-calling support.`}]};
}

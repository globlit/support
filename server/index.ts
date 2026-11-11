import {sourceKind,sourcePage} from '../src/intake-model.js';
import {AgentQueue} from './agent-queue.js';
import {agentFeed,agentHalted,setAgentHalted,type FeedEntry} from './agent-feed.js';
import {killAllSandbox,sandboxHealth} from './sandbox.js';
import {GitProxy} from './git-proxy.js';
import {AgentGateway} from './agent-gateway.js';
import {PrometheusSources} from './prometheus-sources.js';
import {deployment} from './deployment.js';
import {Sessions} from './sessions.js';
import {withIdentity,workspaceIdentity,assertActiveRequest} from './identity.js';
import {Notifications,notificationQuery} from './notifications.js';
import {Slack} from './slack.js';
import {IncomingReplies} from './incoming-replies.js';
import {handlingInput,setHandling,ignoreInput,addIgnore,removeIgnore,rules} from './intake.js';
import {InvestigationQueue} from './investigation-queue.js';
import {dispositionInput,updateDispositions} from './ai-dispositions.js';
import {HealthPoller,serviceProbe,testConnection} from './health-poller.js';
import {recordHealthProbe,toolHealth} from './tool-health.js';
import {dashboard} from './dashboard.js';
import {loggedFetch,readLogs,recordDiagnostic} from './diagnostics.js';
import {logTools} from '../src/diagnostics-model.js';
import {aiOverview} from './ai-activity.js';
import {chatGPT} from './chatgpt.js';
import { checkGitLabConnection,checkModelConnection } from './connections.js';
import { createServer,type IncomingMessage,type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import {gitLabProjects} from './gitlab.js';
import {mergeKubeconfigs,stopTunnels,toolboxFiles} from './toolbox.js';
import {generateToolboxSetup,kubeconfigContexts,setupHash} from './toolbox-setup.js';
import {maxKubeconfigBytes,toolboxStoredValue} from './toolbox-config.js';
/** Request size limit for kubeconfig loading, generation and saving: 8 MiB. */
const kubeconfigBodyLimit=8*1024*1024;
import { resolve,join,extname,relative,isAbsolute } from 'node:path';
import { z } from 'zod';
import { Store,AppError } from './store.js';
import { Resolutions } from './resolution.js';
import { Pipelines } from './pipelines.js';
import { Changes,prepareSchema,reviewSchema } from './changes.js';
import { AlertHandoffs } from './alert-handoff.js';
import { AlertTickets,alertDraftInput } from './alert-tickets.js';
import { Alertmanager } from './alertmanager.js';
import { Claude } from './claude.js';
import { YouTrack } from './youtrack.js';
import { connectionNames,configSchema ,toolboxSettingsSchema,type RunBasis} from '../src/model.js';
import {credentialInput,storedCredential} from './service-auth.js';
process.umask(0o077);
const runtime=deployment(),{port}=runtime,origin=runtime.publicOrigin;
const store=new Store(resolve(process.env.SUPPORT_DATA_DIR??'.support-data'));
const sessions=new Sessions(store,runtime);
const transport=loggedFetch(store);
const health=new HealthPoller(store);
const healthTimer=setInterval(()=>void health.tick(),1000);healthTimer.unref();
const youtrack=new YouTrack(store,transport);
const claude=new Claude(store,youtrack,transport);
const gitProxy=new GitProxy(store);
if(process.env.SUPPORT_RELAY_BIND?.trim())gitProxy.listen(process.env.SUPPORT_RELAY_BIND.trim(),Number(process.env.SUPPORT_GIT_PROXY_PORT??7071)).then(()=>claude.useGitProxy(gitProxy),e=>console.error('Git proxy not started:',e instanceof Error?e.message:e));
const gateway=new AgentGateway(store);
if(process.env.SUPPORT_RELAY_BIND?.trim())gateway.listen(process.env.SUPPORT_RELAY_BIND.trim(),Number(process.env.SUPPORT_GATEWAY_PORT??7072)).then(()=>claude.useGateway(gateway),e=>console.error('Agent gateway not started:',e instanceof Error?e.message:e));
const agentQueue=new AgentQueue(store,id=>claude.isActive(id));
claude.onRun({started:r=>agentQueue.started(r),finished:(id,state,error)=>agentQueue.finished(id,state,error)});
/** Kill switch, running investigations and sandbox status, as shown in the agent console. */
const agentState=async()=>({halted:agentHalted(store),running:[...agentFeed.running.values()],sandbox:{...await sandboxHealth(),commandsEnabled:store.snapshot().config.agentCommands},queue:agentQueue.counts(),parallelReview:store.snapshot().config.parallelReview});
const notifications=new Notifications(store,()=>aiOverview(store,claude).workflows);
claude.onQuestion(run=>{const [key,...title]=(run.title??'').split(' · ');notifications.question({key,title:title.join(' · '),source:sourceKind(run.connection??'')==='alert'?'alert':sourceKind(run.connection??'')==='slack'?'slack':'youtrack',route:`#/${sourcePage(run.connection??'')}?issue=${encodeURIComponent(run.issueId)}&step=investigation`});});
const notificationTimer=setInterval(()=>notifications.tick(),5000);notificationTimer.unref();
const intake=new InvestigationQueue(store,youtrack,agentQueue);
const intakeTimer=setInterval(()=>void intake.tick(),5000);intakeTimer.unref();
const alerts=new Alertmanager(store,transport);
const alertTickets=new AlertTickets(store,alerts,youtrack);
const handoffs=new AlertHandoffs(store,alerts,youtrack);
const alertTimer=setInterval(()=>void alerts.tick(claude,agentQueue),5000);alertTimer.unref();
const slack=new Slack(store,transport);
const slackTickets=new AlertTickets(store,slack,youtrack,slack);
const resolveSource=(id:string,connection?:string)=>id.startsWith('alert:')?alerts.issue(id.slice(6)):id.startsWith('slack:')?slack.issue(id.slice(6)):connection?.startsWith('alertmanager:')?alerts.issue(id):connection?.startsWith('slack:')?slack.issue(id):youtrack.issue(id);
const changes=new Changes(store,youtrack,transport,resolveSource);
const pipelines=new Pipelines(store,youtrack,transport,resolveSource);
const resolutions=new Resolutions(store,youtrack,transport,resolveSource);
const replies=new IncomingReplies(store,resolveSource,slack,resolutions,transport);
const slackTimer=setInterval(()=>void slack.tick(agentQueue),5000);slackTimer.unref();
/** Starts a run of a request on `basis`, through the source that owns the request (YouTrack, alerts or Slack). */
async function startRun(connection:string,issueId:string,basis:RunBasis){
 const kind=sourceKind(connection);
 const detail=kind==='alert'?await alerts.work(issueId):kind==='slack'?await slack.work(issueId):await youtrack.work(issueId);
 const expected={revision:detail.session.revision,sourceUpdated:detail.issue.updated};
 return kind==='alert'?alerts.analyze(issueId,expected,claude,basis):claude.start(issueId,expected,kind==='slack'?slack:youtrack,basis);
}
/**
 * Continues the session of a run with the engineer's text (`continue`), or rechecks the request in it (`recheck`).
 * A running session receives the text as a message instead. A continuation answers the run's open questions.
 */
async function continueRun(runId:string,text:string,by:string,kind:'continue'|'recheck'='continue'){
 if(claude.isActive(runId))return {message:claude.message(runId,{text},by)};
 const parent=claude.status(runId);
 if(!parent.connection||!parent.sessionId)throw new AppError(409,'This run has no agent session to continue. Start over instead.');
 const open=(parent.questions??[]).filter(q=>!q.answer);
 const prompt=kind==='recheck'?text:open.length?`The engineer answered your questions:\n${open.map(q=>`- ${q.text}`).join('\n')}\n\nAnswer:\n${text}`:`Message from the engineer:\n${text}`;
 const run=await startRun(parent.connection,parent.issueId,{kind,runId,text,...(kind==='continue'?{prompt}:{}),by});
 if(kind==='continue')claude.answerQuestions(runId,text,by);
 return {run};
}
claude.onResume((run,prompt)=>continueRun(run.id,prompt,'Support'));
agentQueue.register('youtrack',{load:id=>youtrack.work(id),start:(id,expected)=>claude.start(id,expected)});
agentQueue.register('alert',{load:id=>alerts.work(id),start:(id,expected)=>alerts.analyze(id,expected,claude),onStartError:(id,error)=>alerts.recordStartFailure(id,error)});
agentQueue.register('slack',{load:id=>slack.work(id),start:(id,expected)=>claude.start(id,expected,slack)});
const queueTimer=setInterval(()=>void agentQueue.tick(),5000);queueTimer.unref();
let attempts:{time:number;count:number}={time:Date.now(),count:0};
function rateLimit(){if(Date.now()-attempts.time>60_000)attempts={time:Date.now(),count:0};if(++attempts.count>20)throw new AppError(429,'Too many attempts. Try again in a minute.');}
/** Reads a JSON request body of at most `limit` bytes. Kubeconfig requests use a larger limit. */
async function body(req:IncomingMessage,limit=262144){if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError(415,'JSON required');let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw new AppError(413,'Request too large');chunks.push(chunk)}assertActiveRequest();try{return JSON.parse(Buffer.concat(chunks).toString())}catch{throw new AppError(400,'Invalid JSON')}}
function send(res:ServerResponse,value:unknown,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}
const actionSchema=z.object({action:z.enum(['revise','sample-revision','approve','changed','note','draft','reopen']),revision:z.number().int(),text:z.string().max(16000).optional(),stepId:z.string().max(100).optional()}).strict();
const server=createServer({maxHeaderSize:16384,headersTimeout:10000,requestTimeout:30000,keepAliveTimeout:5000},async(req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");try{
 if(req.headers.host!==runtime.host)throw new AppError(403,'Use the configured Support address.');
 if(!['GET','HEAD'].includes(req.method??'')&&req.headers.origin!==origin)throw new AppError(403,'Invalid request origin.');
 const url=new URL(req.url??'/',origin);const path=url.pathname;
 if(path==='/auth/chatgpt/callback'&&req.method==='GET'){let result='success';try{sessions.require(req);await chatGPT(store).callback(url.searchParams);}catch{result='error';}res.writeHead(303,{Location:'/#/auth?result='+result});res.end();return;}
 if(path.startsWith('/api/')){
  if((req.headers.origin&&req.headers.origin!==origin)||['cross-site','same-site'].includes(String(req.headers['sec-fetch-site']??'')))throw new AppError(403,'Cross-origin API access is not allowed.');
 if(path==='/api/session'&&req.method==='GET')return send(res,sessions.status(req));
 if(path==='/api/vault'&&req.method==='POST'){
  rateLimit();const v=z.object({action:z.enum(['initialize','unlock','lock']),passphrase:z.string().min(12).max(1024).optional()}).strict().parse(await body(req));
  if(v.action==='lock'){sessions.require(req);store.lock();sessions.clear();sessions.logout(req,res);return send(res,store.vaultStatus());}
  if(!v.passphrase)throw new AppError(400,'Passphrase required (at least 12 characters).');
  if(v.action==='initialize')store.unlock(v.passphrase,true);else if(store.key)store.verifyPassphrase(v.passphrase);else store.unlock(v.passphrase);
  sessions.issue(req,res);return send(res,store.vaultStatus());
 }
 const session=sessions.require(req);
 return await withIdentity(session.principal,()=>sessions.valid(session),async()=>{
 if(path==='/api/session/logout'&&req.method==='POST'){sessions.logout(req,res);return send(res,{authenticated:false});}
 if(path==='/api/notifications'&&req.method==='GET')return send(res,notifications.list(notificationQuery.parse(Object.fromEntries(url.searchParams)).after));
 if(path==='/api/notifications/test'&&req.method==='POST'){await body(req);return send(res,notifications.test());}
 if(path==='/api/proposals'&&req.method==='GET'){const q=z.object({connection:z.string().min(1).max(300),issue:z.string().min(1).max(200)}).parse(Object.fromEntries(url.searchParams));const version=store.getWorkSession(q.connection,q.issue)?.plans.at(-1)?.version;return send(res,{proposals:version?store.investigations(q.connection,q.issue).filter(r=>r.planVersion===version).flatMap(r=>r.proposals??[]):[]});}
 if(path==='/api/agent/state'&&req.method==='GET')return send(res,await agentState());
 if(path==='/api/agent/feed'&&req.method==='GET'){
  const after=Number(req.headers['last-event-id']??url.searchParams.get('after')??NaN);
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
  const entry=(e:FeedEntry)=>res.write(`id: ${e.seq}\nevent: entry\ndata: ${JSON.stringify(e)}\n\n`);
  const state=()=>void agentState().then(v=>res.write(`event: state\ndata: ${JSON.stringify(v)}\n\n`)).catch(()=>{});
  res.write('retry: 3000\n\n');for(const e of agentFeed.since(Number.isFinite(after)?after:undefined))entry(e);state();
  const heartbeat=setInterval(()=>{if(!sessions.valid(session)||!store.key){res.end();return;}res.write(': heartbeat\n\n');},20000);
  agentFeed.on('entry',entry);agentFeed.on('state',state);
  res.on('close',()=>{clearInterval(heartbeat);agentFeed.off('entry',entry);agentFeed.off('state',state);});
  return;
 }
 const agentMessage=path.match(/^\/api\/agent\/runs\/([a-f0-9-]+)\/message$/);
 const requestInput=z.object({connection:z.string().min(1).max(300),issueId:z.string().min(1).max(300)});
 if(path==='/api/agent/implement'&&req.method==='POST'){
  const v=requestInput.strict().parse(await body(req));
  const w=store.getWorkSession(v.connection,v.issueId);if(!w?.approval)throw new AppError(409,'Approve the plan before asking the agent to implement it.');
  const plan=w.plans.find(p=>p.version===w.approval!.version);if(!plan)throw new AppError(409,'The approved plan version no longer exists.');
  const from=(plan.runId&&store.investigations(v.connection,v.issueId).find(r=>r.id===plan.runId&&r.sessionId))??store.investigations(v.connection,v.issueId).find(r=>r.sessionId);
  if(!from)throw new AppError(409,'No agent session exists for this request. Investigate it first.');
  const text=['The engineer approved plan version '+plan.version+'. Implement it now.','Work in a git worktree of each repository you change, starting from the current default branch. Make the changes, then validate them as far as possible: lint, template, dry-run, tests. Fix what fails.','When a repository is ready, call propose_change with its folder and the commit you started from. Then call submit_result with outcome plan, and a report of the changes and of the validation you ran. If the plan cannot be implemented as written, explain why with needs_input.','Approved plan:','',plan.text].join('\n');
  return send(res,{run:await startRun(v.connection,v.issueId,{kind:'implement',runId:from.id,planVersion:plan.version,prompt:text,by:session.principal.name})});
 }
 if(path==='/api/agent/restart'&&req.method==='POST'){
  const v=requestInput.extend({planVersion:z.number().int().min(1),text:z.string().trim().max(16000).optional()}).strict().parse(await body(req));
  return send(res,{run:await startRun(v.connection,v.issueId,{kind:'restart',planVersion:v.planVersion,text:v.text||undefined,by:session.principal.name})});
 }
 if(path==='/api/agent/start-over'&&req.method==='POST'){
  const v=requestInput.extend({text:z.string().trim().max(16000).optional()}).strict().parse(await body(req));
  return send(res,{run:await startRun(v.connection,v.issueId,{kind:'over',text:v.text||undefined,by:session.principal.name})});
 }
 const agentContinue=path.match(/^\/api\/agent\/runs\/([0-9a-f-]{36})\/continue$/);
 if(agentContinue&&req.method==='POST'){const v=z.object({text:z.string().trim().min(1).max(16000),kind:z.enum(['continue','recheck']).optional()}).strict().parse(await body(req));return send(res,await continueRun(agentContinue[1],v.text,session.principal.name,v.kind));}
 if(agentMessage&&req.method==='POST'){const v=z.object({text:z.string().trim().min(1).max(4000),replyTo:z.string().uuid().optional()}).strict().parse(await body(req));return send(res,claude.message(agentMessage[1],v,session.principal.name));}
 const agentRunStop=path.match(/^\/api\/agent\/runs\/([a-f0-9-]+)\/stop$/);
 if(agentRunStop&&req.method==='POST'){await body(req);claude.cancel(agentRunStop[1]);return send(res,await agentState());}
 if(path==='/api/agent/halt'&&req.method==='POST'){await body(req);setAgentHalted(store,true);const stopped=claude.cancelAll();stopTunnels();await killAllSandbox();recordDiagnostic(store,{tool:'Agent',operation:'Agent stopped (Stop all)',status:'cancelled',durationMs:0,output:`Runs stopped: ${stopped}\nCommands and tunnels stopped. New runs blocked until resume.`});return send(res,await agentState());}
 if(path==='/api/agent/queue'&&req.method==='GET')return send(res,{entries:agentQueue.view(),counts:agentQueue.counts()});
 const queueAction=path.match(/^\/api\/agent\/queue\/(retry|discard)$/);
 if(queueAction&&req.method==='POST'){const {scope}=z.object({scope:z.string().min(3).max(400)}).strict().parse(await body(req));if(queueAction[1]==='retry')agentQueue.retry(scope);else agentQueue.discard(scope);return send(res,{entries:agentQueue.view(),counts:agentQueue.counts()});}
 if(path==='/api/agent/resume'&&req.method==='POST'){await body(req);setAgentHalted(store,false);recordDiagnostic(store,{tool:'Agent',operation:'Agent resumed',status:'ok',durationMs:0,output:'New runs allowed.'});return send(res,await agentState());}
 if(path==='/api/chatgpt'&&req.method==='GET')return send(res,chatGPT(store).status());
 if(path==='/api/chatgpt/models'&&req.method==='GET')return send(res,{models:await chatGPT(store).models()});
 if(path==='/api/chatgpt/start'&&req.method==='POST'){rateLimit();const v=z.object({account:z.string().max(200).optional()}).strict().parse(await body(req));return send(res,chatGPT(store).begin(origin,v.account));}
 if(path==='/api/chatgpt/cancel'&&req.method==='POST'){await body(req);return send(res,chatGPT(store).cancel());}
 if(['/api/chatgpt/select','/api/chatgpt/disconnect'].includes(path)&&req.method==='POST'){const v=z.object({account:z.string().max(200)}).strict().parse(await body(req));return send(res,path.endsWith('/select')?chatGPT(store).select(v.account):await chatGPT(store).disconnect(v.account));}
 if(path==='/api/dashboard'&&req.method==='GET'){const days=z.coerce.number().refine(n=>[7,14,30].includes(n)).parse(url.searchParams.get('days')??7);const interval=z.enum(['hour','day']).parse(url.searchParams.get('interval')??'day');return send(res,dashboard(store,aiOverview(store,claude),days,interval));}
 if(path==='/api/logs'&&req.method==='GET'){const q=z.object({tool:z.enum(logTools).optional(),status:z.enum(['ok','error','cancelled']).optional(),query:z.string().trim().max(200).optional(),time:z.enum(['hour','day','week']).optional(),duration:z.enum(['fast','normal','slow']).optional(),from:z.string().max(40).optional(),to:z.string().max(40).optional(),zone:z.string().max(100).optional(),before:z.coerce.number().int().positive().optional()}).parse(Object.fromEntries(url.searchParams));return send(res,readLogs(store,q));}
 if(path==='/api/ai/dispositions'&&req.method==='POST'){updateDispositions(store,aiOverview(store,claude),dispositionInput.parse(await body(req)));return send(res,aiOverview(store,claude));}
 if(path==='/api/ai/activity'&&req.method==='GET')return send(res,aiOverview(store,claude));

 if(path==='/api/ignore-rules'&&req.method==='GET'){if(!store.key)throw new AppError(423,'Unlock the Vault first.');return send(res,{rules:rules(store)});}
 const removeRule=path.match(/^\/api\/ignore-rules\/([a-f0-9-]+)\/remove$/);
 if(removeRule&&req.method==='POST'){await body(req);removeIgnore(store,removeRule[1]);return send(res,{rules:rules(store)});}
 const control=path.match(/^\/api\/(youtrack\/issues|alerts|slack)\/([a-zA-Z0-9_-]+)\/(handling|ignore)$/);
 if(control&&req.method==='POST'){
  const source=control[1]==='alerts'?alerts:control[1]==='slack'?slack:youtrack,payload=await body(req);
  const decision=control[3]==='handling'?handlingInput.parse(payload):undefined;
  // Allow stopping work when the upstream is down.
  if(decision?.connection&&['human','refused','done'].includes(decision.mode)){
   const w=store.getWorkSession(decision.connection,control[2]);if(!w)throw new AppError(404,'Work session not found. Refresh the source first.');
   const issue={id:w.issueId,connection:w.connection,key:w.sourceKey??w.issueId,updated:w.sourceUpdated,sourceFingerprint:w.sourceFingerprint,title:'',description:'',resolved:false,status:'',severity:'',assignee:'',project:'',fields:{},url:''};
   setHandling(store,issue,decision);claude.cancelSource(issue.connection,issue.id);return send(res,{session:store.workSession(issue)});
  }
  const issue=await source.issue(control[2]);if(decision)setHandling(store,issue,decision);else addIgnore(store,issue,ignoreInput.parse(payload));
  claude.cancelSource(issue.connection,issue.id);
  if(control[3]==='ignore')for(const run of store.db.prepare('SELECT id FROM investigations').all() as {id:string}[]){const r=store.investigation(run.id);if(r.connection===issue.connection&&r.state==='running')claude.cancelSource(r.connection,r.issueId);}
  return send(res,await source.work(issue.id));
 }

 const incoming=path.match(/^\/api\/(alerts|slack)\/([a-f0-9]{64})\/(changes|investigations|reply)(?:\/(prepare|save|send|reconcile))?$/);
 if(incoming){const [_,kind,id,action,verb]=incoming;const source=kind==='alerts'?alerts:slack;const ref=(kind==='alerts'?'alert:':'slack:')+id;
  if(action==='changes'&&req.method==='GET')return send(res,await changes.list(ref));
  if(action==='changes'&&req.method==='POST')return send(res,await changes.prepare(ref,prepareSchema.parse(await body(req))));
  if(action==='investigations'&&req.method==='GET'){const issue=kind==='alerts'?alerts.source(store.alert(id)):slack.source(slack.getCase(id));return send(res,store.investigations(issue.connection,id).filter(r=>!r.kind||r.kind==='investigation').map(r=>({...claude.status(r.id),events:[],plan:undefined,replyDraft:undefined})));}
  if(action==='reply'&&req.method==='GET')return send(res,replies.get(await source.issue(id)));
  if(action==='reply'&&req.method==='POST'){
   if(verb==='prepare'){await body(req);return send(res,await replies.prepare(ref));}
   if(verb==='reconcile'){await body(req);return send(res,await replies.reconcile(ref));}
   const v=z.object({hash:z.string().length(64),text:z.string().trim().min(1).max(16000).optional()}).strict().parse(await body(req));
   if(verb==='save'){if(!v.text)throw new AppError(400,'Write a reply.');return send(res,await replies.save(ref,v.text,v.hash));}
   if(verb==='send')return send(res,await replies.send(ref,v.hash));
  }
 }
 if(path==='/api/slack'&&req.method==='GET')return send(res,slack.queue());
 if(path==='/api/slack/poll'&&req.method==='POST'){await slack.poll();return send(res,slack.queue());}
 const slackTicket=path.match(/^\/api\/slack\/([a-f0-9]{64})\/ticket\/(prepare|save|approve|reconcile)$/);
 if(slackTicket&&req.method==='POST'){const id=slackTicket[1],action=slackTicket[2];if(action==='reconcile'){await body(req);return send(res,await slackTickets.reconcile(id));}if(action==='prepare'){const v=z.object({projectId:z.string().min(1).max(100)}).strict().parse(await body(req));return send(res,await slackTickets.prepare(id,v.projectId));}if(action==='save')return send(res,await slackTickets.save(id,alertDraftInput.parse(await body(req))));const v=z.object({hash:z.string().length(64)}).strict().parse(await body(req));return send(res,await slackTickets.approve(id,v.hash));}
 const slackMatch=path.match(/^\/api\/slack\/([a-f0-9]{64})(?:\/(analyze|action))?$/);
 if(slackMatch){const id=slackMatch[1],action=slackMatch[2];if(!action&&req.method==='GET')return send(res,await slack.work(id));if(req.method==='POST'){if(action==='analyze'){const v=z.object({revision:z.number().int(),sourceUpdated:z.number()}).strict().parse(await body(req));return send(res,await claude.start(id,v,slack),202);}if(action==='action'){const v=z.object({action:z.enum(['note','draft','plan','approve','unapprove','revise','delete-note']),revision:z.number().int(),sourceUpdated:z.number(),text:z.string().max(16000).optional(),annotation:z.object({start:z.number().int().min(0).max(64000).optional(),end:z.number().int().min(0).max(64000).optional(),version:z.number().int().positive(),quote:z.string().max(3000),markdown:z.string().max(12000).optional(),kind:z.enum(['comment','recheck','remove'])}).strict().optional()}).strict().parse(await body(req));return send(res,await slack.action(id,v));}}}

 if(path==='/api/alerts'&&req.method==='GET')return send(res,alerts.queue(claude));
 if(path==='/api/alerts/poll'&&req.method==='POST'){await alerts.poll();return send(res,alerts.queue(claude));}
 if(path==='/api/youtrack/projects'&&req.method==='GET')return send(res,await youtrack.projects());
 const handoff=path.match(/^\/api\/alerts\/([a-f0-9]{64})\/handoff\/(preview|carry)$/);
 if(handoff&&req.method==='POST'){
  if(handoff[2]==='preview')return send(res,await handoffs.preview(handoff[1]));
  const input=z.object({hash:z.string().length(64)}).strict().parse(await body(req));return send(res,await handoffs.carry(handoff[1],input.hash));
 }
 const ticketCreation=path.match(/^\/api\/alerts\/([a-f0-9]{64})\/ticket\/(prepare|save|approve|reconcile)$/);
 if(ticketCreation&&req.method==='POST'){
  const id=ticketCreation[1],action=ticketCreation[2];
  if(action==='reconcile')return send(res,await alertTickets.reconcile(id));
  if(action==='prepare'){const v=z.object({projectId:z.string().min(1).max(100)}).strict().parse(await body(req));return send(res,await alertTickets.prepare(id,v.projectId));}
  if(action==='save')return send(res,await alertTickets.save(id,alertDraftInput.parse(await body(req))));
  const v=z.object({hash:z.string().length(64)}).strict().parse(await body(req));return send(res,await alertTickets.approve(id,v.hash));
 }
 const alertMatch=path.match(/^\/api\/alerts\/([a-f0-9]{64})(?:\/(analyze|action|link))?$/);
 if(alertMatch){
  const id=alertMatch[1],action=alertMatch[2];
  if(!action&&req.method==='GET')return send(res,await alerts.work(id));
  if(req.method==='POST'){
   if(action==='analyze'){const v=z.object({revision:z.number().int(),sourceUpdated:z.number()}).strict().parse(await body(req));return send(res,await alerts.analyze(id,v,claude),202);}
   if(action==='action'){const v=z.object({action:z.enum(['note','draft','plan','approve','unapprove','revise','delete-note']),annotation:z.object({start:z.number().int().min(0).max(64000).optional(),end:z.number().int().min(0).max(64000).optional(),version:z.number().int().positive(),quote:z.string().max(3000),markdown:z.string().max(12000).optional(),kind:z.enum(['comment','recheck','remove'])}).strict().optional(),revision:z.number().int(),sourceUpdated:z.number(),text:z.string().max(16000).optional()}).strict().parse(await body(req));return send(res,await alerts.action(id,v));}
   if(action==='link'){const v=z.object({ticketId:z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/)}).strict().parse(await body(req));return send(res,await alerts.link(id,v.ticketId,youtrack));}
  }
 }
 const changesMatch=path.match(/^\/api\/youtrack\/issues\/([a-zA-Z0-9_-]+)\/changes$/);
 if(changesMatch&&req.method==='GET')return send(res,await changes.list(changesMatch[1]));
 if(changesMatch&&req.method==='POST')return send(res,await changes.prepare(changesMatch[1],prepareSchema.parse(await body(req))));
 const resolutionMatch=path.match(/^\/api\/changes\/([a-f0-9-]+)\/resolution\/(prepare|save|post|options|review-close|close|reconcile)$/);
 if(resolutionMatch&&req.method==='POST'){
  const id=resolutionMatch[1],action=resolutionMatch[2];
  if(action==='prepare')return send(res,await resolutions.prepare(id));
  if(action==='options')return send(res,await resolutions.options(id));
  if(action==='reconcile')return send(res,await resolutions.reconcileResolution(id));
  if(action==='review-close'){const v=z.object({fieldId:z.string().min(1).max(200),valueId:z.string().min(1).max(200)}).strict().parse(await body(req));return send(res,await resolutions.reviewClose(id,v.fieldId,v.valueId));}
  if(action==='save'){const v=z.object({hash:z.string().length(64),text:z.string().trim().min(1).max(16000)}).strict().parse(await body(req));return send(res,await resolutions.save(id,v.text,v.hash));}
  const v=z.object({hash:z.string().length(64)}).strict().parse(await body(req));
  return send(res,action==='post'?await resolutions.post(id,v.hash):await resolutions.close(id,v.hash));
 }
 const pipelineMatch=path.match(/^\/api\/changes\/([a-f0-9-]+)\/(track|diagnose|push-fix|reconcile-fix)$/);
 if(pipelineMatch&&req.method==='POST'){
  const id=pipelineMatch[1],action=pipelineMatch[2];
  if(action==='track')return send(res,await pipelines.track(id));
  if(action==='diagnose'){const input=z.object({feedback:z.string().max(4000).default('')}).strict().parse(await body(req));return send(res,await pipelines.diagnose(id,input.feedback));}
  const input=z.object({fixId:z.string().uuid(),hash:z.string().length(64).optional()}).strict().parse(await body(req));
  if(action==='push-fix'){if(!input.hash)throw new AppError(400,'Fix approval hash required.');return send(res,await pipelines.push(id,input.fixId,input.hash));}
  return send(res,await pipelines.reconcileFix(id,input.fixId));
 }
 const changeMatch=path.match(/^\/api\/changes\/([a-f0-9-]+)\/(review|approve|reconcile)$/);
 if(changeMatch&&req.method==='POST'){
  if(changeMatch[2]==='review')return send(res,await changes.review(changeMatch[1],reviewSchema.parse(await body(req))));
  if(changeMatch[2]==='approve'){const input=z.object({reviewHash:z.string().length(64)}).strict().parse(await body(req));return send(res,await changes.approve(changeMatch[1],input.reviewHash));}
  return send(res,await changes.reconcile(changeMatch[1]));
 }
 const analysisMatch=path.match(/^\/api\/analysis\/([a-f0-9-]+)(\/cancel)?$/);
 if(analysisMatch&&req.method==='GET'&&!analysisMatch[2])return send(res,claude.status(analysisMatch[1]));
 if(analysisMatch&&req.method==='POST'&&analysisMatch[2])return send(res,claude.cancel(analysisMatch[1]));
 const historyMatch=path.match(/^\/api\/youtrack\/issues\/([a-zA-Z0-9_-]+)\/investigations$/);if(historyMatch&&req.method==='GET')return send(res,await claude.history(historyMatch[1]));
 const analyzeMatch=path.match(/^\/api\/youtrack\/issues\/([a-zA-Z0-9_-]+)\/analyze$/);
 if(analyzeMatch&&req.method==='POST'){const input=z.object({revision:z.number().int(),sourceUpdated:z.number()}).strict().parse(await body(req));return send(res,await claude.start(analyzeMatch[1],input),202);}
 if(path==='/api/youtrack/issues'&&req.method==='GET'){const offset=z.coerce.number().int().min(0).max(100000).parse(url.searchParams.get('offset')??0);return send(res,await youtrack.list(offset,true));}
 const ytMatch=path.match(/^\/api\/youtrack\/issues\/([a-zA-Z0-9_-]+)(\/action)?$/);
 if(ytMatch&&req.method==='GET'&&!ytMatch[2])return send(res,await youtrack.work(ytMatch[1]));
 if(ytMatch&&req.method==='POST'&&ytMatch[2]){const input=z.object({action:z.enum(['note','draft','plan','approve','unapprove','revise','delete-note']),revision:z.number().int(),sourceUpdated:z.number(),text:z.string().max(16000).optional(),annotation:z.object({start:z.number().int().min(0).max(64000).optional(),end:z.number().int().min(0).max(64000).optional(),version:z.number().int().positive(),quote:z.string().max(3000),markdown:z.string().max(12000).optional(),kind:z.enum(['comment','recheck','remove'])}).strict().optional()}).strict().parse(await body(req));return send(res,await youtrack.action(ytMatch[1],input));}
 if(path==='/api/state'&&req.method==='GET'){const s=store.snapshot();return send(res,{...s,tickets:[],runtime:{...s.runtime,mode:'Live workspace',deployment:runtime.mode,workspaceId:workspaceIdentity(store).workspaceId,principal:session.principal}});}
 if(path==='/api/config'&&req.method==='PUT'){const data=z.object({config:z.unknown(),revision:z.number().int()}).strict().parse(await body(req));return send(res,store.config(data.config,data.revision));}
 if(path==='/api/config/export'&&req.method==='GET'){const state=store.snapshot();return send(res,{format:1,config:state.config});}
 if(path==='/api/gitlab/projects'&&req.method==='GET'){const {search}=z.object({search:z.string().trim().max(200).optional()}).strict().parse(Object.fromEntries(url.searchParams));return send(res,{projects:await gitLabProjects(store,transport,search??'')});}
 if(path==='/api/toolbox/kubeconfig/merge'&&req.method==='POST'){const {files}=z.object({files:z.array(z.object({name:z.string().trim().min(1).max(200),content:z.string().min(1).max(1_048_576)}).strict()).min(1).max(500)}).strict().parse(await body(req,kubeconfigBodyLimit));return send(res,await mergeKubeconfigs(files));}
 if(path==='/api/toolbox/contexts'&&req.method==='POST'){const {kubeconfig}=z.object({kubeconfig:z.string().min(1).max(maxKubeconfigBytes)}).strict().parse(await body(req,kubeconfigBodyLimit));return send(res,{contexts:await kubeconfigContexts(kubeconfig)});}
 // Preview with unsaved settings. Nothing is stored: saving the Toolbox credential generates again with the saved settings.
 if(path==='/api/toolbox/generate'&&req.method==='POST'){const v=z.object({kubeconfig:z.string().min(1).max(maxKubeconfigBytes),contexts:z.array(z.string().min(1).max(253)).min(1).max(100),settings:toolboxSettingsSchema}).strict().parse(await body(req,kubeconfigBodyLimit));return send(res,await generateToolboxSetup(v.kubeconfig,v.contexts,v.settings));}
 if(path==='/api/prometheus/sources'&&req.method==='GET'){const sources=await PrometheusSources.create(store,store.snapshot().config,transport);return send(res,sources.describe());}
 if(path==='/api/prometheus/test'&&req.method==='POST'){
  const {id}=z.object({id:z.string().max(16)}).strict().parse(await body(req)),config=store.snapshot().config,server=config.prometheusSources.find(s=>s.id===id);
  if(!server)throw new AppError(404,'Save the server first, then test it.');
  const sources=await PrometheusSources.create(store,{...config,connections:{...config.connections,Prometheus:{...config.connections.Prometheus,enabled:true},Grafana:{...config.connections.Grafana,enabled:false}},prometheusSources:[server]},transport);
  try{
   if(!sources.names().includes(server.name))return send(res,{ok:false,detail:'Enable Toolbox and its port forwarding in Settings → Connections → Toolbox, then save.'});
   const v=await sources.buildInfo(server.name,AbortSignal.timeout(30000)) as {data?:{version?:string}};
   const version=v.data?.version?`Prometheus ${v.data.version}`:'Prometheus';
   return send(res,{ok:true,detail:server.kind==='url'?`${version} responds at ${server.endpoint}.`:`${version} responds through a tunnel to ${server.target} in ${server.context}/${server.namespace}.`});
  }catch(e){return send(res,{ok:false,detail:e instanceof AppError?e.message:'The query failed.'});}
  finally{sources.close();}
 }
 if(path==='/api/toolbox/status'&&req.method==='GET'){const files=toolboxFiles(store),c=store.snapshot().config;if(!files)return send(res,{source:c.connections.Toolbox.path?'path':'none'});if(files.v===1)return send(res,{source:'custom'});return send(res,{source:'generated',contexts:files.contexts,generatedAt:files.generatedAt,stale:setupHash(c.toolbox,files.contexts.map(x=>x.name))!==files.settingsHash});}
 if(path==='/api/toolbox/regenerate'&&req.method==='POST'){await body(req);const files=toolboxFiles(store);if(files?.v!==2)throw new AppError(409,'Save a kubeconfig and select contexts first.');const settings=store.snapshot().config.toolbox,names=files.contexts.map(x=>x.name),setup=await generateToolboxSetup(files.kubeconfig,names,settings);store.credential('Toolbox',toolboxStoredValue(setup,files.kubeconfig,setupHash(settings,names)));return send(res,{contexts:setup.contexts.map(x=>({name:x.name,namespaces:x.namespaces.length,excluded:x.excluded}))});}
 if(path==='/api/connection/check'&&req.method==='POST'){const {name,config}=z.object({name:z.enum(connectionNames),config:z.unknown().optional()}).strict().parse(await body(req));if(config!==undefined){const result=await testConnection(name,configSchema.parse(config),serviceProbe(store));return send(res,{checks:[{label:`${name} (unsaved settings)`,ok:result.ok,detail:result.detail}],draft:true});}const started=Date.now();
  // Saved settings: run a live check, and record its result as the connection's health.
  const savedCheck=async():Promise<{checks:{label:string;ok:boolean;detail:string}[];liveTest:boolean}>=>{if(name==='Model')return (await checkModelConnection(store,transport));if(name==='Slack'){await slack.poll();return ({checks:[{label:'Slack read access',ok:true,detail:'Read the configured channel. Thread permissions are checked when a request is opened.'}],liveTest:true});}if(name==='GitLab')return (await checkGitLabConnection(store,transport));if(name==='Alertmanager'){await alerts.poll();return ({checks:[{label:'Alertmanager read access',ok:true,detail:'Poll completed. No tickets or silences created.'}],liveTest:true});}if(name==='YouTrack'){const result=await youtrack.list(0);return ({checks:[{label:'YouTrack read access',ok:true,detail:`Read ${result.issues.length} issues from the configured query. No changes sent.`}],liveTest:true});}const result=await testConnection(name,store.snapshot().config,serviceProbe(store));return {checks:[{label:`${name} connection`,ok:result.ok,detail:result.detail}],liveTest:true};};
  try{const result=await savedCheck();const failed=result.checks.find(c=>!c.ok);recordHealthProbe(store,name,{ok:!failed,detail:(failed??result.checks[0])?.detail??''},Date.now()-started);return send(res,result);}
  catch(e){recordHealthProbe(store,name,{ok:false,detail:e instanceof AppError?e.message:'Connection test failed.'},Date.now()-started);throw e;}}
 if(path==='/api/health'&&req.method==='GET')return send(res,{tools:toolHealth(store)});
 if(path==='/api/credential'&&req.method==='POST'){const v=credentialInput.parse(await body(req,kubeconfigBodyLimit));
  // A Toolbox credential stores the kubeconfig with a configuration generated from the saved Toolbox settings.
  if('toolbox' in v){const settings=store.snapshot().config.toolbox,setup=await generateToolboxSetup(v.toolbox.kubeconfig,v.toolbox.contexts,settings);return send(res,store.credential('Toolbox',toolboxStoredValue(setup,v.toolbox.kubeconfig,setupHash(settings,v.toolbox.contexts))));}
 return send(res,'remove' in v?store.removeCredential(v.name):store.credential(v.name,storedCredential(v)));}
 throw new AppError(404,'Not found');});}
 if(req.method!=='GET'&&req.method!=='HEAD')throw new AppError(405,'Method not allowed');
 const file=path==='/'?resolve('dist/index.html'):resolve('dist','.'+decodeURIComponent(path));const rel=relative(resolve('dist'),file);if(rel.startsWith('..')||isAbsolute(rel))throw new AppError(403,'Invalid path');const contents=await readFile(file).catch(()=>{throw new AppError(404,'Not found. Run npm run build first.');});res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'} as Record<string,string>)[extname(file)]??'application/octet-stream'});res.end(req.method==='HEAD'?undefined:contents);
 }catch(e){if(req.url?.startsWith('/api/')&&!req.url.startsWith('/api/logs'))recordDiagnostic(store,{tool:'App',operation:(req.method??'GET')+' '+req.url.split('?')[0],status:'error',durationMs:0,output:e instanceof AppError?e.message:'Request validation or processing failed.'});if(e instanceof z.ZodError)return send(res,{error:e.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')},400);send(res,{error:e instanceof AppError?e.message:'The operation failed. No credentials were logged.',...(e instanceof AppError&&e.code?{code:e.code}:{})},e instanceof AppError?e.status:500);}});
server.listen(port,runtime.bindHost,()=>{console.log(`Support\nOpen: ${origin}\nDeployment: ${runtime.mode}; browser authentication required. Approved GitLab branches and reviewed draft merge requests available. Cluster writes disabled.`)});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{sessions.clear();stopTunnels();void killAllSandbox();clearInterval(notificationTimer);clearInterval(slackTimer);clearInterval(queueTimer);clearInterval(intakeTimer);clearInterval(alertTimer);clearInterval(healthTimer);health.stop();server.close(()=>{store.close();process.exit(0)});});

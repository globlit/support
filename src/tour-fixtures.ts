import type {AIOverview} from './ai-model';
import type {DashboardData} from './dashboard-model';
import {defaults,type Snapshot,type LiveDetail,type AnalysisRun,type ChangeSet,type AlertDetail,type SourceIssue} from './model';
import type {Route} from './navigation';
import type {TourScene} from './tour-journey';
import type {WorkspacePreview} from './WorkspaceRuntime';

const at='2026-11-08T09:00:00.000Z',later='2026-11-08T09:02:00.000Z',updated=Date.parse(at);
const plan='## Add the missing runbook\n\n1. Update `docs/runbook.md` in **platform/service-demo**.\n2. Document how to check service health in development.\n3. Validate Markdown and run the project pipeline.\n\n### Verification\n- [ ] Commands target the development environment.\n- [ ] Documentation pipeline passes.\n\n### Rollback\nRevert the documentation commit if any instructions are incorrect.';
const revised=plan.replace('Document how to check service health in development.','Document the development health endpoint, the exact `curl --fail` command and the expected HTTP 200 response.');
const source:SourceIssue={id:'tour-issue',connection:'tour-youtrack',key:'EXAMPLE-1',title:'Add a service runbook',project:'Support example',description:'Our service runbook only contains a placeholder. Please document how to check its health.\n\n**Repository:** `platform/service-demo`\n\n**Environment:** Development',comments:[{id:'tour-comment',updated,text:'Please include the endpoint and the expected healthy response.'}],sourceFingerprint:'tour-source-v1',updated,resolved:false,status:'Submitted',severity:'Normal',assignee:'Support engineer',fields:{},url:'#'};
const run:AnalysisRun={id:'tour-run',issueId:source.id,connection:source.connection,state:'ready',model:'Configured model',sourceUpdated:updated,sourceFingerprint:source.sourceFingerprint,startedAt:at,finishedAt:later,planVersion:1,plan,events:[{at,text:'Reading the current request and latest comments.'},{at,text:'Checking the latest project pipelines.',callId:'tour-check',tool:'gitlab_pipelines',input:JSON.stringify({project:'platform/service-demo'}),result:JSON.stringify([{id:80,status:'success',ref:'main'}]),conclusion:'The latest main pipeline passed. The request reports missing runbook instructions; propose a documentation update and verify the file during branch preparation.',status:'complete'},{at:later,text:'Plan prepared for engineer review.'}]};
function change(detail:LiveDetail):ChangeSet{return {id:'tour-change',connection:source.connection,issueId:source.id,planVersion:2,planApproval:'tour-approval',sessionRevision:detail.session.revision,configRevision:1,sourceUpdated:updated,endpoint:'https://gitlab.example.invalid',repositoryPath:'/workspace/repos/service-demo',project:'platform/service-demo',target:'main',base:'a'.repeat(40),branch:'support/example-runbook',head:'b'.repeat(40),files:[{path:'docs/runbook.md',before:'Health check: TODO',after:'## Development health check\nRun `curl --fail https://service.dev.example/health`.\nExpected: HTTP 200, status: ok.'}],diffs:[{path:'docs/runbook.md',diff:'--- a/docs/runbook.md\n+++ b/docs/runbook.md\n@@ -1 +1,3 @@\n-Health check: TODO\n+## Development health check\n+Run `curl --fail https://service.dev.example/health`.\n+Expected: HTTP 200, status: ok.'}],title:'Add the service development runbook',description:'Documents the health endpoint, expected response and first checks.\n\n### Validation\n- [x] Markdown checked\n- [x] Development target confirmed',state:'review',reviewHash:'tour-review',message:'Branch prepared. Review every file and the merge request message.',createdAt:later,updatedAt:later};}
export function createTourFixture(scene:TourScene){
 const snapshot:Snapshot={config:structuredClone(defaults),configRevision:1,vault:{initialized:true,unlocked:true,credentials:['YouTrack','GitLab']},runtime:{mode:'Tour example',platform:'linux',liveExecution:false}};
 snapshot.config.connections.YouTrack={enabled:true,endpoint:'https://youtrack.example.invalid',scope:'project: EXAMPLE',path:''};snapshot.config.connections.Model.enabled=true;
 snapshot.config.connections.Alertmanager={enabled:true,endpoint:'https://alerts.example.invalid',scope:'',path:''};snapshot.config.connections.Slack={enabled:true,endpoint:'https://slack.com/api',scope:'support-infra',path:''};
 const detail:LiveDetail={issue:structuredClone(source),session:{connection:source.connection,issueId:source.id,sourceKey:source.key,sourceUpdated:updated,sourceFingerprint:source.sourceFingerprint,revision:1,updatedAt:later,plans:[],notes:[],draft:'',approval:null}};
 const prepared=!['queue','list','board','request','ownership','investigate','alert-intake','slack-intake','ignore'].includes(scene);
 if(prepared){detail.session.plans=[{version:1,text:plan,at}];detail.session.analysis={model:run.model!,events:run.events};}
 if(['approve','diff','mr','pipeline','reply'].includes(scene))detail.session.plans.push({version:2,text:revised,at:later});
 if(scene==='comment'){
  detail.session.pendingRevision=true;
  detail.session.notes=[{id:'tour-note',at:later,text:'Revision requested: [Plan v1]\nSelected text:\ncheck service health\n\nRequested change:\nInclude the exact endpoint and a healthy response example.',annotation:{version:1,quote:'check service health',markdown:'check service health',kind:'comment'}}];
 }
 if(['diff','mr','pipeline','reply'].includes(scene))detail.session.approval={version:2,sourceUpdated:updated,configRevision:1,actor:'Support engineer',at:later};
 const changes:ChangeSet[]=['diff','mr','pipeline','reply'].includes(scene)?[change(detail)]:[];
 if(['pipeline','reply'].includes(scene))Object.assign(changes[0],{state:'created',mr:{iid:42,url:'#'},tracking:{checkedAt:later,state:'merged',mergeStatus:'merged',draft:false,head:'b'.repeat(40),targetHead:'c'.repeat(40),pipeline:{id:81,sha:'c'.repeat(40),status:'success'},jobs:[{id:82,name:'markdown-lint',stage:'test',status:'success',allow_failure:false}],jobsLimited:false}});
 if(scene==='reply')changes[0].resolution={id:'tour-resolution',text:'The development runbook is now available in `docs/runbook.md`. It includes the health endpoint, expected response and first troubleshooting steps.\n\nMerge request **!42** was merged and the documentation pipeline passed.',hash:'tour-resolution-hash',revision:1,state:'draft',sourceUpdated:updated,sessionRevision:1,configRevision:1,proof:{mergeSha:'c'.repeat(40),sourceSha:'b'.repeat(40),mergedAt:later,pipelineId:81,pipelineSha:'c'.repeat(40),target:'main'},message:'Summary ready for review. Nothing has been posted.'};
 const stage=['request','ownership'].includes(scene)?'request':['investigate','results'].includes(scene)?'investigation':['plan','comment','approve'].includes(scene)?'plan':scene==='reply'?'message':'implementation';
 let route:Route=['queue','list','board'].includes(scene)?{page:'youtrack',section:scene==='board'?'board':'list'}:{page:'youtrack',issue:source.id,connection:source.connection,step:stage};
 const incoming=['alert-intake','slack-intake','ignore'].includes(scene),slack=scene==='slack-intake';
 let alert:AlertDetail|undefined;
 if(incoming){
  const id='a'.repeat(64),connection=slack?'slack:tour':'alertmanager:tour';
  detail.issue={...detail.issue,id,connection,key:slack?'SLACK-example':'ALERT-example',title:slack?'Can you check the deployment?':'ServiceDown',status:slack?'Slack thread':'Firing',severity:'Critical',description:'Can you check the development deployment? Its health endpoint is not responding.',comments:[]};
  detail.session={...detail.session,connection,issueId:id,handling:{mode:'pending',reason:'',revision:1,at,actor:'Support engineer',history:[]}};
  alert={...detail,alert:{id,connection,sourceKind:slack?'slack':'alert',channel:slack?'support-infra':undefined,title:detail.issue.title,severity:'critical',labels:{alertname:'ServiceDown'},members:['eu-west','eu-central'].map(production=>({fingerprint:production,labels:{alertname:'ServiceDown',production,instance:production+'.example'},annotations:{summary:'The health endpoint is not responding.'},startsAt:at,state:'active'})),active:true,suppressed:false,episodes:1,firstSeen:at,lastSeen:later,updated,digest:'tour-alert'}};
  route={page:slack?'slack':'alerts',issue:id,step:'request'};
 }
 if(scene==='ai'||scene==='dashboard')route={page:scene};
 const activeRun=prepared?{...structuredClone(run),planVersion:detail.session.plans.at(-1)!.version,plan:detail.session.plans.at(-1)!.text}:null;
 const sourcePath=incoming?(slack?'/slack':'/alerts'):'/youtrack/issues';
 const activity:AIOverview={workflows:[{id:'tour-workflow',connection:source.connection,issueId:source.id,source:'youtrack',title:source.title,key:source.key,state:'waiting',stage:'Plan approval',reason:'Review the proposed development runbook.',updatedAt:later,latestRun:run.id,runCount:1,repeating:false,quiet:false}],runs:[{id:run.id,connection:source.connection,issueId:source.id,kind:'investigation',state:'completed',model:run.model,startedAt:at,finishedAt:later,updatedAt:later,step:'Plan prepared for review.',checks:1,repeating:false,quiet:false,activity:{start:at,end:later,counts:[1,0,0,2,1,0,0,1,0,1]}}],loadedAt:later,historyLimit:200,agent:{model:run.model!,active:false,step:'Waiting for plan review'}};
 const dashboard:DashboardData={loadedAt:later,interval:'day',checks:1,repeatedRuns:0,runSeconds:120,days:7,timezone:'UTC',sampleLimit:200,retentionDays:30,totalRuns:1,completedRuns:1,failedRuns:0,stoppedRuns:0,activeRuns:0,completionRate:100,medianSeconds:120,workflows:{running:0,waiting:1,blocked:0,stopped:0,completed:0},daily:Array.from({length:7},(_,i)=>({date:`2026-11-0${i+2}`,label:`Nov ${i+2}`,completed:i===6?1:0,failed:0,stopped:0,running:0})),tools:[{name:'GitLab',requests:1,errors:0}],usage:{responses:1,input:340,output:180,cacheRead:0,cacheReadReported:0,cacheWrite:0,webSearches:0,limits:[]},tokenSeries:[{date:'2026-11-08',label:'Nov 8',input:340,output:180,responses:1}],health:['YouTrack','GitLab','Model'].map(name=>({name:name as 'YouTrack'|'GitLab'|'Model',state:'green',label:'Connected',detail:'Example successful service check.',at:later,intervalSeconds:60,timeoutSeconds:10}))};
 const reads:Record<string,unknown>={
  '/ai/activity':activity,
  '/dashboard?days=7&interval=day':dashboard,
  '/youtrack/issues?offset=0':{issues:[source],hasMore:false,offset:0,loadedAt:later,query:'project: EXAMPLE'},
  [sourcePath+'/'+detail.issue.id]:alert??detail,
  [sourcePath+'/'+detail.issue.id+'/changes']:changes,
  '/gitlab/projects':{projects:[{project:'platform/service-demo',name:'service-demo',defaultBranch:'main'}]},
  [sourcePath+'/'+detail.issue.id+'/investigations']:activeRun?[activeRun]:[],
  '/analysis/tour-run':activeRun,
  '/alerts':{cases:alert?[{...alert.alert,session:detail.session}]:[],enabled:true,paused:false,pollSeconds:60,lastSuccess:later,polling:false},
 };
 const preview:WorkspacePreview={route,request:tourReader(reads),intakeEditor:scene==='ignore'?{choice:'ignore',reason:'Planned maintenance · downtime expected',duration:'60',scope:'production',values:['eu-west','eu-central']}:scene==='ownership'?{choice:'human',reason:'Planned maintenance needs manual coordination.'}:undefined};
 return {snapshot,detail,alert,changes,run:activeRun,preview};
}
/** Unknown reads and every write fail closed. No fallback to fetch or workspace APIs. */
export function tourReader(reads:Record<string,unknown>):WorkspacePreview['request']{
 return async <T,>(path:string,method='GET')=>{
  if(method!=='GET'||!Object.hasOwn(reads,path))throw new Error('This action is not available in the tour. No workspace request was sent.');
  return structuredClone(reads[path]) as T;
 };
}

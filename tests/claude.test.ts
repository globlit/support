import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {YouTrack} from '../server/youtrack.js';
import {Claude} from '../server/claude.js';
import {toolboxArgs} from '../server/toolbox.js';
const issue={id:'2-42',idReadable:'INFRA-42',summary:'Diagnose workload',description:'token=never-send-this',updated:1000,resolved:null};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-claude-'));const store=new Store(dir);store.unlock('long test passphrase',true);for(const name of ['Model','YouTrack','GitLab'])store.credential(name,name+'-private-credential');const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,YouTrack:{endpoint:'https://yt.internal',scope:'project: INFRA',path:'',enabled:true},Model:{endpoint:'https://claude.internal',scope:'test-model',path:'',enabled:true},GitLab:{endpoint:'https://gitlab.internal',scope:'',path:'',enabled:true},Prometheus:{endpoint:'https://metrics.internal',scope:'',path:'',enabled:true},Toolbox:{endpoint:'',scope:'dev',path:'/workspace/toolbox.json',enabled:true}}},s.configRevision);let updated=1000;const yt=new YouTrack(store,(async()=>Response.json({...issue,updated})) as typeof fetch);return {store,yt,change(){updated++},done(){store.close();rmSync(dir,{recursive:true,force:true})}}}
const reply=(name:string,input:unknown)=>Response.json({stop_reason:'tool_use',content:[{type:'tool_use',id:'call-'+name,name,input}]});
const final=()=>reply('prepare_plan',{plan:'1. Check rollout\n2. Propose a GitOps fix\n3. Validate health',replyDraft:'Please confirm the target namespace.'});
async function wait(c:Claude,id:string){for(let i=0;i<200;i++){const s=c.status(id);if(s.state!=='running')return s;await new Promise(r=>setTimeout(r,5));}throw new Error('Analysis did not finish')}
test('bounded Claude loop only reads configured tools and saves an unapproved local plan',async()=>{const f=fixture();let turn=0,toolbox=0;try{const c=new Claude(f.store,f.yt,(async(url,opts)=>{const u=new URL(String(url));assert.equal(opts?.redirect,'manual');if(u.hostname==='claude.internal'){assert.equal(u.pathname,'/v1/messages');assert.equal(opts?.method,'POST');const body=JSON.parse(String(opts?.body));assert.equal(body.model,'test-model');assert.ok(!String(opts?.body).includes('never-send-this'));assert.ok(!String(opts?.body).includes('Model-private-credential'));if(turn++===0)return reply('prometheus_query',{query:'up'});if(turn===2)return reply('gitlab_pipelines',{project:'team/service'});if(turn===3)return reply('toolbox_get',{context:'dev',namespace:'apps',resource:'pods'});return final();}assert.equal(opts?.method,'GET');assert.ok(['metrics.internal','gitlab.internal'].includes(u.hostname));return Response.json(u.hostname==='metrics.internal'?{status:'success',data:{result:[]}}:[]);}) as typeof fetch,async(config,input)=>{toolbox++;assert.deepEqual(toolboxArgs(config,input,'/workspace/toolbox.json',['dev']),['--config','/workspace/toolbox.json','kubectl','get','pods','--context','dev','--namespace','apps','-o','json']);return {data:[]}});
 const run=await c.start('2-42',{revision:1,sourceUpdated:1000});assert.equal((await wait(c,run.id)).state,'ready');assert.equal(toolbox,1);let d=await f.yt.work('2-42');assert.equal(d.session.plans.length,1);assert.equal(d.session.approval,null);assert.ok(d.session.analysis?.events.some(e=>e.text.includes('Toolbox')));assert.equal(d.session.draft,'Please confirm the target namespace.');d=await f.yt.action('2-42',{action:'approve',revision:d.session.revision,sourceUpdated:1000});assert.ok(d.session.approval);d=await f.yt.action('2-42',{action:'revise',revision:d.session.revision,sourceUpdated:1000,text:'Use namespace apps'});const second=await c.start('2-42',{revision:d.session.revision,sourceUpdated:1000});assert.equal((await wait(c,second.id)).state,'ready');d=await f.yt.work('2-42');assert.equal(d.session.plans.length,2);assert.equal(d.session.approval,null);assert.equal(d.session.pendingRevision,false);
 }finally{f.done()}});
test('invented write tools fail closed without tool requests or plan persistence',async()=>{const f=fixture();let requests=0;try{const c=new Claude(f.store,f.yt,(async()=>{requests++;return reply('run_shell',{command:'kubectl delete pod app'})}) as typeof fetch);const r=await c.start('2-42',{revision:1,sourceUpdated:1000});const ended=await wait(c,r.id);assert.equal(ended.state,'failed');assert.match(ended.error!,/unavailable tool/);assert.equal(requests,1);assert.equal((await f.yt.work('2-42')).session.plans.length,0);}finally{f.done()}});
for(const mode of ['ticket','feedback','vault','settings','cancel'] as const)test(`discard model results after ${mode} changes`,async()=>{const f=fixture();try{let release!:()=>void;const blocked=new Promise<void>(r=>release=r);const c=new Claude(f.store,f.yt,(async()=>{await blocked;return final()}) as typeof fetch);const run=await c.start('2-42',{revision:1,sourceUpdated:1000});await assert.rejects(c.start('2-42',{revision:1,sourceUpdated:1000}),/Another analysis/);if(mode==='ticket')f.change();if(mode==='feedback')await f.yt.action('2-42',{action:'note',text:'New constraint',revision:1,sourceUpdated:1000});if(mode==='vault')f.store.lock();if(mode==='settings'){const s=f.store.snapshot();f.store.config(s.config,s.configRevision)}if(mode==='cancel')c.cancel(run.id);release();const done=await wait(c,run.id);assert.notEqual(done.state,'ready');const rows=f.store.db.prepare('SELECT value FROM work_sessions').all() as {value:string}[];for(const row of rows)assert.equal(JSON.parse(row.value).plans.length,0);}finally{f.done()}});
test('Toolbox reads refuse secrets, extra flags, unlisted contexts and resources the settings do not enable',()=>{const f=fixture();try{const config=f.store.snapshot().config,path='/workspace/toolbox.json',dev=['dev'];
 for(const args of [{context:'dev',namespace:'apps',resource:'secrets'},{context:'prod',namespace:'apps',resource:'pods'},{context:'dev',namespace:'apps',resource:'pods',flags:['--raw=/']},{context:'dev',namespace:'apps',resource:'configmaps'},{context:'dev',resource:'nodes'},{context:'dev',resource:'pods'}])assert.throws(()=>toolboxArgs(config,args,path,dev),JSON.stringify(args));
 assert.ok(toolboxArgs(config,{context:'dev',namespace:'kube-system',resource:'deployments'},path,dev));
 const open={...config,toolbox:{...config.toolbox,allowConfigMaps:true,allowClusterScoped:true}};
 assert.deepEqual(toolboxArgs(open,{context:'dev',resource:'nodes'},path,dev),['--config',path,'kubectl','get','nodes','--context','dev','-o','json']);
 assert.ok(toolboxArgs(open,{context:'dev',namespace:'apps',resource:'configmaps'},path,dev));
}finally{f.done()}});
test('rejects partial plans, redirects and unbounded tool loops',async()=>{const f=fixture();try{for(const response of [()=>new Response('private upstream error',{status:302,headers:{Location:'https://elsewhere.example'}}),()=>Response.json({stop_reason:'max_tokens',content:[{type:'text',text:'truncated'}]}),()=>reply('prepare_plan',{plan:'missing reply field'})]){const c=new Claude(f.store,f.yt,(async()=>response()) as typeof fetch);const r=await c.start('2-42',{revision:1,sourceUpdated:1000});assert.equal((await wait(c,r.id)).state,'failed');}let calls=0;const c=new Claude(f.store,f.yt,(async(url)=>{calls++;return String(url).includes('claude.internal')?reply('prometheus_query',{query:'up'}):Response.json({data:[]})}) as typeof fetch);const r=await c.start('2-42',{revision:1,sourceUpdated:1000});assert.match((await wait(c,r.id)).error!,/turn limit/);assert.equal(calls,50);assert.equal((await f.yt.work('2-42')).session.plans.length,0);}finally{f.done()}});
test('tool trace survives service recreation, is encrypted, and binds conclusions to calls',async()=>{const f=fixture();let turn=0;try{const c=new Claude(f.store,f.yt,(async(url)=>{if(String(url).includes('claude.internal'))return turn++===0?reply('prometheus_query',{query:'up'}):reply('prepare_plan',{plan:'## Findings\nNo series returned.',replyDraft:'',findings:[{callId:'call-prometheus_query',summary:'No series were returned; service health is not established.'}]});return Response.json({data:{result:[]},token:'hidden-output-value'});}) as typeof fetch);const r=await c.start('2-42',{revision:1,sourceUpdated:1000});await wait(c,r.id);const recreated=new Claude(f.store,f.yt);const saved=recreated.status(r.id),trace=saved.events.find(e=>e.tool);assert.equal(trace?.input,'{"query":"up"}');assert.match(trace?.result??'',/redacted/);assert.ok(!JSON.stringify(saved).includes('hidden-output-value'));assert.match(trace?.conclusion??'',/No series/);assert.equal(saved.planVersion,1);const raw=String(f.store.db.prepare('SELECT value FROM investigations WHERE id=?').get(r.id)!.value);assert.ok(!raw.includes('No series'));const session=String(f.store.db.prepare('SELECT value FROM work_sessions').get()!.value);assert.ok(!session.includes('hidden-output-value'));assert.ok(!session.includes('"result":'));f.store.lock();assert.throws(()=>f.store.investigation(r.id),/Unlock/);}finally{f.done()}});
test('interrupted saved investigation becomes failed and old traces expire',async()=>{const f=fixture();try{const issue=await f.yt.issue('2-42');const run={id:'interrupted',issueId:issue.id,connection:issue.connection,state:'running' as const,events:[],startedAt:new Date().toISOString()};f.store.saveInvestigation(run);const c=new Claude(f.store,f.yt);assert.equal(c.status(run.id).state,'failed');f.store.saveInvestigation({...run,id:'expired',startedAt:'2020-01-01T00:00:00Z'});assert.throws(()=>f.store.investigation('expired'),/expired/);}finally{f.done()}});

test('new investigations receive current priority, description and edited comments; mid-run edits discard the result',async()=>{
 const f=fixture();let raw={...issue,description:'Current requirements',customFields:[{name:'Priority',value:{name:'Critical'}}],comments:[{id:'c1',text:'Corrected comment',updated:1000}]};
 const yt=new YouTrack(f.store,(async()=>Response.json(raw)) as typeof fetch);
 try{
  let changeDuringRun=false;
  const c=new Claude(f.store,yt,(async(_url,opts)=>{
   const body=JSON.parse(String(opts?.body));const context=JSON.parse(body.messages[0].content);
   assert.equal(context.ticket.severity,'Critical');assert.equal(context.ticket.description,'Current requirements');assert.equal(context.ticket.comments[0].text,'Corrected comment');
   if(changeDuringRun)raw.comments[0].text='New detail while investigating';
   return final();
  }) as typeof fetch);
  const d=await yt.work(issue.id),run=await c.start(issue.id,{revision:d.session.revision,sourceUpdated:1000});assert.equal((await wait(c,run.id)).state,'ready');
  let current=await yt.work(issue.id);current=await yt.action(issue.id,{action:'approve',revision:current.session.revision,sourceUpdated:1000});changeDuringRun=true;
  const second=await c.start(issue.id,{revision:current.session.revision,sourceUpdated:1000});const ended=await wait(c,second.id);assert.equal(ended.state,'failed');assert.match(ended.error!,/Source changed/);
  const saved=f.store.getWorkSession(current.issue.connection,issue.id)!;assert.equal(saved.plans.length,1);assert.equal(saved.approval,null);assert.ok(saved.sourceChangedAt);
 }finally{f.done()}
});
test('a revision receives every queued annotation, including more than twenty, except deleted comments',async()=>{
 const f=fixture();try{
  let d=await f.yt.work(issue.id);d=await f.yt.action(issue.id,{action:'plan',text:'Initial plan',revision:d.session.revision,sourceUpdated:1000});
  for(let i=0;i<23;i++)d=await f.yt.action(issue.id,{action:'revise',text:'[Plan v1]\nRequested change:\nComment '+i,revision:d.session.revision,sourceUpdated:1000});
  const deleted=d.session.notes[0].id;d=await f.yt.action(issue.id,{action:'delete-note',text:deleted,revision:d.session.revision,sourceUpdated:1000});
  const c=new Claude(f.store,f.yt,(async(_url,opts)=>{const context=JSON.parse(JSON.parse(String(opts?.body)).messages[0].content);assert.equal(context.notes.length,22);assert.ok(context.notes.every((n:{id:string})=>n.id!==deleted));return final()}) as typeof fetch);
  const run=await c.start(issue.id,{revision:d.session.revision,sourceUpdated:1000});assert.equal((await wait(c,run.id)).state,'ready');assert.equal((await f.yt.work(issue.id)).session.pendingRevision,false);
 }finally{f.done()}
});

test('plan findings are constrained to checks from the current run',async()=>{
 const {planTool}=await import('../server/claude.js');
 const none=planTool().input_schema as any;assert.equal(none.properties.findings.maxItems,0);
 const actual=planTool(['call-real-1','call-real-2']).input_schema as any;
 assert.deepEqual(actual.required,['plan','replyDraft','findings']);
 assert.deepEqual(actual.properties.findings.items.properties.callId.enum,['call-real-1','call-real-2']);
});
test('the agent runs sandbox commands and new read tools, and the kill switch blocks new runs',async()=>{
 const f=fixture();const previous=process.env.SUPPORT_SANDBOX_URL;process.env.SUPPORT_SANDBOX_URL='http://sandbox.internal';let turn=0;const offered:string[][]=[];const seen:string[]=[];
 try{
  const c=new Claude(f.store,f.yt,(async(url,opts)=>{const u=new URL(String(url));
   if(u.hostname==='claude.internal'){const body=JSON.parse(String(opts?.body));offered.push(body.tools.map((t:{name:string})=>t.name));
    if(turn++===0)return reply('run_command',{command:'echo $((1+1))'});
    if(turn===2)return reply('gitlab_file',{project:'team/service',path:'deploy/values.yaml'});
    return final();}
   seen.push(u.hostname+u.pathname);
   if(u.hostname==='sandbox.internal'){if(u.pathname==='/v1/exec'){assert.equal(JSON.parse(String(opts?.body)).command,'echo $((1+1))');return new Response('{"type":"stdout","data":"2\\n"}\n{"type":"exit","code":0,"durationMs":3}\n');}return Response.json({deleted:true});}
   if(u.hostname==='gitlab.internal')return Response.json({file_path:'deploy/values.yaml',encoding:'base64',content:Buffer.from('replicas: 2').toString('base64')});
   return Response.json({});
  }) as typeof fetch,async()=>({data:[]}));
  const run=await c.start('2-42',{revision:1,sourceUpdated:1000});const done=await wait(c,run.id);assert.equal(done.state,'ready',done.error);
  for(const name of ['run_command','toolbox_logs','gitlab_file','gitlab_tree','gitlab_search','gitlab_job_log','gitlab_projects','youtrack_search','youtrack_issue','prometheus_query_range'])assert.ok(offered[0].includes(name),name);
  const events=done.events.filter(e=>e.tool);assert.ok((events[0].result??'').includes('"exitCode":0'));assert.ok((events[0].result??'').includes('"output":"2\\n"'));assert.ok((events[1].result??'').includes('replicas: 2'));
  assert.ok(seen.includes('gitlab.internal/api/v4/projects/team%2Fservice/repository/files/deploy%2Fvalues.yaml'));
  await new Promise(r=>setTimeout(r,20));assert.ok(seen.some(s=>s.startsWith('sandbox.internal/v1/runs/')),'run folder cleaned up');
  const {config,configRevision}=f.store.snapshot();f.store.config({...config,agentCommands:false},configRevision);turn=0;offered.length=0;
  const d=await f.yt.work('2-42');const second=await c.start('2-42',{revision:d.session.revision,sourceUpdated:1000});await wait(c,second.id);assert.ok(!offered[0].includes('run_command'));
  const {setAgentHalted}=await import('../server/agent-feed.js');setAgentHalted(f.store,true);
  const latest=await f.yt.work('2-42');await assert.rejects(c.start('2-42',{revision:latest.session.revision,sourceUpdated:1000}),/agent is stopped/);
  setAgentHalted(f.store,false);
 }finally{if(previous===undefined)delete process.env.SUPPORT_SANDBOX_URL;else process.env.SUPPORT_SANDBOX_URL=previous;f.done()}
});
test('stopped runs record why they stopped, and the result log lists the facts',async()=>{
 const f=fixture();try{
  const {readLogs}=await import('../server/diagnostics.js');
  const hang=(async(url:RequestInfo|URL,opts?:RequestInit)=>new Promise<Response>((_,reject)=>opts?.signal?.addEventListener('abort',()=>reject(opts.signal!.reason)))) as typeof fetch;
  for(const [stop,reason] of [[(c:Claude,id:string)=>c.cancel(id),'Stopped by the engineer (Stop run).'],[(c:Claude)=>c.cancelAll(),'Stopped by the kill switch (Stop all).'],[(c:Claude)=>c.cancelSource(f.store.snapshot().config.connections.YouTrack.endpoint&&(c as unknown as {runs:Map<string,{connection:string}>}).runs.values().next().value!.connection,'2-42'),'Stopped: the handling of this request changed.']] as const){
   const c=new Claude(f.store,f.yt,hang);const d=await f.yt.work('2-42');const run=await c.start('2-42',{revision:d.session.revision,sourceUpdated:1000});
   (stop as (c:Claude,id:string)=>unknown)(c,run.id);const done=await wait(c,run.id);assert.equal(done.state,'cancelled');assert.equal(done.error,reason);
  }
  const log=readLogs(f.store,{tool:'Agent'}).entries[0];assert.equal(log.status,'cancelled');assert.match(log.operation,/^Investigation stopped: INFRA-42$/);
  assert.match(log.output,/^Stopped: the handling of this request changed\.\nTicket: INFRA-42 · Diagnose workload\nModel: test-model\nTool calls: 0\nDuration: \d+ s$/);
 }finally{f.done()}
});

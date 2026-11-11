import {withAiLabel} from '../server/ai-label.js';
import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {Alertmanager} from '../server/alertmanager.js';
import {YouTrack} from '../server/youtrack.js';
import {AlertTickets} from '../server/alert-tickets.js';

const alert={fingerprint:'abc',labels:{alertname:'PodRestart',cluster:'dev',severity:'warning'},annotations:{summary:'Investigate restarts'},startsAt:'2026-11-07T10:00:00Z',status:{state:'active'}};
type RemoteIssue={id:string;idReadable:string;summary:string;description:string;project:{id:string};resolved?:number};
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'support-alert-ticket-'));let store=new Store(dir);
 store.unlock('temporary test passphrase',true);store.credential('YouTrack','private-yt-token');
 const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,Alertmanager:{enabled:true,endpoint:'https://am.internal',scope:'',path:''},YouTrack:{enabled:true,endpoint:'https://yt.internal/base',scope:'project: INFRA #Unresolved',path:''}}},s.configRevision);
 const remote={alerts:[structuredClone(alert)],issues:[] as RemoteIssue[],posts:0,project:{id:'0-1',name:'Infrastructure',shortName:'INFRA',archived:false},lost:false,beforeWrite:false,hidden:false,searchError:false,projectError:false,fields:[] as unknown[],reject:'' as string,lastPayload:undefined as undefined|Record<string,unknown>,postHook:undefined as undefined|(()=>Promise<void>)};
 const fetcher=(async(url,opts)=>{
  const u=new URL(String(url));assert.equal(opts?.redirect,'manual');
  if(u.hostname==='am.internal'){assert.equal(opts?.method,'GET');return Response.json(remote.alerts);}
  assert.equal(u.hostname,'yt.internal');assert.equal((opts?.headers as Record<string,string>).Authorization,'Bearer private-yt-token');
  if(u.pathname==='/base/api/admin/projects'){assert.equal(opts?.method,'GET');return Response.json([remote.project]);}
  if(u.pathname==='/base/api/admin/projects/0-1/customFields')return Response.json(remote.fields);
  if(u.pathname==='/base/api/admin/projects/0-1')return Response.json(remote.project,{status:remote.projectError?403:200});
  if(u.pathname==='/base/api/issues'&&opts?.method==='POST'){
   remote.posts++;const payload=JSON.parse(String(opts.body));assert.deepEqual(Object.keys(payload).filter(k=>k!=='customFields').sort(),['description','project','summary']);remote.lastPayload=payload;
   if(remote.reject)return Response.json({error:'bad_request',error_description:remote.reject},{status:400});assert.deepEqual(payload.project,{id:'0-1'});
   if(remote.beforeWrite)throw new Error('connection interrupted');
   const issue={...payload,id:'2-'+(42+remote.issues.length),idReadable:'INFRA-'+(42+remote.issues.length)};remote.issues.push(issue);
   await remote.postHook?.();if(remote.lost)throw new Error('response lost');return Response.json({id:issue.id});
  }
  assert.equal(opts?.method,'GET');
  if(u.pathname==='/base/api/issues'){
   assert.match(u.searchParams.get('query')!,/^description: "supportalert[a-f0-9]{64}"$/);assert.equal(u.searchParams.get('$top'),'100');
   if(remote.searchError)return Response.json({error:'private upstream message'},{status:503});
   return Response.json(remote.hidden?[]:remote.issues);
  }
  const issue=remote.issues.find(i=>u.pathname.endsWith('/'+i.id));if(issue)return Response.json(issue);
  return Response.json({}, {status:404});
 }) as typeof fetch;
 let am=new Alertmanager(store,fetcher),yt=new YouTrack(store,fetcher),tickets=new AlertTickets(store,am,yt);await am.poll();const id=am.queue().cases[0].id;
 return {remote,id,get store(){return store},get am(){return am},get yt(){return yt},get tickets(){return tickets},
  async draft(){return (await tickets.prepare(id,'0-1')).ticketCreation!;},
  restart(){store.close();store=new Store(dir);store.unlock('temporary test passphrase');am=new Alertmanager(store,fetcher);yt=new YouTrack(store,fetcher);tickets=new AlertTickets(store,am,yt);},
  done(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('drafts and edits never create tickets; exact creation approval posts once and links the verified issue',async()=>{
 const f=await fixture();try{
  assert.equal((await f.yt.projects())[0].id,'0-1');const first=await f.draft();assert.equal(f.remote.posts,0);
  const edited=(await f.tickets.save(f.id,{hash:first.hash,projectId:'0-1',title:'Review payments restarts',description:'## Investigation\n\n- [x] Read deployment\n- [ ] Review fix\n\n```yaml\nreplicas: 2\n```'})).ticketCreation!;
  assert.notEqual(first.hash,edited.hash);await assert.rejects(f.tickets.approve(f.id,first.hash),/current ticket draft/);assert.equal(f.remote.posts,0);
  const c=await f.tickets.approve(f.id,edited.hash);assert.equal(c.ticketCreation?.state,'created');assert.equal(c.ticket?.key,'INFRA-42');assert.equal(f.remote.posts,1);assert.ok(c.ticketCreation?.approval);
  assert.equal(f.remote.issues[0].summary,edited.title);assert.equal(f.remote.issues[0].description,withAiLabel(edited.description)+'\n\nSupport alert case: '+edited.marker);
  await assert.rejects(f.tickets.approve(f.id,edited.hash),/already has/);await assert.rejects(f.tickets.prepare(f.id,'0-1'),/already has/);assert.equal(f.remote.posts,1);
 }finally{f.done();}
});
test('resolved tickets remain linked across absence, recurrence and restart without another POST',async()=>{
 const f=await fixture();try{const d=await f.draft();await f.tickets.approve(f.id,d.hash);f.remote.issues[0].resolved=2000;
  f.remote.alerts=[];await f.am.poll();f.restart();f.remote.alerts=[structuredClone(alert)];await f.am.poll();
  const c=f.am.queue().cases[0];assert.equal(c.episodes,2);assert.equal(c.ticket?.key,'INFRA-42');await assert.rejects(f.draft(),/already has/);assert.equal(f.remote.posts,1);
 }finally{f.done();}
});
for(const change of ['alert','feedback','settings','project','archive','vault'] as const)test(`creation refuses stale ${change} review`,async()=>{
 const f=await fixture();try{const d=await f.draft();
  if(change==='alert')f.remote.alerts[0].labels.severity='critical';
  if(change==='feedback'){const w=await f.am.work(f.id);await f.am.action(f.id,{action:'note',text:'Wait for owner confirmation',revision:w.session.revision,sourceUpdated:w.issue.updated});}
  if(change==='settings'){const s=f.store.snapshot();f.store.config({...s.config,connections:{...s.config.connections,YouTrack:{...s.config.connections.YouTrack,endpoint:'https://yt.internal/other'}}},s.configRevision);}
  if(change==='project')f.remote.project.name='Changed project';if(change==='archive')f.remote.project.archived=true;if(change==='vault')f.store.lock();
  await assert.rejects(f.tickets.approve(f.id,d.hash));assert.equal(f.remote.posts,0);
 }finally{f.done();}
});
test('ambiguous acceptance recovers after restart through reads only, including delayed indexing',async()=>{
 const f=await fixture();try{const d=await f.draft();f.remote.lost=true;assert.equal((await f.tickets.approve(f.id,d.hash)).ticketCreation?.state,'pending');assert.equal(f.remote.posts,1);
  f.restart();f.remote.hidden=true;assert.equal((await f.tickets.reconcile(f.id)).ticketCreation?.state,'pending');
  await assert.rejects(f.draft(),/pending/);await assert.rejects(f.tickets.approve(f.id,d.hash),/pending/);await assert.rejects(f.am.link(f.id,'INFRA-42',f.yt),/pending/);
  f.remote.hidden=false;const recovered=await f.tickets.reconcile(f.id);assert.equal(recovered.ticket?.key,'INFRA-42');assert.equal(f.remote.posts,1);
 }finally{f.done();}
});
test('an uncertain request that never reached YouTrack is not retried or pruned',async()=>{
 const f=await fixture();try{const d=await f.draft();f.remote.beforeWrite=true;await f.tickets.approve(f.id,d.hash);assert.equal(f.remote.issues.length,0);
  const c=f.store.alert(f.id);c.active=false;c.lastSeen='2000-01-01T00:00:00Z';f.store.saveAlert(c);f.remote.alerts=[];await f.am.poll();
  assert.equal(f.store.alert(f.id).ticketCreation?.state,'pending');await f.tickets.reconcile(f.id);await f.tickets.reconcile(f.id);assert.equal(f.remote.posts,1);
 }finally{f.done();}
});
test('duplicate clicks and manual linking cannot race a pending creation; polling does not lose updates',async()=>{
 const f=await fixture();try{const d=await f.draft();let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),held=new Promise<void>(r=>release=r);
  f.remote.postHook=async()=>{started();await held;};const creating=f.tickets.approve(f.id,d.hash);await entered;
  await assert.rejects(f.tickets.approve(f.id,d.hash),/Another/);await assert.rejects(f.am.link(f.id,'INFRA-42',f.yt),/Another/);
  f.remote.alerts=[];await f.am.poll();release();const result=await creating;assert.equal(result.active,false);assert.equal(result.ticket?.key,'INFRA-42');assert.equal(f.remote.posts,1);
 }finally{f.done();}
});
test('a pre-existing exact reference is linked even when resolved or outside the queue query',async()=>{
 const f=await fixture();try{f.remote.issues.push({id:'2-42',idReadable:'INFRA-42',summary:'Existing incident',description:'Historical case\n\nSupport alert case: supportalert'+f.id,project:{id:'0-1'},resolved:2000});
  assert.equal((await f.tickets.prepare(f.id,'0-1')).ticket?.key,'INFRA-42');assert.equal(f.remote.posts,0);
 }finally{f.done();}
});
test('preflight rechecks existing references immediately before POST and fails closed on ambiguous matches or failed searches',async()=>{
 const f=await fixture();try{const d=await f.draft();f.remote.searchError=true;await assert.rejects(f.tickets.approve(f.id,d.hash));assert.equal(f.remote.posts,0);f.remote.searchError=false;
  const i={id:'2-42',idReadable:'INFRA-42',summary:'Existing',description:'Support alert case: '+d.marker,project:{id:'0-1'}};
  f.remote.issues.push(i,{...i,id:'2-43',idReadable:'INFRA-43'});await assert.rejects(f.tickets.approve(f.id,d.hash),/Multiple/);assert.equal(f.remote.posts,0);
  f.remote.issues.pop();assert.equal((await f.tickets.approve(f.id,d.hash)).ticket?.key,'INFRA-42');assert.equal(f.remote.posts,0);
 }finally{f.done();}
});
test('secret-bearing edits are rejected, and creation cannot be redirected by changing settings mid-request',async()=>{
 const f=await fixture();try{const d=await f.draft();await assert.rejects(f.tickets.save(f.id,{hash:d.hash,projectId:'0-1',title:d.title,description:'private-yt-token'}),/credential/);
  f.remote.postHook=async()=>{f.store.lock();};const result=await f.tickets.approve(f.id,d.hash);assert.equal(result.ticketCreation?.state,'pending');assert.equal(result.ticket,undefined);
  f.store.unlock('temporary test passphrase');const s=f.store.snapshot();f.store.config({...s.config,connections:{...s.config.connections,YouTrack:{...s.config.connections.YouTrack,endpoint:'https://other.internal'}}},s.configRevision);
  const pending=await f.tickets.reconcile(f.id);assert.equal(pending.ticketCreation?.state,'pending');assert.match(pending.ticketCreation!.message,/original YouTrack/);assert.equal(f.remote.posts,1);
 }finally{f.done();}
});

test('a refused creation returns to the draft with YouTrack\'s reason, and required fields are sent with their type',async()=>{
 const f=await fixture();
 try{
  f.remote.fields=[{$type:'EnumProjectCustomField',canBeEmpty:false,field:{name:'Type'},defaultValues:[],bundle:{values:[{name:'Bug'},{name:'Task'},{name:'Old',archived:true}]}},{$type:'StateProjectCustomField',canBeEmpty:false,field:{name:'State'},defaultValues:[{name:'Open'}],bundle:{values:[{name:'Open'},{name:'Fixed'}]}},{$type:'EnumProjectCustomField',canBeEmpty:true,field:{name:'Optional'},bundle:{values:[{name:'x'}]}}];
  let d=await f.draft();
  assert.deepEqual(d.fields?.map(x=>[x.name,x.value,x.options]),[['Type','',['Bug','Task']],['State','Open',['Open','Fixed']]]);
  await assert.rejects(f.tickets.approve(f.id,d.hash),/Choose a value for Type/);assert.equal(f.remote.posts,0);
  d=(await f.tickets.save(f.id,{hash:d.hash,projectId:'0-1',title:d.title,description:d.description,fields:{Type:'Bug'}})).ticketCreation!;
  f.remote.reject='Field Subsystem is required';
  let c=await f.tickets.approve(f.id,d.hash);
  assert.equal(c.ticketCreation?.state,'draft');assert.match(c.ticketCreation!.message,/YouTrack refused the ticket: Field Subsystem is required\. Nothing was created\./);assert.equal(c.ticketCreation?.approval,undefined);
  assert.deepEqual(f.remote.lastPayload?.customFields,[{name:'Type',$type:'SingleEnumIssueCustomField',value:{name:'Bug'}},{name:'State',$type:'StateIssueCustomField',value:{name:'Open'}}]);
  f.remote.reject='';c=await f.tickets.approve(f.id,c.ticketCreation!.hash);assert.equal(c.ticket?.key,'INFRA-42');
 }finally{f.done()}
});

test('the default project and its field defaults prefill a new draft',async()=>{
 const f=await fixture();
 try{
  f.remote.fields=[{$type:'EnumProjectCustomField',canBeEmpty:false,field:{name:'Type'},defaultValues:[],bundle:{values:[{name:'Bug'},{name:'Task'}]}}];
  const s=f.store.snapshot();f.store.config({...s.config,youtrackTicketDefaults:{projectId:'0-1',fields:{Type:'Task'}}},s.configRevision);
  assert.equal((await f.draft()).fields?.[0].value,'Task');
  const cache=await f.yt.cachedProjects();assert.equal(cache.projects[0].id,'0-1');
  const again=await f.yt.cachedProjects();assert.equal(again.at,cache.at,'served from the cache');
  const before=f.remote.project.name;f.remote.project.name='Renamed';assert.equal((await f.yt.cachedProjects()).projects[0].name,before,'the cache is reused');assert.equal((await f.yt.cachedProjects(true)).projects[0].name,'Renamed','refresh reads YouTrack again');
 }finally{f.done()}
});

test('annotation updates and unrelated settings saves do not make a ticket draft stale',async()=>{
 const f=await fixture();
 try{
  const d=await f.draft();
  f.remote.alerts[0].annotations.summary='CPU at 97.3%';
  const s=f.store.snapshot();f.store.config({...s.config,engineer:'Another engineer'},s.configRevision);
  const c=await f.tickets.approve(f.id,d.hash);assert.equal(c.ticket?.key,'INFRA-42');assert.equal(f.remote.posts,1);
 }finally{f.done()}
});

test('multi-value fields are sent as lists with their multi type, and errors name fields instead of IDs',async()=>{
 const f=await fixture();
 try{
  f.remote.fields=[{id:'127-323',$type:'EnumProjectCustomField',canBeEmpty:false,field:{name:'Cluster',fieldType:{isMultiValue:true}},defaultValues:[{name:'all'}],bundle:{values:[{name:'all'},{name:'mars-shared'}]}},{id:'127-1',$type:'EnumProjectCustomField',canBeEmpty:false,field:{name:'Type',fieldType:{isMultiValue:false}},defaultValues:[{name:'tache'}],bundle:{values:[{name:'tache'}]}}];
  const d=await f.draft();
  f.remote.reject='Incompatible field type: 127-323';
  let c=await f.tickets.approve(f.id,d.hash);
  assert.match(c.ticketCreation!.message,/Incompatible field type: Cluster \(127-323\)/);
  assert.deepEqual(f.remote.lastPayload?.customFields,[{name:'Cluster',$type:'MultiEnumIssueCustomField',value:[{name:'all'}]},{name:'Type',$type:'SingleEnumIssueCustomField',value:{name:'tache'}}]);
  f.remote.reject='';c=await f.tickets.approve(f.id,c.ticketCreation!.hash);assert.equal(c.ticket?.key,'INFRA-42');
 }finally{f.done()}
});

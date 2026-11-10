import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {YouTrack} from '../server/youtrack.js';
function setup(){const dir=mkdtempSync(join(tmpdir(),'support-yt-'));const s=new Store(dir);s.unlock('long enough fixture passphrase',true);s.credential('YouTrack','fixture-secret');const c=s.snapshot();s.config({...c.config,connections:{...c.config.connections,YouTrack:{endpoint:'https://yt.internal/youtrack',scope:'project: INFRA #Unresolved',path:'',enabled:true}}},c.configRevision);return {s,done(){s.close();rmSync(dir,{recursive:true,force:true})}}}
const issue={id:'2-42',idReadable:'INFRA-123',summary:'Remote title must not be stored',description:'Remote body must not be stored',updated:1000,resolved:null,project:{name:'Infrastructure',shortName:'INFRA'},customFields:[{name:'State',value:{name:'Open'}},{name:'Assignee',value:[{fullName:'Engineer'}]},{name:'Priority',value:{name:'High'}}]};
test('reads scoped paginated GETs with bearer token and no redirects',async()=>{const f=setup();try{const yt=new YouTrack(f.s,(async(url,opts)=>{const u=new URL(String(url));assert.equal(u.pathname,'/youtrack/api/issues');assert.equal(u.searchParams.get('query'),'project: INFRA #Unresolved');assert.equal(u.searchParams.get('$skip'),'50');assert.equal(u.searchParams.get('$top'),'50');assert.equal(opts?.method,'GET');assert.equal(opts?.redirect,'manual');assert.equal((opts?.headers as Record<string,string>).Authorization,'Bearer fixture-secret');return Response.json([issue]);}) as typeof fetch);const r=await yt.list(50);assert.equal(r.issues[0].assignee,'Engineer');assert.equal(r.issues[0].status,'Open');assert.equal(r.issues[0].url,'https://yt.internal/youtrack/issue/INFRA-123');assert.equal(r.hasMore,false);assert.equal(f.s.db.prepare('SELECT count(*) AS n FROM work_sessions').get()!.n,0)}finally{f.done()}});
test('only work sessions persist; source changes clear approvals and old plans survive',async()=>{const f=setup();let updated=1000;try{const yt=new YouTrack(f.s,(async()=>Response.json({...issue,updated})) as typeof fetch);let d=await yt.work('2-42');assert.equal(f.s.db.prepare('SELECT count(*) AS n FROM work_sessions').get()!.n,1);d=await yt.action('2-42',{action:'plan',revision:d.session.revision,sourceUpdated:updated,text:'Local plan'});d=await yt.action('2-42',{action:'approve',revision:d.session.revision,sourceUpdated:updated});assert.ok(d.session.approval);const raw=f.s.db.prepare('SELECT value FROM work_sessions').get()!.value as string;assert.ok(!raw.includes(issue.summary));assert.ok(!raw.includes(issue.description));assert.ok(!raw.includes('Engineer'));updated=2000;d=await yt.work('2-42');assert.equal(d.session.approval,null);assert.equal(d.session.plans[0].text,'Local plan');await assert.rejects(yt.action('2-42',{action:'approve',revision:d.session.revision,sourceUpdated:1000}),/changed/);d=await yt.action('2-42',{action:'revise',revision:d.session.revision,sourceUpdated:updated,text:'Check certificate'});await assert.rejects(yt.action('2-42',{action:'approve',revision:d.session.revision,sourceUpdated:updated}),/revised plan/);}finally{f.done()}});
test('locked vault, unsafe remote HTTP and redirects cannot transmit beyond configured endpoint',async()=>{const f=setup();let calls=0;try{const yt=new YouTrack(f.s,(async()=>{calls++;return new Response('secret upstream error',{status:302,headers:{Location:'https://elsewhere.example'}})}) as typeof fetch);await assert.rejects(yt.list(),/Redirects are not followed/);assert.equal(calls,1);f.s.lock();await assert.rejects(yt.list(),/Unlock/);assert.equal(calls,1);f.s.unlock('long enough fixture passphrase');const c=f.s.snapshot();f.s.config({...c.config,connections:{...c.config.connections,YouTrack:{...c.config.connections.YouTrack,endpoint:'http://yt.internal'}}},c.configRevision);await assert.rejects(yt.list(),/HTTPS/);assert.equal(calls,1)}finally{f.done()}});
test('access failures discard upstream bodies and vault changes discard in-flight results',async()=>{const f=setup();try{const denied=new YouTrack(f.s,(async()=>new Response('upstream secret',{status:403})) as typeof fetch);await assert.rejects(denied.list(),e=>e instanceof Error&&e.message==='The token cannot read this YouTrack resource.');const racing=new YouTrack(f.s,(async()=>{f.s.lock();return Response.json([issue])}) as typeof fetch);await assert.rejects(racing.list(),/vault changed/)}finally{f.done()}});
test('comment-only changes invalidate approvals even when issue timestamp is unchanged',async()=>{const f=setup();let comment='Original detail';try{const yt=new YouTrack(f.s,(async()=>Response.json({...issue,comments:[{id:'c1',text:comment,created:100,updated:200}]})) as typeof fetch);let d=await yt.work('2-42');d=await yt.action('2-42',{action:'plan',text:'Plan',revision:d.session.revision,sourceUpdated:d.issue.updated});d=await yt.action('2-42',{action:'approve',revision:d.session.revision,sourceUpdated:d.issue.updated});assert.ok(d.session.approval);comment='New requirements';const fresh=await yt.work('2-42');assert.equal(fresh.session.approval,null);assert.equal(fresh.issue.comments?.[0].text,comment);assert.notEqual(fresh.session.revision,d.session.revision);}finally{f.done()}});

for(const field of ['priority','description','title','new-comment','edited-comment','deleted-comment'] as const)test(`${field} changes invalidate reviews without relying on the issue timestamp`,async()=>{
 const f=setup();let raw={...structuredClone(issue),comments:[{id:'c1',text:'Initial requirement',updated:200,deleted:false}]};
 try{
  const yt=new YouTrack(f.s,(async()=>Response.json(raw)) as typeof fetch);
  let d=await yt.work(issue.id);d=await yt.action(issue.id,{action:'plan',text:'Existing plan',revision:d.session.revision,sourceUpdated:1000});d=await yt.action(issue.id,{action:'approve',revision:d.session.revision,sourceUpdated:1000});
  if(field==='priority')raw.customFields=raw.customFields.map(c=>c.name==='Priority'?{name:'Priority',value:{name:'Critical'}}:c);
  if(field==='description')raw.description='Updated requirements';
  if(field==='title')raw.summary='New scope';
  if(field==='new-comment')raw.comments.push({id:'c2',text:'Another requirement',updated:200,deleted:false});
  if(field==='edited-comment')raw.comments[0].text='Corrected requirement';
  if(field==='deleted-comment')raw.comments[0].deleted=true;
  await assert.rejects(yt.action(issue.id,{action:'approve',revision:d.session.revision,sourceUpdated:1000}),/changed/);
  // Invalidating the saved approval survives the rejected stale action.
  assert.equal(f.s.getWorkSession(d.issue.connection,issue.id)?.approval,null);
  const fresh=await yt.work(issue.id);assert.ok(fresh.session.sourceChangedAt);assert.equal(fresh.session.plans[0].text,'Existing plan');assert.equal(fresh.issue.updated,1000);
  if(field==='priority')assert.equal(fresh.issue.severity,'Critical');
  const reviewed=await yt.action(issue.id,{action:'approve',revision:fresh.session.revision,sourceUpdated:1000});assert.ok(reviewed.session.approval);assert.equal(reviewed.session.sourceChangedAt,undefined);
 }finally{f.done()}
});
test('ordering changes alone do not invalidate a review',async()=>{
 const f=setup();let raw={...structuredClone(issue),comments:[{id:'b',text:'B',updated:2},{id:'a',text:'A',updated:1}]};
 try{const yt=new YouTrack(f.s,(async()=>Response.json(raw)) as typeof fetch);const before=await yt.issue(issue.id);raw.comments.reverse();raw.customFields.reverse();const after=await yt.issue(issue.id);assert.equal(before.sourceFingerprint,after.sourceFingerprint)}finally{f.done()}
});
test('plan annotations queue without a run, survive reads, and can be deleted without restoring approval',async()=>{
 const f=setup();try{
  const yt=new YouTrack(f.s,(async()=>Response.json(issue)) as typeof fetch);let d=await yt.work(issue.id);
  d=await yt.action(issue.id,{action:'plan',text:'## Plan\nCheck **service**.',revision:d.session.revision,sourceUpdated:1000});
  d=await yt.action(issue.id,{action:'approve',revision:d.session.revision,sourceUpdated:1000});
  const annotate=async(kind:'comment'|'recheck')=>{d=await yt.action(issue.id,{action:'revise',text:'[Plan v1]\nRequested change:\nCheck this part',annotation:{version:1,quote:'service',markdown:'**service**',kind},revision:d.session.revision,sourceUpdated:1000})};
  await annotate('comment');const first=d.session.notes[0].id!;await annotate('recheck');
  assert.equal(d.session.approval,null);assert.equal(d.session.pendingRevision,true);assert.equal(d.session.plans.length,1);assert.equal(d.session.notes[0].annotation?.markdown,'**service**');assert.equal(f.s.db.prepare('SELECT count(*) AS n FROM investigations').get()!.n,0);
  d=await yt.work(issue.id);assert.equal(d.session.notes[0].id,first);const prior=d.session.revision;
  d=await yt.action(issue.id,{action:'delete-note',text:first,revision:d.session.revision,sourceUpdated:1000});assert.equal(d.session.notes.length,1);assert.equal(d.session.notes[0].annotation?.kind,'recheck');assert.equal(d.session.pendingRevision,true);
  await assert.rejects(yt.action(issue.id,{action:'delete-note',text:d.session.notes[0].id,revision:prior,sourceUpdated:1000}),/changed/);
  d=await yt.action(issue.id,{action:'delete-note',text:d.session.notes[0].id,revision:d.session.revision,sourceUpdated:1000});assert.equal(d.session.notes.length,0);assert.equal(d.session.pendingRevision,false);assert.equal(d.session.approval,null);assert.equal(d.session.plans.length,1);
 }finally{f.done()}
});

test('the ticket list requests no descriptions or comments',async()=>{const f=setup();try{let fields='';const yt=new YouTrack(f.s,(async(url:RequestInfo|URL)=>{fields=new URL(String(url)).searchParams.get('fields')??'';return Response.json([{id:'2-1',idReadable:'INFRA-1',summary:'Disk',updated:1,resolved:null,customFields:[]}]);}) as typeof fetch);
 const page=await yt.list(0,true);assert.ok(!fields.includes('comments')&&!fields.includes('description'));assert.equal(page.issues[0].key,'INFRA-1');assert.equal(page.issues[0].sourceFingerprint,undefined);
 await yt.list(0);assert.ok(fields.includes('comments('),'the intake queue keeps the full fields');}finally{f.done()}});

import {parseSavedFilter} from '../src/saved-filters.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {defaults} from '../src/model.js';
import {parseRoute,routeHash} from '../src/navigation.js';
import {mergeSettings,settingsErrors} from '../src/settings-state.js';
import {loggedFetch,recordDiagnostic,readLogs,redactDiagnostic} from '../server/diagnostics.js';
import {dashboardSummary} from '../server/dashboard.js';
import type {AIOverview} from '../src/ai-model.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-diagnostics-'));const store=new Store(dir);store.unlock('an isolated test passphrase',true);const config=structuredClone(defaults);config.connections.YouTrack.endpoint='http://127.0.0.1:8080';config.connections.Model.endpoint='https://api.openai.com';store.config(config,1);return {store,close(){store.close();rmSync(dir,{recursive:true,force:true})}}}
test('routes preserve issue, connection, step and settings; reject unknown pages and oversized params',()=>{
 for(const route of [{page:'youtrack' as const,issue:'3-0',connection:'scope',step:'investigation'},{page:'settings' as const,section:'Model'},{page:'logs' as const,tool:'GitLab'}])assert.deepEqual(parseRoute(routeHash(route)),route);
 assert.equal(parseRoute('#/not-a-page').page,'youtrack');assert.equal(parseRoute('#/youtrack?issue='+('a'.repeat(201))).issue,undefined);
});
test('settings reconcile account-only revisions and remote edits without losing unsaved fields',()=>{
 const base=structuredClone(defaults),draft=structuredClone(base),saved=structuredClone(base);draft.connections.Model.scope='selected-model';saved.engineer='Other name';
 const result=mergeSettings(base,draft,saved);assert.equal(result.config.connections.Model.scope,'selected-model');assert.equal(result.config.engineer,'Other name');assert.deepEqual(result.conflicts,[]);
 assert.deepEqual(mergeSettings(base,draft,base).config,draft);
 saved.connections.Model.scope='remote-model';const conflict=mergeSettings(base,draft,saved);assert.deepEqual(conflict.conflicts,['connections.Model.scope']);assert.equal(conflict.config.connections.Model.scope,'selected-model');
});
test('settings errors identify the section even when its fields are not mounted',()=>{const draft=structuredClone(defaults);draft.connections.GitLab.endpoint='not a url';draft.retentionDays=40;assert.deepEqual(settingsErrors(draft).map(e=>e.section).sort(),['Connections','Storage & export']);});
test('diagnostics redact structured secrets and preserve the original HTTP response',async()=>{const f=fixture();try{f.store.credential('YouTrack','private-live-token');const raw={token:'unknown-token',message:'Authorization: Bearer private-live-token',data:'safe output'};const transport=loggedFetch(f.store,async()=>Response.json(raw));const response=await transport('http://127.0.0.1:8080/api/issues?token=private-live-token',{headers:{Authorization:'Bearer private-live-token'}});assert.deepEqual(await response.json(),raw);const logs=readLogs(f.store);assert.equal(logs.entries.length,1);assert.match(logs.entries[0].output,/safe output/);assert.doesNotMatch(JSON.stringify(logs),/private-live-token|unknown-token/);const db=JSON.stringify(f.store.db.prepare('SELECT * FROM diagnostics').all());assert.doesNotMatch(db,/safe output|private-live-token/);}finally{f.close()}});
test('diagnostics bound response capture, exclude auth/model bodies and stop on vault changes',async()=>{const f=fixture();try{const large='x'.repeat(40000);let transport=loggedFetch(f.store,async()=>new Response(large));assert.equal((await (await transport('http://127.0.0.1:8080/api/issues')).text()).length,large.length);assert.equal(readLogs(f.store).entries[0].truncated,true);{const out=readLogs(f.store).entries[0].output;assert.ok(out.startsWith('xxxx'));assert.ok(Buffer.byteLength(out)<=24*1024);assert.ok(/\n… \[truncated: first 24 KB of 39 KB shown\]$/.test(out),out.slice(-120));}transport=loggedFetch(f.store,async()=>new Response('private model response'));await (await transport('https://api.openai.com/v1/responses',{method:'POST',body:'private model prompt'})).text();await (await transport('https://auth.openai.com/oauth/token')).text();assert.doesNotMatch(JSON.stringify(readLogs(f.store)),/private model/);assert.equal(readLogs(f.store).total,2);
 const pending=await transport('http://127.0.0.1:8080/api/issues');f.store.lock();await pending.text();assert.throws(()=>readLogs(f.store),/Unlock/);f.store.unlock('an isolated test passphrase');assert.equal(readLogs(f.store).total,2);
 }finally{f.close()}});
test('logs are retained within time and count bounds; pagination and tool filters use stable sequence',()=>{const f=fixture();try{for(let n=0;n<57;n++)recordDiagnostic(f.store,{tool:n%2?'GitLab':'App',operation:'read '+n,status:'ok',durationMs:1,output:'safe'});recordDiagnostic(f.store,{at:'2000-01-01T00:00:00Z',tool:'App',operation:'old',status:'ok',durationMs:1,output:'expired'});const page=readLogs(f.store);assert.equal(page.entries.length,50);assert.equal(page.total,57);const next=readLogs(f.store,{before:page.next});assert.equal(next.entries.length,7);assert.equal(new Set([...page.entries,...next.entries].map(e=>e.id)).size,57);assert.ok(readLogs(f.store,{tool:'GitLab'}).entries.every(e=>e.tool==='GitLab'));}finally{f.close()}});
test('diagnostic redaction removes private keys and reasoning content',()=>{const output=redactDiagnostic(JSON.stringify({reasoning:'hidden',nested:{api_key:'key'},text:'-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----'}));assert.doesNotMatch(output,/hidden|"key"|BEGIN RSA/)});
test('dashboard uses a bounded sample, explicit terminal denominators and timezone dates',()=>{const overview:AIOverview={workflows:[],runs:[{id:'a',connection:'c',issueId:'i',kind:'investigation',state:'completed',startedAt:'2026-11-07T23:30:00Z',finishedAt:'2026-11-07T23:30:10Z',updatedAt:'',step:'',checks:0,repeating:false,quiet:false},{id:'b',connection:'c',issueId:'i',kind:'investigation',state:'blocked',startedAt:'2026-11-07T23:40:00Z',finishedAt:'2026-11-07T23:40:30Z',updatedAt:'',step:'',checks:0,repeating:false,quiet:false}],loadedAt:'',historyLimit:200,agent:{model:'test',active:false,step:''}};const summary=dashboardSummary(overview,7,'Europe/Paris',30,Date.parse('2026-11-08T12:00:00Z'));assert.equal(summary.completionRate,50);assert.equal(summary.medianSeconds,20);assert.equal(summary.daily.at(-1)?.completed,1);assert.equal(summary.daily.at(-1)?.failed,1);assert.equal(dashboardSummary({...overview,runs:[]},7,'UTC',30).completionRate,null);});
test('log header filters cover retained history beyond the first page and paginate matches',()=>{const f=fixture();try{for(let n=0;n<60;n++)recordDiagnostic(f.store,{tool:'GitLab',operation:n<5?'GET pipelines':'GET branches',status:'ok',durationMs:n<5?1500:20,output:'safe'});const selected=readLogs(f.store,{query:'pipelines',duration:'slow',time:'hour',limit:2});assert.equal(selected.total,5);assert.equal(selected.entries.length,2);assert.ok(selected.entries.every(e=>e.operation==='GET pipelines'));const next=readLogs(f.store,{query:'pipelines',duration:'slow',time:'hour',limit:2,before:selected.next});assert.equal(next.total,5);assert.equal(next.entries.length,2);assert.notEqual(next.entries[0].id,selected.entries[0].id);assert.equal(readLogs(f.store,{query:'pipelines',duration:'fast'}).total,0);}finally{f.close()}});

test('saved filters restore valid text and multi-select values and reject corrupt storage',()=>{assert.equal(parseSavedFilter('"pipeline"',''),'pipeline');assert.deepEqual(parseSavedFilter('["Open","Submitted"]',[]),['Open','Submitted']);assert.equal(parseSavedFilter('{broken','all'),'all');assert.deepEqual(parseSavedFilter('[1,{}]',[]),[]);assert.equal(parseSavedFilter(JSON.stringify('x'.repeat(2001)),''),'');assert.deepEqual(parseSavedFilter(JSON.stringify(Array(101).fill('x')),[]),[]);});

test('hourly dashboard uses 24 distinct buckets across DST and excludes future runs',()=>{
 const now=Date.parse('2026-10-25T03:30:00Z');
 const base={connection:'c',issueId:'i',kind:'investigation' as const,state:'completed' as const,updatedAt:'',step:'',checks:2,repeating:true,quiet:false};
 const overview:AIOverview={workflows:[],runs:[{...base,id:'first',startedAt:'2026-10-25T00:10:00Z',finishedAt:'2026-10-25T00:10:10Z'},{...base,id:'second',startedAt:'2026-10-25T01:10:00Z',finishedAt:'2026-10-25T01:10:20Z'},{...base,id:'future',startedAt:'2026-10-25T03:45:00Z'},{...base,id:'old',startedAt:'2026-10-24T02:59:00Z'}],loadedAt:'',historyLimit:200,agent:{model:'test',active:false,step:''}};
 const result=dashboardSummary(overview,7,'Europe/Paris',30,now,'hour');
 assert.equal(result.daily.length,24);assert.equal(new Set(result.daily.map(d=>d.date)).size,24);
 assert.equal(result.totalRuns,2);assert.equal(result.checks,4);assert.equal(result.runSeconds,30);assert.equal(result.repeatedRuns,2);
 const repeatedHour=result.daily.filter(d=>d.label.startsWith('02:00'));assert.equal(repeatedHour.length,2);assert.notEqual(repeatedHour[0].label,repeatedHour[1].label);assert.ok(repeatedHour.every(d=>d.completed===1));
 const empty=dashboardSummary({...overview,runs:[]},7,'UTC',30,now,'hour');assert.equal(empty.medianSeconds,null);assert.equal(empty.completionRate,null);assert.equal(empty.totalRuns,0);
});

test('token chart drilldown filters retained log records by calendar window and operation',()=>{
 const f=fixture();try{
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
 recordDiagnostic(f.store,{tool:'Model',operation:'Model usage',status:'ok',durationMs:0,output:'usage',at:day+'T12:00:00Z'});
 recordDiagnostic(f.store,{tool:'Model',operation:'Transport',status:'ok',durationMs:0,output:'none',at:day+'T12:00:00Z'});
 recordDiagnostic(f.store,{tool:'Model',operation:'Model usage',status:'ok',durationMs:0,output:'outside',at:day+'T23:30:00Z'});
 const found=readLogs(f.store,{tool:'Model',query:'Model usage',from:day,to:day,zone:'Europe/Paris'});
 assert.equal(found.total,1);assert.equal(found.entries[0].output,'usage');
 }finally{f.close()}
});

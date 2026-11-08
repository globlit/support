import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {defaults,type AnalysisRun} from '../src/model.js';
import {activityBuckets} from '../server/ai-activity.js';
import {tokenUsage,rateLimits} from '../server/model-telemetry.js';
import {configuredModelFetch,modelFetch} from '../server/model-api.js';
import {readLogs} from '../server/diagnostics.js';
import {recordHealthProbe,toolHealth} from '../server/tool-health.js';
import {dashboard} from '../server/dashboard.js';
import type {AIOverview} from '../src/ai-model.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-telemetry-')),store=new Store(dir);store.unlock('a telemetry test passphrase',true);const config=structuredClone(defaults);config.connections.Model.enabled=true;config.connections.Model.endpoint='https://model.internal';config.connections.Model.scope='test';store.config(config,1);return {store,close(){store.close();rmSync(dir,{recursive:true,force:true})}}}
const body={model:'test',max_tokens:100,system:'Private instructions',messages:[{role:'user',content:'private ticket'}],tools:[]};
const request={method:'POST',headers:{'x-api-key':'private-api-key'},body:JSON.stringify(body)};

test('usage counts distinguish missing values and avoid double counting provider caches',()=>{
 assert.deepEqual(tokenUsage({input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:40}},'openai'),{input:100,output:20,cacheRead:40,cacheWrite:undefined});
 assert.deepEqual(tokenUsage({input_tokens:100,output_tokens:20,cache_read_input_tokens:40,cache_creation_input_tokens:10},'anthropic'),{input:150,output:20,cacheRead:40,cacheWrite:10});
 for(const value of [null,{}, {input_tokens:-1,output_tokens:1},{input_tokens:'3',output_tokens:1}])assert.equal(tokenUsage(value,'openai'),undefined);
 assert.equal(tokenUsage({input_tokens:0,output_tokens:0},'openai')?.input,0);
 const limits=rateLimits(new Headers({'x-ratelimit-limit-tokens':'100','x-ratelimit-remaining-tokens':'90','x-ratelimit-reset-tokens':'2m3s','set-cookie':'secret','x-ratelimit-limit-requests':'bad'}),'openai');assert.deepEqual(limits,[{name:'tokens',limit:100,remaining:90,reset:'2m3s'}]);
});

test('usage is encrypted, bounded metadata and survives loading in the dashboard',async()=>{
 const f=fixture();try{
 const transport=configuredModelFetch(f.store,async()=>Response.json({usage:{input_tokens:12,output_tokens:3,cache_read_input_tokens:5},content:[{type:'text',text:'private generated reply'}],stop_reason:'end_turn'}));
 const result=await (await transport('https://model.internal/v1/messages',request)).json();assert.equal(result.content[0].text,'private generated reply');
 const logs=readLogs(f.store);assert.equal(logs.entries[0].telemetry?.usage?.input,17);assert.doesNotMatch(JSON.stringify(logs),/private generated|private ticket|private-api-key/);
 assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT value FROM diagnostics').all()),/telemetry|input|generated reply/);
 const empty:AIOverview={workflows:[],runs:[],historyLimit:200,loadedAt:'',agent:{model:'test',active:false,step:''}};
 const d=dashboard(f.store,empty,7);assert.equal(d.usage?.responses,1);assert.equal(d.usage?.input,17);assert.equal(d.usage?.output,3);
 }finally{f.close()}
});

test('OpenAI stream reports usage once and never treats cache reads as extra input',async()=>{
 const seen:unknown[]=[];const response={status:'completed',output:[],usage:{input_tokens:20,output_tokens:5,input_tokens_details:{cached_tokens:10}}};
 const transport=modelFetch('openai',async()=>new Response('data: '+JSON.stringify({type:'response.completed',response})+'\n\n'),true,{onUsage:u=>seen.push(u)});
 await transport('https://api.openai.com/v1/messages',request);assert.equal(seen.length,1);assert.deepEqual(seen[0],{input:20,output:5,cacheRead:10,cacheWrite:undefined});
});

test('vault changes during inference do not retain token metadata',async()=>{
 const f=fixture();try{const t=configuredModelFetch(f.store,async()=>{f.store.lock();f.store.unlock('a telemetry test passphrase');return Response.json({usage:{input_tokens:5,output_tokens:2}})});await t('https://model.internal/v1/messages',request);assert.equal(readLogs(f.store).entries.length,0);}finally{f.close()}
});

test('tool health distinguishes reachable, stale, rejected and unknown credentials',()=>{
 const f=fixture();try{const status=()=>toolHealth(f.store).find(t=>t.name==='Model')!;
 assert.equal(status().label,'Checking');recordHealthProbe(f.store,'Model',{ok:true,detail:'Catalog available'});assert.equal(status().state,'green');assert.equal(toolHealth(f.store,Date.now()+301000).find(t=>t.name==='Model')!.state,'yellow');
 recordHealthProbe(f.store,'Model',{ok:false,detail:'Rate limited',code:429});assert.equal(status().label,'Stale');recordHealthProbe(f.store,'Model',{ok:false,detail:'Access denied',code:401});assert.equal(status().label,'Failed');assert.equal(status().state,'red');
 f.store.credential('Model','new credential');assert.equal(status().label,'Checking');assert.equal(toolHealth(f.store).find(t=>t.name==='GitLab')!.state,'off');
 }finally{f.close()}
});

test('sparkline contains only recorded timestamps within run bounds',()=>{
 const run={startedAt:'2026-11-08T10:00:00Z',finishedAt:'2026-11-08T10:00:40Z',events:[{at:'2026-11-08T10:00:00Z'},{at:'2026-11-08T10:00:20Z'},{at:'2026-11-08T10:00:20Z'},{at:'2026-11-08T10:00:40Z'},{at:'invalid'},{at:'2026-11-08T09:00:00Z'}]} as AnalysisRun;
 const b=activityBuckets(run);assert.equal(b.counts.length,40);assert.equal(b.counts[0],1);assert.equal(b.counts[20],2);assert.equal(b.counts[39],1);assert.equal(b.counts.reduce((a,b)=>a+b,0),4);
});

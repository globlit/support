import {toolHealth} from './tool-health.js';
import type {Diagnostic} from '../src/diagnostics-model.js';
import type {AIOverview} from '../src/ai-model.js';
import type {DashboardData} from '../src/dashboard-model.js';
import type {Store} from './store.js';
import {pruneLogs} from './diagnostics.js';
import {mergeCounts,type ToolCount} from '../src/tool-usage.js';
export function dashboardSummary(overview:AIOverview,days:number,timezone:string,retentionDays:number,now=Date.now(),interval:'hour'|'day'='day'):DashboardData{
 const date=(time:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(time);
 const today=date(now),daily:DashboardData['daily']=[];const utc=new Date(today+'T12:00:00Z');
 for(let i=days-1;i>=0;i--){const d=new Date(utc);d.setUTCDate(d.getUTCDate()-i);const key=d.toISOString().slice(0,10);daily.push({date:key,label:new Intl.DateTimeFormat('en',{month:'short',day:'numeric',timeZone:'UTC'}).format(d),completed:0,failed:0,stopped:0,running:0});}
 if(interval==='hour'){
  daily.length=0;const end=Math.floor(now/3600000)*3600000;
  for(let i=23;i>=0;i--){const time=end-i*3600000;daily.push({date:new Date(time).toISOString(),label:new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(time),completed:0,failed:0,stopped:0,running:0});}
 }
 const bucketKey=(time:number)=>interval==='hour'?new Date(Math.floor(time/3600000)*3600000).toISOString():date(time);
 const map=new Map(daily.map(d=>[d.date,d]));const runs=overview.runs.filter(r=>{if(r.disposition)return false;const time=Date.parse(r.startedAt);return Number.isFinite(time)&&time<=now&&map.has(bucketKey(time))});const durations:number[]=[];
 for(const run of runs){const bucket=map.get(bucketKey(Date.parse(run.startedAt)))!;bucket[run.state==='completed'?'completed':run.state==='blocked'?'failed':run.state==='stopped'?'stopped':'running']++;if(run.finishedAt){const seconds=(Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000;if(seconds>=0&&Number.isFinite(seconds))durations.push(seconds);}}
 durations.sort((a,b)=>a-b);const middle=Math.floor(durations.length/2);const completed=runs.filter(r=>r.state==='completed').length,failed=runs.filter(r=>r.state==='blocked').length,stopped=runs.filter(r=>r.state==='stopped').length,finished=completed+failed+stopped;
 const workflows:DashboardData['workflows']={running:0,waiting:0,blocked:0,stopped:0,completed:0};for(const w of overview.workflows)if(!w.disposition)workflows[w.state]++;
 const toolUsage=[...runs.reduce((m,r)=>mergeCounts(m,r.tools??[]),new Map<string,ToolCount>()).values()].sort((a,b)=>b.total-a.total||a.label.localeCompare(b.label));
 return {toolUsage,interval,checks:runs.reduce((sum,r)=>sum+r.checks,0),repeatedRuns:runs.filter(r=>r.repeating).length,runSeconds:durations.reduce((sum,n)=>sum+n,0),loadedAt:new Date(now).toISOString(),days,timezone,sampleLimit:overview.historyLimit,retentionDays,totalRuns:runs.length,completedRuns:completed,failedRuns:failed,stoppedRuns:stopped,activeRuns:runs.filter(r=>r.state==='running').length,completionRate:finished?Math.round(completed/finished*100):null,medianSeconds:durations.length?(durations.length%2?durations[middle]:(durations[middle-1]+durations[middle])/2):null,workflows,daily,tools:[]};
}
export function usageSeries(buckets:DashboardData['daily'],interval:'hour'|'day',timezone:string){
 const series=buckets.map(b=>({date:b.date,label:b.label,input:0,output:0,responses:0}));
 const map=new Map(series.map(b=>[b.date,b]));
 return {series,add(at:string,usage:NonNullable<Diagnostic['telemetry']>['usage']){const time=Date.parse(at);if(!usage||!Number.isFinite(time)||time>Date.now())return false;const key=interval==='hour'?new Date(Math.floor(time/3600000)*3600000).toISOString():new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(time);const bucket=map.get(key);if(!bucket)return false;bucket.input+=usage.input;bucket.output+=usage.output;bucket.responses++;return true;}};
}
export function dashboard(store:Store,overview:AIOverview,days:number,interval:'hour'|'day'='day'){const config=store.snapshot().config;const result=dashboardSummary(overview,days,config.timezone,config.retentionDays,Date.now(),interval);pruneLogs(store);const since=interval==='hour'?Date.parse(result.daily[0].date):Date.now()-days*86400000;result.tools=store.db.prepare("SELECT tool AS name,count(*) AS requests,sum(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors FROM diagnostics WHERE at>=? GROUP BY tool ORDER BY requests DESC").all(new Date(since).toISOString()) as DashboardData['tools'];result.health=toolHealth(store);
 const tokens=usageSeries(result.daily,interval,config.timezone);
 backfillUsage(store);
 const usage={responses:0,input:0,output:0,cacheRead:0,cacheReadReported:0,cacheWrite:0,webSearches:0,limits:[] as import('../src/telemetry-model.js').RateLimit[],limitsAt:undefined as string|undefined};
 const rows=store.db.prepare('SELECT at,provider,auth,model,input,output,cache_read,cache_write,web_searches,limits FROM model_usage WHERE at>=? ORDER BY at DESC').all(new Date(Math.min(since,Date.parse(result.daily[0].date)||since)).toISOString()) as {at:string;provider:string;auth:string;model:string;input:number;output:number;cache_read:number|null;cache_write:number|null;web_searches:number;limits:string}[];
 for(const r of rows){
  if(tokens.add(r.at,{input:r.input,output:r.output})){usage.responses++;usage.input+=r.input;usage.output+=r.output;usage.cacheRead+=r.cache_read??0;usage.cacheWrite+=r.cache_write??0;usage.webSearches+=r.web_searches;if(r.cache_read!==null)usage.cacheReadReported++;}
  if(Date.parse(r.at)>=since&&!usage.limitsAt&&r.provider===config.modelProvider&&r.auth===config.modelAuth&&r.model===config.connections.Model.scope){const limits=JSON.parse(r.limits) as typeof usage.limits;if(limits.length){usage.limits=limits;usage.limitsAt=r.at;}}
 }
 result.usage=usage;result.tokenSeries=tokens.series;return result;}

/** Copies token usage from Model log entries recorded before the usage table existed. Runs once per database. */
export function backfillUsage(store:Store){
 if(!store.key||store.get('modelUsageBackfilled'))return;
 for(const row of store.db.prepare("SELECT id,value FROM diagnostics WHERE tool='Model'").iterate()){
  try{const entry=JSON.parse(store.open(String(row.value))) as Diagnostic,t=entry.telemetry;if(t?.usage)store.recordUsage({id:String(row.id),at:entry.at,provider:t.provider,auth:t.auth,model:t.model,...t.usage,limits:t.limits});}catch{}
 }
 store.put('modelUsageBackfilled',true);
}

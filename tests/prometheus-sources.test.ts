import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import {Store} from '../server/store.js';
import {defaults,configSchema,type Config} from '../src/model.js';
import {PrometheusSources} from '../server/prometheus-sources.js';
import {Grafana} from '../server/grafana.js';
import {portForwardInput,toolboxArgs} from '../server/toolbox.js';
import {systemPrompt} from '../server/claude.js';

function fixture(edit:(c:Config)=>void=()=>{}){
 const dir=mkdtempSync(join(tmpdir(),'support-prom-')),store=new Store(dir);store.unlock('an isolated prometheus passphrase',true);
 const config:Config=structuredClone(defaults);
 config.connections.Prometheus={...config.connections.Prometheus,enabled:true};
 config.connections.Grafana={...config.connections.Grafana,enabled:true,endpoint:'https://grafana.internal'};
 config.connections.Toolbox={...config.connections.Toolbox,enabled:true};config.toolbox={...config.toolbox,allowPortForward:true};
 config.prometheusSources=[{id:'p1',name:'prometheus',kind:'url',endpoint:'https://prom.internal'},{id:'m1',name:'monitoring',kind:'tunnel',context:'monitoring',namespace:'monitoring-federation',target:'statefulset/prometheus-kps-prometheus',port:9090,pathPrefix:''}];
 edit(config);
 return {store,config,close(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
const child=()=>Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,kill(){(this as {exitCode:number|null}).exitCode=0;return true;}}) as unknown as ChildProcess;

test('sources combine URL servers, Kubernetes tunnels and Grafana datasources, each with its own URL and credential',async()=>{
 const f=fixture();f.store.credential('Grafana',JSON.stringify({v:1,scheme:'basic',username:'viewer',password:'pw'}));f.store.credential('Prometheus/p1',JSON.stringify({v:1,scheme:'bearer',token:'prom-token'}));
 const urls:{url:string;auth?:string}[]=[];let opened=0;
 const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{const u=new URL(String(input));urls.push({url:u.href,auth:(init?.headers as Record<string,string>).Authorization});
  if(u.pathname==='/api/datasources')return Response.json([{uid:'fed',name:'Federation',type:'prometheus'},{uid:'logs',name:'Loki',type:'loki'}]);
  return Response.json({status:'success',data:{result:[]}});}) as typeof fetch;
 try{
  const s=await PrometheusSources.create(f.store,f.config,fetcher,undefined,async(_c,source,port)=>{opened++;assert.equal(source.name,'monitoring');assert.ok(port>0);return child();});
  assert.deepEqual(s.names(),['prometheus','monitoring','grafana/Federation']);
  await s.query({query:'up'});
  assert.match(urls.at(-1)!.url,/^https:\/\/prom\.internal\/api\/v1\/query\?query=up/);assert.equal(urls.at(-1)!.auth,'Bearer prom-token');
  await s.query({source:'grafana/Federation',query:'up'});
  assert.match(urls.at(-1)!.url,/^https:\/\/grafana\.internal\/api\/datasources\/proxy\/uid\/fed\/api\/v1\/query\?/);
  assert.equal(urls.at(-1)!.auth,'Basic '+Buffer.from('viewer:pw').toString('base64'));
  await s.queryRange({source:'monitoring',query:'up',start:'1',end:'2',step:'60s'});
  await s.api({source:'monitoring',endpoint:'rules'});
  assert.equal(opened,1,'the tunnel is reused');
  assert.match(urls.at(-2)!.url,/^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/query_range\?/);
  await assert.rejects(s.api({source:'monitoring',endpoint:'admin/tsdb/delete_series'}));
  await assert.rejects(s.query({source:'nope',query:'up'}),/Unknown Prometheus source/);
  s.close();
 }finally{f.close()}
});

test('targets are compacted and filtered by health; label values need a label',async()=>{
 const f=fixture(c=>{c.connections.Grafana.enabled=false;c.prometheusSources=c.prometheusSources.slice(0,1);});
 let last='';
 const fetcher=(async(input:RequestInfo|URL)=>{last=String(input);return Response.json({status:'success',data:{activeTargets:[{scrapePool:'federate/a',labels:{job:'federate',instance:'a'},health:'up',lastError:''},{scrapePool:'federate/b',labels:{job:'federate',instance:'b'},health:'down',lastError:'context deadline exceeded'}],droppedTargets:[]}});}) as typeof fetch;
 try{
  const s=await PrometheusSources.create(f.store,f.config,fetcher);
  const r=await s.api({endpoint:'targets',params:{health:'down'}}) as {total:number;byHealth:Record<string,number>;targets:{instance:string;lastError?:string}[]};
  assert.equal(r.total,2);assert.deepEqual(r.byHealth,{up:1,down:1});assert.deepEqual(r.targets.map(t=>[t.instance,t.lastError]),[['b','context deadline exceeded']]);
  assert.match(last,/api\/v1\/targets\?state=active$/);
  await assert.rejects(s.api({endpoint:'label_values'}),/params.label/);
  await s.api({endpoint:'label_values',params:{label:'job'}});assert.match(last,/api\/v1\/label\/job\/values$/);
 }finally{f.close()}
});

test('tunnel sources need Toolbox port forwarding, and a Grafana failure keeps other sources',async()=>{
 const f=fixture(c=>{c.toolbox.allowPortForward=false;});
 const fetcher=(async()=>new Response('no',{status:500})) as typeof fetch;
 try{
  const s=await PrometheusSources.create(f.store,f.config,fetcher);
  assert.deepEqual(s.names(),['prometheus']);
  assert.equal(s.describe().unavailable?.length,2);
 }finally{f.close()}
});

test('Grafana lists datasources from frontend settings when listing is forbidden, and returns dashboard queries only',async()=>{
 const f=fixture();
 const fetcher=(async(input:RequestInfo|URL)=>{const u=new URL(String(input));
  if(u.pathname==='/api/datasources')return new Response('{"message":"Permission denied"}',{status:403});
  if(u.pathname==='/api/frontend/settings')return Response.json({datasources:{Fed:{uid:'fed',name:'Fed',type:'prometheus'},Loki:{uid:'l',name:'Loki',type:'loki'}}});
  if(u.pathname==='/api/dashboards/uid/abc')return Response.json({dashboard:{title:'Nodes',templating:{list:[{name:'cluster',query:'label_values(up, cluster)'}]},panels:[{title:'CPU',type:'timeseries',targets:[{expr:'rate(node_cpu_seconds_total[5m])'}]},{title:'Row',type:'row',panels:[{title:'Mem',targets:[{expr:'node_memory_MemAvailable_bytes'}]}]},{title:'Text',type:'text'}]},meta:{secret:'x'}});
  return new Response('',{status:404});}) as typeof fetch;
 try{
  const g=new Grafana(f.store,f.config,fetcher);
  assert.deepEqual(await g.prometheusDatasources(),[{uid:'fed',name:'Fed',type:'prometheus'}]);
  const d=await g.dashboard({uid:'abc'});
  assert.deepEqual(d.panels.map(p=>[p.title,p.queries[0]]),[['CPU','rate(node_cpu_seconds_total[5m])'],['Mem','node_memory_MemAvailable_bytes']]);
  assert.equal(d.variables[0].query,'label_values(up, cluster)');
  assert.ok(!JSON.stringify(d).includes('secret'));
 }finally{f.close()}
});

test('Toolbox accepts StatefulSet tunnels and named reads with a label selector',()=>{
 assert.ok(portForwardInput.parse({context:'monitoring',namespace:'monitoring-federation',target:'statefulset/prometheus-kps-prometheus',ports:['9090'],durationSeconds:60}));
 assert.throws(()=>portForwardInput.parse({context:'m',namespace:'n',target:'secret/x',ports:['1'],durationSeconds:1}));
 const config=structuredClone(defaults);config.connections.Toolbox.enabled=true;
 assert.deepEqual(toolboxArgs(config,{context:'dev',namespace:'apps',resource:'pods',name:'web-0',selector:'app=web'},'/t.json',['dev']),['--config','/t.json','kubectl','get','pods','web-0','--context','dev','--namespace','apps','-l','app=web','-o','json']);
 assert.throws(()=>toolboxArgs(config,{context:'dev',namespace:'apps',resource:'pods',selector:'a;rm -rf /'},'/t.json',['dev']));
});

test('agent instructions follow the fixed rules, and older configurations gain the new settings',()=>{
 const p=systemPrompt('Federation runs in context monitoring.');
 assert.ok(p.indexOf('untrusted data')<p.indexOf('Federation runs in context monitoring.'));
 assert.ok(!systemPrompt('  ').includes('Instructions from the engineer'));
 const old=structuredClone(defaults) as Record<string,unknown>;delete old.prometheusSources;delete old.agentInstructions;delete (old.connections as Record<string,unknown>).Grafana;
 const parsed=configSchema.parse(old);
 assert.deepEqual(parsed.prometheusSources,[]);assert.equal(parsed.agentInstructions,defaults.agentInstructions);assert.equal(parsed.connections.Grafana.enabled,false);
 const legacy=configSchema.parse({...old,connections:{...(old.connections as object),Prometheus:{endpoint:'https://prom.internal',scope:'',path:'',enabled:true}},prometheusSources:[{name:'fed',context:'monitoring',namespace:'mon',target:'service/prometheus-operated',port:9090}]});
 assert.deepEqual(legacy.prometheusSources.map(s=>[s.id,s.name,s.kind]),[['legacy','prometheus','url'],[legacy.prometheusSources[1].id,'fed','tunnel']]);
 assert.equal(legacy.connections.Prometheus.endpoint,'');assert.deepEqual(configSchema.parse(legacy),legacy,'migration is stable');
});

test('the old Prometheus credential moves to its server, and removed servers lose their credential',()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-prom-cred-')),store=new Store(dir);
 try{
  store.unlock('an isolated prometheus passphrase',true);
  store.credential('Prometheus',JSON.stringify({v:1,scheme:'basic',username:'u',password:'old-secret'}));
  const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,Prometheus:{...s.config.connections.Prometheus,enabled:true,endpoint:'https://prom.internal'}}},s.configRevision);
  store.lock();store.unlock('an isolated prometheus passphrase');
  assert.deepEqual(store.vaultStatus().credentials.filter(c=>c.startsWith('Prometheus')),['Prometheus/legacy']);
  assert.equal(store.vaultStatus().authSchemes['Prometheus/legacy'],'basic');
  assert.ok(store.secretValues().includes('old-secret'));
  const next=store.snapshot();store.config({...next.config,prometheusSources:[]},next.configRevision);
  assert.deepEqual(store.vaultStatus().credentials.filter(c=>c.startsWith('Prometheus')),[]);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a failed Toolbox read reports the reason Toolbox gave',async()=>{
 const {toolboxFailure}=await import('../server/toolbox.js');
 assert.match(toolboxFailure({code:1,stdout:JSON.stringify({context:'dev',error:'namespace "kube-system" is not allowed for context dev',redactions:0,untrusted:true})+'\n',stderr:''},'Toolbox read failed').message,/^Toolbox read failed: namespace "kube-system" is not allowed for context dev$/);
 assert.match(toolboxFailure({code:1,stdout:'',stderr:'option is not permitted. Run toolbox --help\n'},'Toolbox read failed').message,/Toolbox refused the request: option is not permitted/);
 assert.match(toolboxFailure({code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'},'Toolbox read failed').message,/larger than Support accepts/);
 assert.match(toolboxFailure({code:'ENOENT'},'Toolbox read failed').message,/SUPPORT_TOOLBOX_BINARY/);
 const stopped=new AbortController();stopped.abort();assert.equal(toolboxFailure({},'x',stopped.signal).status,409);
});

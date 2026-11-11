import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Store} from '../server/store.js';
import {defaults,type Config} from '../src/model.js';
import {PrometheusSources,serviceProxyPath} from '../server/prometheus-sources.js';
import {Grafana} from '../server/grafana.js';
import {systemPrompt} from '../server/claude.js';

function fixture(edit:(c:Config)=>void=()=>{},server='http://127.0.0.1:9'){
 const dir=mkdtempSync(join(tmpdir(),'support-prom-')),store=new Store(dir);store.unlock('an isolated prometheus passphrase',true);
 const config:Config=structuredClone(defaults);
 config.connections.Prometheus={...config.connections.Prometheus,enabled:true};
 config.connections.Grafana={...config.connections.Grafana,enabled:true,endpoint:'https://grafana.internal'};
 config.connections.Kubernetes={...config.connections.Kubernetes,enabled:true};config.kubernetesContexts=[{name:'monitoring',server,enabled:true}];
 store.credential('Kubernetes/monitoring',JSON.stringify({token:'monitoring-token'}));
 config.prometheusSources=[{id:'p1',name:'prometheus',kind:'url',endpoint:'https://prom.internal'},{id:'m1',name:'monitoring',kind:'tunnel',context:'monitoring',namespace:'monitoring-federation',target:'service/prometheus-operated',port:9090,pathPrefix:''}];
 edit(config);
 return {store,config,close(){store.close();rmSync(dir,{recursive:true,force:true})}};
}

test('sources combine URL servers, servers inside a cluster and Grafana datasources, each with its own URL and credential',async()=>{
 const proxied:{url:string;auth?:string;method?:string}[]=[];
 const api=createServer((req,res)=>{proxied.push({url:req.url??'',auth:req.headers.authorization,method:req.method});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'success',data:{result:[]}}));});
 await new Promise<void>(r=>api.listen(0,'127.0.0.1',()=>r()));
 const f=fixture(()=>{},`http://127.0.0.1:${(api.address() as {port:number}).port}`);f.store.credential('Grafana',JSON.stringify({v:1,scheme:'basic',username:'viewer',password:'pw'}));f.store.credential('Prometheus/p1',JSON.stringify({v:1,scheme:'bearer',token:'prom-token'}));
 const urls:{url:string;auth?:string}[]=[];
 const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{const u=new URL(String(input));urls.push({url:u.href,auth:(init?.headers as Record<string,string>).Authorization});
  if(u.pathname==='/api/datasources')return Response.json([{uid:'fed',name:'Federation',type:'prometheus'},{uid:'logs',name:'Loki',type:'loki'}]);
  return Response.json({status:'success',data:{result:[]}});}) as typeof fetch;
 try{
  const s=await PrometheusSources.create(f.store,f.config,fetcher);
  assert.deepEqual(s.names(),['prometheus','monitoring','grafana/Federation']);
  await s.query({query:'up'});
  assert.match(urls.at(-1)!.url,/^https:\/\/prom\.internal\/api\/v1\/query\?query=up/);assert.equal(urls.at(-1)!.auth,'Bearer prom-token');
  await s.query({source:'grafana/Federation',query:'up'});
  assert.match(urls.at(-1)!.url,/^https:\/\/grafana\.internal\/api\/datasources\/proxy\/uid\/fed\/api\/v1\/query\?/);
  assert.equal(urls.at(-1)!.auth,'Basic '+Buffer.from('viewer:pw').toString('base64'));
  await s.queryRange({source:'monitoring',query:'up',start:'1',end:'2',step:'60s'});
  await s.api({source:'monitoring',endpoint:'rules'});
  assert.equal(proxied.length,2);assert.ok(proxied.every(p=>p.method==='GET'&&p.auth==='Bearer monitoring-token'));
  assert.match(proxied[0].url,/^\/api\/v1\/namespaces\/monitoring-federation\/services\/prometheus-operated:9090\/proxy\/api\/v1\/query_range\?query=up&start=1&end=2&step=60s/);
  assert.match(proxied[1].url,/\/proxy\/api\/v1\/rules$/);
  await assert.rejects(s.api({source:'monitoring',endpoint:'admin/tsdb/delete_series'}));
  await assert.rejects(s.query({source:'nope',query:'up'}),/Unknown Prometheus source/);
  assert.equal(urls.some(u=>u.url.includes('prometheus-operated')),false,'servers inside a cluster are not read with fetch');
 }finally{f.close();api.close();}
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

test('servers inside a cluster need their Kubernetes context enabled, and a Grafana failure keeps other sources',async()=>{
 const f=fixture(c=>{c.kubernetesContexts[0].enabled=false;});
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

test('servers inside a cluster are read through the service or pod proxy of the API server',()=>{
 const source={id:'m1',name:'fed',kind:'tunnel' as const,context:'monitoring',namespace:'mon',target:'service/prometheus-operated',port:9090,pathPrefix:'/prom/'};
 assert.equal(serviceProxyPath(source,'query'),'/api/v1/namespaces/mon/services/prometheus-operated:9090/proxy/prom/api/v1/query');
 assert.equal(serviceProxyPath({...source,target:'prometheus-0',pathPrefix:''},'rules'),'/api/v1/namespaces/mon/pods/prometheus-0:9090/proxy/api/v1/rules');
 assert.throws(()=>serviceProxyPath({...source,target:'statefulset/prometheus'},'query'),/use service\/NAME or a pod name/);
});

test('agent instructions follow the fixed rules',()=>{
 const p=systemPrompt('Federation runs in context monitoring.');
 assert.ok(p.indexOf('untrusted data')<p.indexOf('Federation runs in context monitoring.'));
 assert.ok(!systemPrompt('  ').includes('Instructions from the engineer'));
});

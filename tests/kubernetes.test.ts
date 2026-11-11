import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {createServer,type IncomingHttpHeaders} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {AgentGateway} from '../server/agent-gateway.js';
import {agentKubeconfig,checkContext,enabledContexts,kubeconfigContexts,kubernetesRefusal,readKubernetes} from '../server/kubernetes.js';
import type {AgentToolset} from '../server/agent-toolset.js';

/** Fake API server: records each request and answers with a pod list, or a 401 for the wrong token. */
async function apiServer(){
 const requests:{method?:string;url?:string;headers:IncomingHttpHeaders}[]=[];
 const server=createServer((req,res)=>{
  requests.push({method:req.method,url:req.url,headers:req.headers});
  if(req.headers.authorization!=='Bearer dev-cluster-token'){res.writeHead(401,{'Content-Type':'application/json'});return res.end('{"kind":"Status","message":"Unauthorized"}');}
  if(req.url==='/version'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"gitVersion":"v1.34.2"}');}
  res.writeHead(200,{'Content-Type':'application/json','Audit-Id':'abc'});
  res.end(JSON.stringify({kind:'PodList',items:[{metadata:{name:'web',managedFields:[{manager:'kubectl'}]}}]}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
 return {requests,url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,close(){server.close();}};
}
function fixture(server:string){
 const dir=mkdtempSync(join(tmpdir(),'support-kubernetes-'));const store=new Store(dir);store.unlock('long test passphrase',true);
 const s=store.snapshot();
 store.config({...s.config,connections:{...s.config.connections,Kubernetes:{...s.config.connections.Kubernetes,enabled:true}},kubernetesContexts:[{name:'dev',server,enabled:true},{name:'prod',server,enabled:false},{name:'notoken',server,enabled:true}]},s.configRevision);
 store.credential('Kubernetes/dev',JSON.stringify({token:'dev-cluster-token'}));
 store.credential('Kubernetes/prod',JSON.stringify({token:'prod-cluster-token'}));
 return {store,done(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
const toolset={definitions:[],async run(){throw new Error('unused');}} as unknown as AgentToolset;

test('the gateway refuses writes, upgrades and exec, attach, portforward and proxy subresources',()=>{
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.match(kubernetesRefusal(method,'/api/v1/namespaces/a/pods',{})??'',/read-only/);
 assert.match(kubernetesRefusal('GET','/api/v1/namespaces/a/pods/web/exec',{upgrade:'websocket',connection:'Upgrade'})??'',/upgrades/);
 for(const path of ['/api/v1/namespaces/a/pods/web/exec','/api/v1/namespaces/a/pods/web/attach','/api/v1/namespaces/a/pods/web/portforward','/api/v1/namespaces/a/services/s:80/proxy/x','/api/v1/nodes/n1/proxy/metrics','/api/v1/namespaces/a/pods/web%2Fexec','/api/v1/proxy/namespaces/a/services/s'])assert.ok(kubernetesRefusal('GET',path,{}),path);
 for(const path of ['/api/v1/namespaces/a/pods','/api/v1/namespaces/a/pods/web/log','/apis/apps/v1/namespaces/a/deployments/proxy','/api/v1/namespaces/a/configmaps/exec','/version','/openapi/v3'])assert.equal(kubernetesRefusal('GET',path,{}),undefined,path);
 assert.equal(kubernetesRefusal('HEAD','/api',{}),undefined);
});

test('the agent kubeconfig lists enabled contexts with a token, pointing at the gateway, without credentials',()=>{
 const f=fixture('https://dev.internal:6443');
 try{
  assert.deepEqual(enabledContexts(f.store,f.store.snapshot().config).map(c=>c.name),['dev']);
  const k=JSON.parse(agentKubeconfig('http://172.31.251.10:7072/TOKEN',['dev','arn:aws:eks:eu-west-3:1:cluster/prod']));
  assert.deepEqual(k.clusters.map((c:{cluster:{server:string}})=>c.cluster.server),['http://172.31.251.10:7072/TOKEN/k8s/dev','http://172.31.251.10:7072/TOKEN/k8s/arn%3Aaws%3Aeks%3Aeu-west-3%3A1%3Acluster%2Fprod']);
  assert.equal(k['current-context'],'dev');assert.deepEqual(k.users,[{name:'support',user:{}}]);
 }finally{f.done()}
});

test('the gateway forwards agent reads with the context token and drops client credentials and impersonation',async()=>{
 const api=await apiServer(),f=fixture(api.url),gw=new AgentGateway(f.store,fetch);
 try{
  await gw.listen('127.0.0.1',0);
  const session=gw.register({runId:'r1',toolset});
  const kubeconfig=await (await fetch(`${session.url}/kubeconfig`)).json() as {clusters:{name:string;cluster:{server:string}}[]};
  assert.deepEqual(kubeconfig.clusters.map(c=>c.name),['dev']);
  const base=kubeconfig.clusters[0].cluster.server;
  const ok=await fetch(`${base}/api/v1/namespaces/apps/pods?limit=1`,{headers:{Authorization:'Bearer stolen','Impersonate-User':'system:admin',Accept:'application/json'}});
  assert.equal(ok.status,200);assert.equal(ok.headers.get('audit-id'),'abc');
  assert.equal(((await ok.json()) as {items:unknown[]}).items.length,1);
  const seen=api.requests.at(-1)!;
  assert.equal(seen.url,'/api/v1/namespaces/apps/pods?limit=1');assert.equal(seen.headers.authorization,'Bearer dev-cluster-token');assert.equal(seen.headers['impersonate-user'],undefined);
  const count=api.requests.length;
  const post=await fetch(`${base}/api/v1/namespaces/apps/pods`,{method:'POST',body:'{}'});
  assert.equal(post.status,403);assert.match(((await post.json()) as {message:string}).message,/read-only/);
  const exec=await fetch(`${base}/api/v1/namespaces/apps/pods/web/exec?command=sh`);
  assert.equal(exec.status,403);await exec.body?.cancel();
  for(const context of ['prod','notoken','missing']){const r=await fetch(`${session.url}/k8s/${context}/api/v1/pods`);assert.equal(r.status,404,context);assert.match(((await r.json()) as {message:string}).message,/not enabled in Support/);}
  assert.equal(api.requests.length,count,'refused requests never reach the API server');
  gw.release(session.token);
  assert.equal((await fetch(`${base}/api/v1/pods`)).status,403);
 }finally{gw.close();api.close();f.done();}
});

test('kubernetes_read and the context check use the saved token and report API errors',async()=>{
 const api=await apiServer(),f=fixture(api.url);
 try{
  const config=f.store.snapshot().config;
  const pods=await readKubernetes(f.store,config,{context:'dev',path:'/api/v1/namespaces/apps/pods'}) as {items:{metadata:Record<string,unknown>}[]};
  assert.equal(pods.items[0].metadata.name,'web');assert.equal('managedFields' in pods.items[0].metadata,false);
  await assert.rejects(readKubernetes(f.store,config,{context:'dev',path:'/api/v1/namespaces/apps/pods/web/exec'}),/subresources are refused/);
  await assert.rejects(readKubernetes(f.store,config,{context:'dev',path:'/healthz'}),/Use an API path/);
  await assert.rejects(readKubernetes(f.store,config,{context:'prod',path:'/api/v1/pods'}),/not enabled/);
  assert.deepEqual(await checkContext(f.store,config,'dev'),{ok:true,detail:'dev: Kubernetes v1.34.2.'});
  f.store.credential('Kubernetes/dev',JSON.stringify({token:'wrong'}));
  assert.match((await checkContext(f.store,config,'dev')).detail,/rejected the token/);
 }finally{api.close();f.done();}
});

test('kubeconfig contexts keep bearer tokens and explain every other sign-in method',()=>{
 const contexts=kubeconfigContexts({
  clusters:[{name:'c',cluster:{server:'https://c.internal','certificate-authority-data':Buffer.from('-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----').toString('base64')}},{name:'noserver',cluster:{}}],
  users:[{name:'sa',user:{token:'sa-token'}},{name:'exec',user:{exec:{command:'kubelogin'}}},{name:'cert',user:{'client-certificate-data':'x','client-key-data':'y'}},{name:'oidc',user:{'auth-provider':{name:'oidc'}}},{name:'file',user:{tokenFile:'/t'}}],
  contexts:[{name:'sa',context:{cluster:'c',user:'sa'}},{name:'exec',context:{cluster:'c',user:'exec'}},{name:'cert',context:{cluster:'c',user:'cert'}},{name:'oidc',context:{cluster:'c',user:'oidc'}},{name:'file',context:{cluster:'c',user:'file'}},{name:'noserver',context:{cluster:'noserver',user:'sa'}},{name:'bad name',context:{cluster:'c',user:'sa'}}],
 });
 assert.equal(contexts[0].secret?.token,'sa-token');assert.match(contexts[0].secret?.ca??'',/BEGIN CERTIFICATE/);
 assert.deepEqual(contexts.slice(1).map(c=>[c.name,c.secret,/Not supported/.test(c.unsupported??'')]),[['exec',undefined,true],['cert',undefined,true],['oidc',undefined,true],['file',undefined,true],['noserver',undefined,true],['bad name',undefined,true]]);
 assert.match(contexts[1].unsupported!,/exec plugin/);assert.match(contexts[2].unsupported!,/client certificate/);
});

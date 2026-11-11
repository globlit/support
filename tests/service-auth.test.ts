import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {Alertmanager} from '../server/alertmanager.js';
import {serviceProbe} from '../server/health-poller.js';
import {credentialInput,parseServiceAuth,serviceAuthHeaders,storedCredential} from '../server/service-auth.js';

const basic=(username:string,password:string)=>'Basic '+Buffer.from(username+':'+password,'utf8').toString('base64');
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'support-service-auth-')),store=new Store(dir);store.unlock('temporary test passphrase',true);
 const s=store.snapshot();
 store.config({...s.config,connections:{...s.config.connections,Alertmanager:{enabled:true,endpoint:'https://alerts.internal',scope:'',path:''},Prometheus:{enabled:true,endpoint:'https://metrics.internal',scope:'',path:''}}},s.configRevision);
 const save=(input:unknown)=>{const v=credentialInput.parse(input);if('remove' in v)return store.removeCredential(v.name);if('kubernetes' in v)return store.credential(v.name,JSON.stringify(v.kubernetes));return store.credential(v.name,storedCredential(v));};
 return {store,save,done(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('stored credentials produce Bearer and Basic headers, and legacy tokens stay bearer',()=>{
 const f=fixture();try{
  assert.deepEqual(serviceAuthHeaders(f.store,'Alertmanager'),{});
  f.store.credential('Alertmanager','legacy-token');
  assert.deepEqual(serviceAuthHeaders(f.store,'Alertmanager'),{Authorization:'Bearer legacy-token'});
  f.save({name:'Alertmanager',value:'new-token'});
  assert.equal(parseServiceAuth(f.store.readCredential('Alertmanager')).scheme,'bearer');
  assert.deepEqual(serviceAuthHeaders(f.store,'Alertmanager'),{Authorization:'Bearer new-token'});
  f.save({name:'Prometheus',basic:{username:'support',password:'pässword with spaces'}});
  assert.deepEqual(serviceAuthHeaders(f.store,'Prometheus'),{Authorization:basic('support','pässword with spaces')});
  assert.deepEqual(f.store.vaultStatus().authSchemes,{Alertmanager:'bearer',Prometheus:'basic'});
  f.store.lock();assert.deepEqual(f.store.vaultStatus().authSchemes,{});
 }finally{f.done();}
});

test('credential requests reject invalid Basic auth and limit Basic auth and removal to Alertmanager and Prometheus',()=>{
 assert.throws(()=>credentialInput.parse({name:'Alertmanager',basic:{username:'a:b',password:'x'}}),/Username must not contain/);
 assert.throws(()=>credentialInput.parse({name:'Alertmanager',basic:{username:'user',password:'a\nb'}}),/control characters/);
 assert.throws(()=>credentialInput.parse({name:'Alertmanager',basic:{username:'',password:'x'}}));
 assert.throws(()=>credentialInput.parse({name:'GitLab',basic:{username:'user',password:'x'}}));
 assert.throws(()=>credentialInput.parse({name:'GitLab',remove:true}));
 assert.throws(()=>credentialInput.parse({name:'Alertmanager',value:'x',remove:true}));
 assert.equal(storedCredential(credentialInput.parse({name:'GitLab',value:'plain'}) as {name:'GitLab';value:string}),'plain');
});

test('Basic auth secrets are redacted and removal clears the credential',()=>{
 const f=fixture();try{
  f.save({name:'Alertmanager',basic:{username:'support',password:'proxy-password-123'}});
  const secrets=f.store.secretValues(),encoded=basic('support','proxy-password-123').slice(6);
  for(const value of ['proxy-password-123','support:proxy-password-123',encoded])assert.ok(secrets.includes(value),value);
  const epoch=f.store.credentialEpoch;f.save({name:'Alertmanager',remove:true});
  assert.ok(f.store.credentialEpoch>epoch);assert.ok(!f.store.vaultStatus().credentials.includes('Alertmanager'));
  assert.deepEqual(serviceAuthHeaders(f.store,'Alertmanager'),{});
 }finally{f.done();}
});

test('Alertmanager polling and API health checks send the saved Basic auth header',async()=>{
 const f=fixture();try{
  f.save({name:'Alertmanager',basic:{username:'support',password:'proxy-password-123'}});
  f.save({name:'Prometheus/legacy',basic:{username:'metrics',password:'other-password'}});
  const seen:Record<string,string|undefined>={};
  const fetcher=(async(url,options)=>{const u=new URL(String(url));seen[u.hostname+u.pathname]=(options?.headers as Record<string,string>).Authorization;return u.pathname.endsWith('/alerts')?Response.json([]):u.pathname==='/api/v2/status'?Response.json({versionInfo:{}}):u.pathname==='/api/v1/status/buildinfo'?Response.json({status:'success'}):new Response('OK');}) as typeof fetch;
  await new Alertmanager(f.store,fetcher).poll();
  assert.equal(seen['alerts.internal/api/v2/alerts'],basic('support','proxy-password-123'));
  const probe=serviceProbe(f.store,fetcher),config=f.store.snapshot().config;
  assert.equal((await probe('Alertmanager',config,new AbortController().signal)).ok,true);
  assert.equal((await probe('Prometheus',config,new AbortController().signal)).ok,true);
  assert.equal(seen['alerts.internal/api/v2/status'],basic('support','proxy-password-123'));
  assert.equal(seen['metrics.internal/api/v1/status/buildinfo'],basic('metrics','other-password'));
 }finally{f.done();}
});

test('Kubernetes context tokens are saved per context, validated, redacted, and deleted with their context',()=>{
 assert.ok(credentialInput.parse({name:'Kubernetes/arn:aws:eks:eu-west-3:1:cluster/prod',kubernetes:{token:'eyJ.token',ca:'-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'}}));
 assert.throws(()=>credentialInput.parse({name:'Kubernetes/dev',kubernetes:{token:'two words'}}),/spaces/);
 assert.throws(()=>credentialInput.parse({name:'Kubernetes/dev',kubernetes:{token:'t',ca:'not a certificate'}}),/PEM/);
 assert.throws(()=>credentialInput.parse({name:'Kubernetes/../x',kubernetes:{token:'t'}}));
 assert.throws(()=>credentialInput.parse({name:'Kubernetes',value:'token'}));
 assert.throws(()=>credentialInput.parse({name:'Toolbox',remove:true}));
 const f=fixture();try{
  const s=f.store.snapshot();f.store.config({...s.config,kubernetesContexts:[{name:'dev',server:'https://dev.internal:6443',enabled:true}]},s.configRevision);
  f.save({name:'Kubernetes/dev',kubernetes:{token:'kube-secret-token-123'}});
  f.store.credential('Toolbox','{"v":1}');
  assert.ok(f.store.secretValues().includes('kube-secret-token-123'));
  const next=f.store.snapshot();f.store.config({...next.config,kubernetesContexts:[]},next.configRevision);
  assert.deepEqual(f.store.vaultStatus().credentials.filter(c=>c.startsWith('Kubernetes')||c==='Toolbox'),[]);
 }finally{f.done();}
});


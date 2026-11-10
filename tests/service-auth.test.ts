import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {Alertmanager} from '../server/alertmanager.js';
import {serviceProbe} from '../server/health-poller.js';
import {credentialInput,parseServiceAuth,serviceAuthHeaders,storedCredential} from '../server/service-auth.js';
import {kubeconfigSecrets,resolveToolboxConfig} from '../server/toolbox-config.js';
import {readToolbox,toolboxFiles} from '../server/toolbox.js';

const basic=(username:string,password:string)=>'Basic '+Buffer.from(username+':'+password,'utf8').toString('base64');
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'support-service-auth-')),store=new Store(dir);store.unlock('temporary test passphrase',true);
 const s=store.snapshot();
 store.config({...s.config,connections:{...s.config.connections,Alertmanager:{enabled:true,endpoint:'https://alerts.internal',scope:'',path:''},Prometheus:{enabled:true,endpoint:'https://metrics.internal',scope:'',path:''}}},s.configRevision);
 const save=(input:unknown)=>{const v=credentialInput.parse(input);if('remove' in v)return store.removeCredential(v.name);if('toolbox' in v)throw new Error('The server generates Toolbox credentials.');return store.credential(v.name,storedCredential(v));};
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

const kubeconfig='apiVersion: v1\nkind: Config\nusers:\n- name: dev\n  user:\n    token: kube-secret-token-123\n';
/** Vault value of a configuration pasted before generation existed (format v1). */
const legacyToolbox=JSON.stringify({v:1,toolboxConfig:'{"kubeconfig":"{{kubeconfig}}"}',kubeconfig});
test('Toolbox save requests take a kubeconfig and contexts, and refuse custom configurations',()=>{
 assert.ok(credentialInput.parse({name:'Toolbox',toolbox:{kubeconfig,contexts:['dev','prod']}}));
 assert.throws(()=>credentialInput.parse({name:'Toolbox',value:'/path/toolbox.json'}));
 assert.throws(()=>credentialInput.parse({name:'Toolbox',toolbox:{config:'{"kubeconfig":"{{kubeconfig}}"}',kubeconfig}}));
 assert.throws(()=>credentialInput.parse({name:'Toolbox',toolbox:{kubeconfig,contexts:[]}}),/Select at least one context/);
 assert.throws(()=>credentialInput.parse({name:'Toolbox',toolbox:{kubeconfig:'  ',contexts:['dev']}}),/Paste the kubeconfig/);
 assert.ok(credentialInput.parse({name:'Toolbox',remove:true}));assert.ok(credentialInput.parse({name:'Outline',remove:true}));
});

test('Toolbox configuration points at the pasted kubeconfig by placeholder or by its single kubeconfig field',()=>{
 assert.deepEqual(JSON.parse(resolveToolboxConfig('{"a":{"path":"{{kubeconfig}}"},"kubeconfig":"/old"}','/tmp/x/kubeconfig')),{a:{path:'/tmp/x/kubeconfig'},kubeconfig:'/old'});
 assert.deepEqual(JSON.parse(resolveToolboxConfig('{"cluster":{"kubeconfig_path":"/old"},"name":"dev"}','/tmp/x/kubeconfig')),{cluster:{kubeconfig_path:'/tmp/x/kubeconfig'},name:'dev'});
 assert.deepEqual(JSON.parse(resolveToolboxConfig('{"name":"dev"}','/tmp/x/kubeconfig')),{name:'dev'});
 assert.deepEqual(kubeconfigSecrets(kubeconfig),['kube-secret-token-123']);
});

test('a Toolbox configuration pasted before generation existed stays readable, redacted and removable',()=>{
 const f=fixture();try{
  f.store.credential('Toolbox',legacyToolbox);
  assert.equal(toolboxFiles(f.store)?.kubeconfig,kubeconfig);
  assert.ok(f.store.secretValues().includes('kube-secret-token-123'));
  f.save({name:'Toolbox',remove:true});assert.equal(toolboxFiles(f.store),null);
 }finally{f.done();}
});

test('Toolbox runs with private temporary files from the pasted configuration and deletes them',{skip:process.platform!=='linux'},async()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'support-toolbox-test-')),record=join(dir,'record'),binary=join(dir,'toolbox'),previous=process.env.SUPPORT_TOOLBOX_BINARY;
 writeFileSync(binary,`#!/bin/sh\ncfg="$2"\n{ printf '%s\\n' "$cfg"; stat -c %a "$(dirname "$cfg")" "$cfg" "$KUBECONFIG"; cat "$cfg"; } > '${record}'\n[ -f '${join(dir,'fail')}' ] && exit 1\necho '{"items":[]}'\n`,{mode:0o700});
 process.env.SUPPORT_TOOLBOX_BINARY=binary;
 try{
  const s=f.store.snapshot();f.store.config({...s.config,connections:{...s.config.connections,Toolbox:{enabled:true,endpoint:'',scope:'dev',path:'/missing/toolbox.json'}}},s.configRevision);
  f.store.credential('Toolbox',legacyToolbox);
  const config=f.store.snapshot().config,input={context:'dev',namespace:'apps',resource:'pods'};
  assert.deepEqual(await readToolbox(config,input,new AbortController().signal,toolboxFiles(f.store)),{items:[]});
  const [cfg,dirMode,cfgMode,kubeMode,...json]=readFileSync(record,'utf8').trim().split('\n');
  assert.notEqual(cfg,'/missing/toolbox.json');assert.deepEqual([dirMode,cfgMode,kubeMode],['700','600','600']);
  assert.deepEqual(JSON.parse(json.join('\n')),{kubeconfig:join(dirname(cfg),'kubeconfig')});
  assert.equal(existsSync(dirname(cfg)),false);
  writeFileSync(join(dir,'fail'),'');
  await assert.rejects(readToolbox(config,input,new AbortController().signal,toolboxFiles(f.store)),/Toolbox read failed/);
  assert.equal(existsSync(dirname(readFileSync(record,'utf8').split('\n')[0])),false);
 }finally{if(previous===undefined)delete process.env.SUPPORT_TOOLBOX_BINARY;else process.env.SUPPORT_TOOLBOX_BINARY=previous;rmSync(dir,{recursive:true,force:true});f.done();}
});

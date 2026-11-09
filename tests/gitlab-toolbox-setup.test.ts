import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {gitLabProjects,projectPath} from '../server/gitlab.js';
import {generateToolboxConfig,mergeKubeconfigs,probeToolboxContexts} from '../server/toolbox.js';
import {defaults} from '../src/model.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-gitlab-'));const store=new Store(dir);store.unlock('gitlab-test-passphrase',true);store.credential('GitLab','private-test-value');const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,GitLab:{enabled:true,endpoint:'https://git.internal',scope:'',path:''}}},s.configRevision);return {store,close(){store.close();rmSync(dir,{recursive:true,force:true})}};}

test('GitLab projects come from the token membership, with default branches and an optional search',async()=>{const f=fixture();try{
 const urls:string[]=[];
 const projects=await gitLabProjects(f.store,async(url,init)=>{urls.push(String(url));assert.equal((init?.headers as Record<string,string>)['PRIVATE-TOKEN'],'private-test-value');return Response.json([{path_with_namespace:'infra/flux',name:'flux',default_branch:'main',visibility:'private'},{path_with_namespace:'infra/empty',name:'empty',default_branch:null}]);},'infra/fl');
 assert.deepEqual(projects,[{project:'infra/flux',name:'flux',defaultBranch:'main'},{project:'infra/empty',name:'empty',defaultBranch:null}]);
 const u=new URL(urls[0]);assert.equal(u.pathname,'/api/v4/projects');
 for(const [key,value] of Object.entries({membership:'true',archived:'false',per_page:'100',search:'infra/fl',search_namespaces:'true'}))assert.equal(u.searchParams.get(key),value,key);
 await gitLabProjects(f.store,async url=>{assert.equal(new URL(String(url)).searchParams.has('search'),false);return Response.json([]);});
 const s=f.store.snapshot();f.store.config({...s.config,connections:{...s.config.connections,GitLab:{...s.config.connections.GitLab,enabled:false}}},s.configRevision);
 await assert.rejects(gitLabProjects(f.store,async()=>Response.json([])),/Enable GitLab/);
}finally{f.close()}});

test('GitLab project paths need a namespace and no dot-leading segment',()=>{
 for(const value of ['group/project','group/sub/project.name','g_1/p-2'])assert.equal(projectPath.safeParse(value).success,true,value);
 for(const value of ['project','../group/project','group/.hidden','group//project','group/project/'])assert.equal(projectPath.safeParse(value).success,false,value);
});

test('Toolbox configuration generation uses the kubeconfig placeholder and removes its temporary files',{skip:process.platform!=='linux'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-toolbox-fake-')),seen=join(dir,'seen'),script=join(dir,'toolbox'),previous=process.env.SUPPORT_TOOLBOX_BINARY;
 writeFileSync(script,`#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --path) out=$2; shift;; --kubeconfig) kc=$2; shift;; esac; shift; done
echo "$kc" > "${seen}"
grep -q 'name: dev-ctx' "$kc" || exit 3
printf '{"kubectl":{"binary":"/usr/local/bin/kubectl","kubeconfig":"%s","contexts":[{"name":"dev-ctx","namespaces":["default"]}]},"redaction":{"literals":[],"patterns":[]}}' "$kc" > "$out"
`,{mode:0o700});
 process.env.SUPPORT_TOOLBOX_BINARY=script;
 try{
  const result=await generateToolboxConfig('contexts:\n- name: dev-ctx\n');
  const config=JSON.parse(result.config);
  assert.equal(config.kubectl.kubeconfig,'{{kubeconfig}}');assert.deepEqual(result.contexts,['dev-ctx']);assert.deepEqual(config.redaction,{literals:[],patterns:[]});
  const kubeconfigPath=readFileSync(seen,'utf8').trim();assert.ok(!result.config.includes(kubeconfigPath));assert.equal(existsSync(kubeconfigPath),false);
  await assert.rejects(generateToolboxConfig('contexts: []\n'),/could not generate/);
  writeFileSync(script,`#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --path) out=$2; shift;; esac; shift; done
printf '{"kubectl":{"kubeconfig":"/x","context":"only-ctx","contexts":null}}' > "$out"
`,{mode:0o700});
  assert.deepEqual((await generateToolboxConfig('contexts:\n- name: only-ctx\n')).contexts,['only-ctx']);
 }finally{if(previous===undefined)delete process.env.SUPPORT_TOOLBOX_BINARY;else process.env.SUPPORT_TOOLBOX_BINARY=previous;rmSync(dir,{recursive:true,force:true});}
});

const kubectlPath=process.env.SUPPORT_KUBECTL_BINARY??'/usr/local/bin/kubectl';
const kubeconfig=(cluster:string,user:string,token:string,context:string,extra='')=>`apiVersion: v1
kind: Config
clusters:
- name: ${cluster}
  cluster: {server: https://${cluster}.example.invalid:6443${extra}}
users:
- name: ${user}
  user: {token: ${token}}
contexts:
- name: ${context}
  context: {cluster: ${cluster}, user: ${user}}
current-context: ${context}
`;
test('kubeconfig files merge into one self-contained kubeconfig, and conflicting names are rejected',{skip:process.platform!=='linux'||!existsSync(kubectlPath)},async()=>{
 const merged=await mergeKubeconfigs([{name:'dev.yaml',content:kubeconfig('dev','dev-reader','tok-dev','dev-ctx')},{name:'prod.yaml',content:kubeconfig('prod','prod-reader','tok-prod','prod-ctx')}]);
 assert.deepEqual(merged.contexts,['dev-ctx','prod-ctx']);
 for(const text of ['name: dev-ctx','name: prod-ctx','token: tok-dev','token: tok-prod','current-context: dev-ctx'])assert.ok(merged.kubeconfig.includes(text),text);
 const same=await mergeKubeconfigs([{name:'a.yaml',content:kubeconfig('dev','reader','tok','dev-ctx')},{name:'b.yaml',content:kubeconfig('dev','reader','tok','dev-ctx')}]);
 assert.deepEqual(same.contexts,['dev-ctx']);
 await assert.rejects(mergeKubeconfigs([{name:'a.yaml',content:kubeconfig('dev','reader','tok-dev','dev-ctx')},{name:'b.yaml',content:kubeconfig('prod','reader','tok-prod','prod-ctx')}]),/User "reader" is defined differently in a\.yaml and b\.yaml/);
 await assert.rejects(mergeKubeconfigs([{name:'broken.yaml',content:'not: [valid'}]),e=>/broken\.yaml is not a valid kubeconfig/.test(String(e))&&!/support-kubeconfig-merge-/.test(String(e)));
 await assert.rejects(mergeKubeconfigs([{name:'paths.yaml',content:kubeconfig('dev','reader','tok','dev-ctx',', certificate-authority: /nonexistent/ca.crt')}]),/Embed certificates and keys with the \*-data fields/);
});

test('the Toolbox probe reads /version from each allowed context and reports the first failure',{skip:process.platform!=='linux'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-toolbox-probe-')),script=join(dir,'toolbox'),configPath=join(dir,'toolbox.json'),previous=process.env.SUPPORT_TOOLBOX_BINARY;
 writeFileSync(configPath,'{}');
 writeFileSync(script,`#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --context) ctx=$2; shift;; esac; shift; done
case "$ctx" in
 dev) echo '{"major":"1","minor":"34","gitVersion":"v1.34.2"}';;
 down) echo '{"context":"down","error":"tool request failed","untrusted":true}';;
 *) echo 'raw path is not permitted';;
esac
`,{mode:0o700});
 process.env.SUPPORT_TOOLBOX_BINARY=script;
 const config=(scope:string)=>{const c=structuredClone(defaults);c.connections.Toolbox={...c.connections.Toolbox,enabled:true,path:configPath,scope};return c;};
 try{
  assert.deepEqual(await probeToolboxContexts(config('dev'),null,new AbortController().signal),{ok:true,detail:'Toolbox reached the Kubernetes API in dev (Kubernetes v1.34.2).'});
  const down=await probeToolboxContexts(config('dev, down'),null,new AbortController().signal);assert.equal(down.ok,false);assert.match(down.detail,/Context down could not be reached \(tool request failed\)/);
  const refused=await probeToolboxContexts(config('other'),null,new AbortController().signal);assert.equal(refused.ok,false);assert.match(refused.detail,/refused the check for context other: raw path is not permitted/);
  assert.match((await probeToolboxContexts(config(''),null,new AbortController().signal)).detail,/Allowed context names/);
 }finally{if(previous===undefined)delete process.env.SUPPORT_TOOLBOX_BINARY;else process.env.SUPPORT_TOOLBOX_BINARY=previous;rmSync(dir,{recursive:true,force:true});}
});

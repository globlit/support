import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {gitLabProjects,projectPath} from '../server/gitlab.js';
import {importKubeconfigs} from '../server/kubernetes.js';

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
test('kubeconfig import merges files, returns token contexts with their CA, and lists the others with a reason',{skip:process.platform!=='linux'||!existsSync(kubectlPath)},async()=>{
 const contexts=await importKubeconfigs([{name:'dev.yaml',content:kubeconfig('dev','dev-reader','tok-dev','dev-ctx',', certificate-authority-data: '+Buffer.from('-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n').toString('base64'))},{name:'prod.yaml',content:kubeconfig('prod','prod-reader','tok-prod','prod-ctx')}]);
 assert.deepEqual(contexts.map(c=>[c.name,c.server,c.secret?.token]),[['dev-ctx','https://dev.example.invalid:6443','tok-dev'],['prod-ctx','https://prod.example.invalid:6443','tok-prod']]);
 assert.match(contexts[0].secret?.ca??'',/^-----BEGIN CERTIFICATE-----/);
 const exec=`apiVersion: v1\nkind: Config\nclusters:\n- name: oidc\n  cluster: {server: https://oidc.example.invalid}\nusers:\n- name: sso\n  user:\n    exec: {apiVersion: client.authentication.k8s.io/v1, command: kubelogin}\ncontexts:\n- name: oidc-ctx\n  context: {cluster: oidc, user: sso}\n`;
 const [unsupported]=await importKubeconfigs([{name:'sso.yaml',content:exec}]);
 assert.equal(unsupported.secret,undefined);assert.match(unsupported.unsupported??'',/exec plugin/);
 const same=await importKubeconfigs([{name:'a.yaml',content:kubeconfig('dev','reader','tok','dev-ctx')},{name:'b.yaml',content:kubeconfig('dev','reader','tok','dev-ctx')}]);
 assert.deepEqual(same.map(c=>c.name),['dev-ctx']);
 await assert.rejects(importKubeconfigs([{name:'a.yaml',content:kubeconfig('dev','reader','tok-dev','dev-ctx')},{name:'b.yaml',content:kubeconfig('prod','reader','tok-prod','prod-ctx')}]),/User "reader" is defined differently in a\.yaml and b\.yaml/);
 await assert.rejects(importKubeconfigs([{name:'broken.yaml',content:'not: [valid'}]),e=>/broken\.yaml is not a valid kubeconfig/.test(String(e))&&!/support-kubeconfig-/.test(String(e)));
 await assert.rejects(importKubeconfigs([{name:'paths.yaml',content:kubeconfig('dev','reader','tok','dev-ctx',', certificate-authority: /nonexistent/ca.crt')}]),/Embed certificates with the \*-data fields/);
});

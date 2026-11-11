import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {readTools} from '../server/agent-tools.js';
import type {YouTrack} from '../server/youtrack.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'support-gls-')),store=new Store(dir);store.unlock('an isolated gitlab search passphrase',true);store.credential('GitLab','glpat-x');
 const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,GitLab:{...s.config.connections.GitLab,enabled:true,endpoint:'https://gitlab.internal'}}},s.configRevision);
 return {store,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('code search without a project uses instance search, and falls back to recent projects without advanced search',async()=>{
 const f=fixture();
 try{
  const paths:string[]=[];let advanced=true;
  const fetcher=(async(input:RequestInfo|URL)=>{const u=new URL(String(input));paths.push(u.pathname);
   if(u.pathname==='/api/v4/search')return advanced?Response.json([{path:'np.yaml',startline:3,data:'host: netpol.sahar.fr',project_id:7}]):new Response('{"message":"Scope not supported"}',{status:400});
   if(u.pathname==='/api/v4/projects/7')return Response.json({path_with_namespace:'infra/net'});
   if(u.pathname==='/api/v4/projects')return Response.json([{path_with_namespace:'infra/net',name:'net'},{path_with_namespace:'apps/web',name:'web'}]);
   if(u.pathname.endsWith('/search'))return Response.json(u.pathname.includes('infra%2Fnet')||u.pathname.includes('infra/net')?[{path:'np.yaml',startline:3,data:'netpol.sahar.fr'}]:[]);
   return new Response('',{status:404});}) as typeof fetch;
  const tools=readTools(f.store,f.store.snapshot().config,{} as YouTrack,fetcher);
  const global=await tools.run('gitlab_search',{project:'',query:'netpol.sahar.fr'}) as {matches:{project?:string;path:string}[]};
  assert.deepEqual(global.matches.map(m=>[m.project,m.path]),[['infra/net','np.yaml']]);
  advanced=false;
  const fallback=await tools.run('gitlab_search',{query:'netpol.sahar.fr'}) as {scope:string;matches:{project?:string}[]};
  assert.match(fallback.scope,/2 most recently active projects/);assert.deepEqual(fallback.matches.map(m=>m.project),['infra/net']);
  const one=await tools.run('gitlab_search',{project:'infra/net',query:'netpol'}) as unknown[];assert.equal(one.length,1);
  await assert.rejects(tools.run('gitlab_search',{project:'../x',query:'a'}));
 }finally{f.close()}
});

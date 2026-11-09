import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {defaults,type Config} from '../src/model.js';
import {OutlineReader,outlineAvailable,outlineTextLimit} from '../server/outline.js';

function fixture(scope:string){
 const dir=mkdtempSync(join(tmpdir(),'support-outline-')),store=new Store(dir);store.unlock('an isolated outline passphrase',true);
 const config:Config=structuredClone(defaults);config.connections.Outline={...config.connections.Outline,enabled:true,endpoint:'https://outline.internal',scope};
 return {store,config,close(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
const allowed='3f1c2b7a-9d4e-4a10-b2c3-0123456789ab',other='9a8b7c6d-1111-4222-8333-444455556666';

test('Outline tools need an enabled connection, a collection and a saved API key',()=>{
 const f=fixture('DevOps');
 try{
  assert.equal(outlineAvailable(f.store,f.config),false);
  f.store.credential('Outline','outline-key');assert.equal(outlineAvailable(f.store,f.config),true);
  assert.equal(outlineAvailable(f.store,{...f.config,connections:{...f.config.connections,Outline:{...f.config.connections.Outline,scope:' '}}}),false);
  assert.equal(outlineAvailable(f.store,{...f.config,connections:{...f.config.connections,Outline:{...f.config.connections.Outline,enabled:false}}}),false);
 }finally{f.close()}
});

test('Outline search and read stay inside the allowed collection',async()=>{
 const f=fixture('devops');f.store.credential('Outline','outline-key');
 const calls:{path:string;body:any;auth:string}[]=[];
 const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input)),body=JSON.parse(String(init?.body));calls.push({path:url.pathname,body,auth:(init?.headers as Record<string,string>).Authorization});
  if(url.pathname==='/api/collections.list')return Response.json({data:[{id:allowed,urlId:'AbC123xyz9',name:'DevOps'}]});
  if(url.pathname==='/api/documents.search')return Response.json({data:[{context:'restart the <b>ingress</b>',document:{id:'d1',title:'Ingress runbook',url:'/doc/ingress-d1',collectionId:allowed}},{document:{id:'d2',title:'Elsewhere',collectionId:other}}]});
  if(url.pathname==='/api/documents.info')return Response.json({data:body.id==='d1'?{id:'d1',title:'Ingress runbook',text:'x'.repeat(outlineTextLimit+5),url:'/doc/ingress-d1',collectionId:allowed}:{id:'d2',title:'Elsewhere',text:'secret plans',collectionId:other}});
  return new Response('',{status:404});
 }) as typeof fetch;
 try{
  const reader=new OutlineReader(f.store,f.config,fetcher);
  const found=await reader.search({query:'ingress'});
  assert.deepEqual(found.results.map(r=>[r.id,r.url,r.context]),[['d1','https://outline.internal/doc/ingress-d1','restart the ingress']]);
  assert.deepEqual(calls.map(c=>c.path),['/api/collections.list','/api/documents.search']);
  assert.deepEqual(calls[1].body,{query:'ingress',collectionId:allowed,limit:10});assert.equal(calls[1].auth,'Bearer outline-key');
  const doc=await reader.read({id:'d1'});assert.equal(doc.text.length,outlineTextLimit);assert.equal(doc.truncated,true);
  assert.equal(calls.filter(c=>c.path==='/api/collections.list').length,1);
  await assert.rejects(reader.read({id:'d2'}),/outside the allowed Outline collection/);
  await assert.rejects(reader.read({id:'../x'}));
  await assert.rejects(reader.search({query:'x',collectionId:other}));
 }finally{f.close()}
});

test('a collection ID skips collections.list',async()=>{
 const f=fixture(allowed);f.store.credential('Outline','outline-key');const paths:string[]=[];
 const fetcher=(async(input:RequestInfo|URL)=>{const url=new URL(String(input));paths.push(url.pathname);return Response.json({data:[]});}) as typeof fetch;
 try{await new OutlineReader(f.store,f.config,fetcher).search({query:'dns'});assert.deepEqual(paths,['/api/documents.search']);}finally{f.close()}
});

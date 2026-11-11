import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {defaults} from '../src/model.js';
import {GitProxy} from '../server/git-proxy.js';

test('the Git proxy forwards clone and fetch with the GitLab token, and refuses pushes and unknown run tokens',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-gitproxy-')),store=new Store(dir);store.unlock('an isolated git proxy passphrase',true);
 store.credential('GitLab','glpat-secret');const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,GitLab:{...defaults.connections.GitLab,enabled:true,endpoint:'https://gitlab.internal'}}},s.configRevision);
 const seen:{encoding?:string;url:string;auth:string;method:string;body?:string}[]=[];
 const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{const h=init?.headers as Record<string,string>;seen.push({encoding:h['accept-encoding'],url:String(input),auth:h.Authorization,method:String(init?.method),body:init?.body?await new Response(init.body as ReadableStream).text():undefined});
  return new Response('001e# service=git-upload-pack\n',{headers:{'content-type':'application/x-git-upload-pack-advertisement','content-encoding':'gzip'}});}) as typeof fetch;
 const proxy=new GitProxy(store,fetcher);
 try{
  await proxy.listen('127.0.0.1',0);const token=proxy.register(),url=proxy.url(token,'team/app');
  assert.ok(!url.includes('glpat'));
  const refs=await fetch(url+'/info/refs?service=git-upload-pack',{headers:{'accept-encoding':'gzip'}});assert.equal(refs.status,200);
  assert.equal(refs.headers.get('content-encoding'),null,'the body is sent decompressed, so it is not labelled gzip');
  assert.equal(await refs.text(),'001e# service=git-upload-pack\n');
  assert.equal(refs.headers.get('content-type'),'application/x-git-upload-pack-advertisement');
  assert.equal(seen[0].url,'https://gitlab.internal/team/app.git/info/refs?service=git-upload-pack');
  assert.equal(seen[0].auth,'Basic '+Buffer.from('oauth2:glpat-secret').toString('base64'));assert.equal(seen[0].encoding,undefined,'Accept-Encoding is left to fetch');
  const pack=await fetch(url+'/git-upload-pack',{method:'POST',body:'0032want abc\n'});assert.equal(pack.status,200);assert.equal(seen[1].body,'0032want abc\n');
  assert.equal((await fetch(url+'/info/refs?service=git-receive-pack')).status,403);
  assert.equal((await fetch(url+'/git-receive-pack',{method:'POST',body:'x'})).status,403);
  assert.equal((await fetch(url.replace(token,'f'.repeat(48))+'/info/refs?service=git-upload-pack')).status,403);
  proxy.release(token);assert.equal((await fetch(url+'/info/refs?service=git-upload-pack')).status,403);
  assert.equal(seen.length,2);
 }finally{proxy.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

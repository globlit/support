import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {configuredModelFetch} from '../server/model-api.js';
import {recordDiagnostic,readLogs} from '../server/diagnostics.js';
import {dashboard} from '../server/dashboard.js';
import {tokenUsage} from '../server/model-telemetry.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'support-usage-')),store=new Store(dir);store.unlock('an isolated usage passphrase',true);
 const s=store.snapshot();store.config({...s.config,connections:{...s.config.connections,Model:{enabled:true,endpoint:'https://model.internal',scope:'claude-test',path:''}}},s.configRevision);store.credential('Model','model-key');
 return {store,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const overview={workflows:[],runs:[],loadedAt:'',historyLimit:200,agent:{model:'',active:false,step:''}};

test('token usage survives log pruning and settings saved during a call, and counts web searches',async()=>{
 const f=fixture();
 try{
  let save=()=>{};
  const transport=configuredModelFetch(f.store,(async()=>{save();return Response.json({usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:5,server_tool_use:{web_search_requests:2}}});}) as typeof fetch);
  save=()=>{const s=f.store.snapshot();f.store.config({...s.config,retentionDays:29},s.configRevision);};
  await transport('https://model.internal/v1/messages',{method:'POST',body:'{}'});save=()=>{};
  for(let i=0;i<2100;i++)recordDiagnostic(f.store,{tool:'Kubernetes',operation:'read '+i,status:'ok',durationMs:1,output:'x'});
  readLogs(f.store);
  const d=dashboard(f.store,overview as never,7);
  assert.equal(d.usage?.responses,1);assert.equal(d.usage?.input,105);assert.equal(d.usage?.output,20);assert.equal(d.usage?.webSearches,2);
 }finally{f.close()}
});
test('web search requests are read from Claude usage',()=>{
 assert.equal(tokenUsage({input_tokens:1,output_tokens:1,server_tool_use:{web_search_requests:3}},'anthropic')?.webSearches,3);
 assert.equal(tokenUsage({input_tokens:1,output_tokens:1},'anthropic')?.webSearches,undefined);
});

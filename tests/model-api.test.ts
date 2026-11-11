import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {modelFetch,modelKey} from '../server/model-api.js';
import {checkModelConnection} from '../server/connections.js';
const tool={name:'prepare_plan',description:'Plan only',input_schema:{type:'object',properties:{plan:{type:'string'},replyDraft:{type:'string'}},required:['plan','replyDraft'],additionalProperties:false}};
const body={model:'account-model',max_tokens:8192,system:'No writes',tools:[tool],messages:[{role:'user',content:'Analyze test ticket'}]};
const call={type:'function_call',id:'fc_1',call_id:'call_1',name:'prepare_plan',arguments:JSON.stringify({plan:'Review first',replyDraft:''})};
const options=(b:unknown)=>({method:'POST',headers:{'x-api-key':'private-key','anthropic-version':'2023-06-01'},body:JSON.stringify(b)});
test('OpenAI transport uses Responses and normalized custom calls, without provider storage or built-in tools',async()=>{
 const transport=modelFetch('openai',async(url,init)=>{assert.equal(String(url),'https://model.internal/v1/responses');assert.equal(init?.redirect,'manual');const h=new Headers(init?.headers);assert.equal(h.get('authorization'),'Bearer private-key');assert.equal(h.get('x-api-key'),null);const b=JSON.parse(String(init?.body));assert.equal(b.store,false);assert.equal(b.parallel_tool_calls,false);assert.equal(b.tools[0].type,'function');assert.equal(b.tools[0].strict,true);assert.equal(b.instructions,'No writes');assert.equal(b.max_output_tokens,8192);return Response.json({status:'completed',output:[call]});});
 const r=await transport('https://model.internal/v1/messages',options(body));const normalized=await r.json();assert.equal(normalized.stop_reason,'tool_use');assert.deepEqual(normalized.content[0],{type:'tool_use',id:'call_1',name:'prepare_plan',input:{plan:'Review first',replyDraft:''}});
});
test('OpenAI preserves opaque reasoning and tool outputs only in run memory',async()=>{
 let turn=0;const reasoning={type:'reasoning',id:'rs_1',encrypted_content:'opaque-ciphertext',summary:[]};
 const read={...call,name:'prometheus_query',arguments:'{"query":"up"}'};
 const transport=modelFetch('openai',async(_url,init)=>{const b=JSON.parse(String(init?.body));if(turn++===0)return Response.json({status:'completed',output:[reasoning,read]});assert.deepEqual(b.input.slice(1,3),[reasoning,read]);assert.deepEqual(b.input[3],{type:'function_call_output',call_id:'call_1',output:'{"up":1}'});return Response.json({status:'completed',output:[{...call,call_id:'call_2'}]});});
 const r=await (await transport('https://model.internal/v1/messages',options(body))).json();assert.ok(!JSON.stringify(r).includes('opaque-ciphertext'));
 await transport('https://model.internal/v1/messages',options({...body,messages:[...body.messages,{role:'assistant',content:r.content},{role:'user',content:[{type:'tool_result',tool_use_id:'call_1',content:'{"up":1}'}]}]}));assert.equal(turn,2);
});
test('OpenAI incomplete, malformed and unexpected built-in outputs cannot become a plan',async()=>{
 const incomplete=modelFetch('openai',async()=>Response.json({status:'incomplete',output:[call]}));assert.equal((await (await incomplete('https://m/v1/messages',options(body))).json()).stop_reason,'max_tokens');
 for(const output of [[{...call,arguments:'broken'}],[{type:'shell_call'}],[call,call]]){
  const transport=modelFetch('openai',async()=>Response.json({status:'completed',output}));await assert.rejects(transport('https://m/v1/messages',options(body)));
 }
 const redirected=modelFetch('openai',async()=>new Response('',{status:302}));assert.equal((await redirected('https://m/v1/messages',options(body))).status,302);
});
test('Anthropic successful transport stays compatible',async()=>{const f:typeof fetch=async()=>Response.json({ok:true});assert.deepEqual(await (await modelFetch('anthropic',f)('https://model/v1/messages')).json(),{ok:true})});
test('Provider credentials cannot cross providers; model checks read metadata only',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-model-'));const store=new Store(dir);
 try{store.unlock('a long test passphrase',true);store.credential('Model','claude-key');assert.equal(await modelKey(store),'claude-key');let s=store.snapshot();store.config({...s.config,modelProvider:'openai',connections:{...s.config.connections,Model:{enabled:true,endpoint:'https://approved.internal',scope:'available-model',path:''}}},s.configRevision);await assert.rejects(modelKey(store),/selected model provider/);store.credential('Model','openai-key');
 const result=await checkModelConnection(store,async(url,init)=>{assert.equal(String(url),'https://approved.internal/v1/models/available-model');assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer openai-key');return Response.json({id:'available-model'});});assert.equal(result.liveTest,true);assert.ok(!JSON.stringify(result).includes('openai-key'));
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('OpenAI analysis reads a tool and persists only an unapproved plan',async()=>{
 const {Claude}=await import('../server/claude.js');const {YouTrack}=await import('../server/youtrack.js');
 const dir=mkdtempSync(join(tmpdir(),'support-openai-analysis-'));const store=new Store(dir);
 try{
  store.unlock('analysis test passphrase',true);const s=store.snapshot();store.config({...s.config,modelProvider:'openai',connections:{...s.config.connections,Model:{enabled:true,endpoint:'https://model.internal',scope:'account-model',path:''},Prometheus:{enabled:true,endpoint:'',scope:'',path:''}},prometheusSources:[{id:'legacy',name:'prometheus',kind:'url',endpoint:'https://metrics.internal'}]},s.configRevision);store.credential('Model','openai-test-key');
  const issue={id:'3-0',key:'LAB-1',title:'Test',description:'Manual fixture',updated:1000,resolved:false,status:'Open',severity:'Low',assignee:'',project:'LAB',fields:{},url:'https://yt.internal/issue/LAB-1',connection:'fixture'};
  const source={issue:async()=>issue,work:async()=>({issue,session:store.workSession(issue)})};let calls=0;
  const ai=new Claude(store,new YouTrack(store),async(url,init)=>{
   if(String(url).includes('metrics.internal')){assert.equal(init?.method,'GET');return Response.json({status:'success',data:{result:[]}})}
   assert.equal(String(url),'https://model.internal/v1/responses');const b=JSON.parse(String(init?.body));assert.equal(b.store,false);
   for(const t of b.tools)if(t.strict){assert.deepEqual([...t.parameters.required].sort(),Object.keys(t.parameters.properties).sort(),'Strict tools must require every property');}assert.equal(b.tools.find((t:{name:string})=>t.name==='prometheus_query').strict,false);assert.equal(b.tools.find((t:{name:string})=>t.name==='ask_engineer').strict,true);
   return Response.json({status:'completed',output:[calls++===0?{...call,name:'prometheus_query',arguments:'{"query":"up"}'}:{...call,call_id:'call_2'}]});
  });
  const run=await ai.start('3-0',{revision:1,sourceUpdated:1000},source);
  for(let i=0;i<100&&ai.status(run.id).state==='running';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(ai.status(run.id).state,'ready');assert.equal(calls,2);const session=store.workSession(issue);assert.equal(session.plans.at(-1)?.text,'Review first');assert.equal(session.approval,null);assert.ok(!JSON.stringify(session).includes('openai-test-key'));
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('HTTP and streamed failures redact credentials, log safe details and never apply output',async()=>{
 for(const streamed of [false,true]){
  const failures:unknown[]=[];
  const error={code:'invalid_function_parameters',param:'tools[0]',message:'Bad schema, secret private-key and Bearer other-secret'};
  const fetcher:typeof fetch=async()=>streamed?new Response('data: '+JSON.stringify({type:'response.failed',response:{error,output:[{text:'private reasoning'}]}})+'\n\n',{headers:{'x-request-id':'req-stream'}}):Response.json({error},{status:400,headers:{'x-request-id':'req-http'}});
  const transport=modelFetch('openai',fetcher,streamed,{onFailure:failure=>failures.push(failure)});
  await assert.rejects(transport('https://api.openai.com/v1/messages',options(body)),/invalid_function_parameters/);
  assert.equal(failures.length,1);const text=JSON.stringify(failures);assert.ok(!text.includes('private-key'));assert.ok(!text.includes('other-secret'));assert.ok(!text.includes('private reasoning'));assert.ok(text.includes('tools[0]'));assert.ok(text.includes('req-'));
 }
});
test('nonstandard admission errors remain bounded and include their HTTP status',async()=>{
 const failures:unknown[]=[];
 const transport=modelFetch('openai',async()=>Response.json({detail:'Access denied by serving region'},{status:403}),true,{onFailure:failure=>failures.push(failure)});
 await assert.rejects(transport('https://api.openai.com/v1/messages',options(body)),/Access denied by serving region/);
 assert.equal((failures[0] as {httpStatus:number}).httpStatus,403);
 const {readFailureBody}=await import('../server/model-errors.js');
 assert.deepEqual(await readFailureBody(new Response('x'.repeat(17000))),{detail:'Error body exceeded the diagnostic limit.'});
});

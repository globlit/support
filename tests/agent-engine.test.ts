import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {YouTrack} from '../server/youtrack.js';
import {Claude} from '../server/claude.js';
import {AgentGateway,UsageReader} from '../server/agent-gateway.js';
import {searchVariants} from '../server/outline.js';
import {localAction} from '../server/youtrack.js';
import type {AgentToolset} from '../server/agent-toolset.js';

const issue={id:'2-42',idReadable:'INFRA-42',summary:'netpol.sahar.fr does not answer',description:'token=never-send-this',updated:1000,resolved:null};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'support-agent-'));const store=new Store(dir);store.unlock('long test passphrase',true);
 for(const name of ['Model','YouTrack'])store.credential(name,name+'-private-credential');
 const s=store.snapshot();
 store.config({...s.config,connections:{...s.config.connections,YouTrack:{endpoint:'https://yt.internal',scope:'project: INFRA',path:'',enabled:true},Model:{endpoint:'https://claude.internal',scope:'claude-test',path:'',enabled:true}}},s.configRevision);
 const yt=new YouTrack(store,(async()=>Response.json(issue)) as typeof fetch);
 return {store,yt,dir,done(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
const stubToolset=(calls:unknown[]=[]):AgentToolset=>({definitions:[{name:'echo',description:'Echo the input.',input_schema:{type:'object',properties:{v:{type:'string'}},required:[],additionalProperties:false}}],async run(name,input){calls.push([name,input]);if(name!=='echo')throw new Error('unknown');return {echo:input};},async kubectl(args){return {stdout:JSON.stringify(args),stderr:'',code:0};},close(){}} as AgentToolset);

test('the gateway replaces the placeholder credential, records usage, and serves tools over MCP and HTTP',async()=>{
 const f=fixture();const seen:{url:string;headers:Record<string,string>;body:string}[]=[];
 const upstream=(async(input:RequestInfo|URL,init?:RequestInit)=>{seen.push({url:String(input),headers:init?.headers as Record<string,string>,body:String(init?.body)});
  const sse='event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":12,"cache_read_input_tokens":3,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
  return new Response(sse,{headers:{'content-type':'text/event-stream'}});}) as typeof fetch;
 const gw=new AgentGateway(f.store,upstream,undefined);
 try{
  await gw.listen('127.0.0.1',0);const calls:unknown[]=[];const s=gw.register({runId:'r1',toolset:stubToolset(calls)});
  const r=await fetch(s.url+'/v1/messages?beta=true',{method:'POST',headers:{authorization:'Bearer placeholder','x-api-key':'placeholder','anthropic-beta':'x','content-type':'application/json'},body:'{"stream":true}'});
  assert.equal(r.status,200);await r.text();
  assert.equal(seen[0].url,'https://claude.internal/v1/messages?beta=true');
  assert.equal(seen[0].headers['x-api-key'],'Model-private-credential');assert.equal(seen[0].headers.authorization,undefined);assert.equal(seen[0].headers['anthropic-beta'],'x');
  const usage=f.store.db.prepare('SELECT input,output,cache_read FROM model_usage').get() as {input:number;output:number;cache_read:number};
  assert.deepEqual({...usage},{input:15,output:7,cache_read:3});
  const rpc=async(body:unknown)=>(await fetch(s.url+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(body)}));
  assert.equal(((await (await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}})).json()) as {result:{serverInfo:{name:string}}}).result.serverInfo.name,'support');
  assert.equal((await rpc({jsonrpc:'2.0',method:'notifications/initialized'})).status,202);
  const list=await (await rpc({jsonrpc:'2.0',id:2,method:'tools/list'})).json() as {result:{tools:{name:string}[]}};assert.deepEqual(list.result.tools.map(t=>t.name),['echo']);
  const call=await (await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'echo',arguments:{v:'a'}}})).json() as {result:{content:{text:string}[];isError:boolean}};
  assert.equal(call.result.isError,false);assert.match(call.result.content[0].text,/"v": "a"/);
  const failed=await (await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'missing',arguments:{}}})).json() as {result:{isError:boolean}};assert.equal(failed.result.isError,true);
  assert.deepEqual(await (await fetch(s.url+'/tools/echo',{method:'POST',body:'{"v":"b"}'})).json(),{echo:{v:'b'}});
  assert.deepEqual(await (await fetch(s.url+'/kubectl',{method:'POST',body:'{"args":["get","pods"]}'})).json(),{stdout:'["get","pods"]',stderr:'',code:0});
  assert.equal((await fetch(s.url.replace(s.token,'x'.repeat(32))+'/tools')).status,403);
  gw.release(s.token);assert.equal((await fetch(s.url+'/tools')).status,403);
 }finally{gw.close();f.done();}
});

test('in subscription mode the gateway sends the provisioned OAuth token',async()=>{
 const f=fixture();const tokenFile=join(f.dir,'token');writeFileSync(tokenFile,'oauth-real-token\n');
 const s0=f.store.snapshot();f.store.config({...s0.config,modelAuth:'claude_cli'},s0.configRevision);
 let auth='';const gw=new AgentGateway(f.store,(async(_u:RequestInfo|URL,init?:RequestInit)=>{auth=(init?.headers as Record<string,string>).authorization;return Response.json({usage:{input_tokens:1,output_tokens:1}});}) as typeof fetch,tokenFile);
 try{await gw.listen('127.0.0.1',0);const s=gw.register({runId:'r',toolset:stubToolset()});await (await fetch(s.url+'/v1/messages',{method:'POST',headers:{authorization:'Bearer placeholder'},body:'{}'})).text();assert.equal(auth,'Bearer oauth-real-token');}
 finally{gw.close();f.done();}
});

test('usage is read from non-streamed responses too',()=>{
 const u=new UsageReader();u.push(new TextEncoder().encode('{"model":"m","usage":{"input_tokens":5,"output_tokens":2,"server_tool_use":{"web_search_requests":1}}}'));
 assert.deepEqual(u.result(),{input:5,output:2,cacheRead:0,cacheWrite:0,webSearches:1,model:'m'});
});

test('a Claude Code session streams into the run, gets a review on its first result, and becomes a plan after checks',async()=>{
 const f=fixture();const shared=join(f.dir,'shared');
 const env={SUPPORT_SANDBOX_URL:process.env.SUPPORT_SANDBOX_URL,SUPPORT_CLAUDE_ACCESS_PATH:process.env.SUPPORT_CLAUDE_ACCESS_PATH};
 process.env.SUPPORT_SANDBOX_URL='http://sandbox.internal';process.env.SUPPORT_CLAUDE_ACCESS_PATH=shared;
 const gw=new AgentGateway(f.store,(async()=>Response.json({})) as typeof fetch);
 const inputs:unknown[]=[];let started:{cwd:string;args:string[];env:Record<string,string>;input:string}|undefined;const reviews:string[]=[];
 const sandbox=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const u=new URL(String(input));
  if(u.hostname!=='sandbox.internal')return fetch(input,init);
  if(u.pathname==='/v1/agent'){
   started=JSON.parse(String(init?.body));const tools=started!.env.SUPPORT_TOOLS_URL;
   const line=(v:unknown)=>JSON.stringify({type:'stdout',data:JSON.stringify(v)+'\n'})+'\n';
   const body=new ReadableStream({async start(c){
    const e=new TextEncoder();
    c.enqueue(e.encode(line({type:'system',subtype:'init',session_id:'sess-1'})));
    c.enqueue(e.encode(line({type:'assistant',message:{content:[{type:'text',text:'Checking the NetworkPolicy. token=never-send-this'},{type:'tool_use',id:'t1',name:'Bash',input:{command:'kubectl get networkpolicies -n app'}}]}})));
    c.enqueue(e.encode(line({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'policy deny-all found',is_error:false}]}})));
    for(let i=0;i<2;i++){const r=await fetch(tools+'/tools/submit_result',{method:'POST',body:JSON.stringify({outcome:'plan',report:'## Cause\nA deny-all policy blocks ingress.\n\n## Fix\nAllow the ingress controller.'})});reviews.push(((await r.json()) as {message:string}).message);}
    c.enqueue(e.encode(line({type:'result',subtype:'success',session_id:'sess-1',result:'done'})));
    c.enqueue(e.encode(JSON.stringify({type:'exit',code:0,signal:null})+'\n'));c.close();
   }});
   return new Response(body,{headers:{'content-type':'application/x-ndjson'}});
  }
  if(u.pathname.endsWith('/input')){inputs.push(JSON.parse(String(init?.body)));return Response.json({ok:true});}
  return new Response('',{status:404});
 }) as typeof fetch;
 try{
  await gw.listen('127.0.0.1',0);
  const c=new Claude(f.store,f.yt,sandbox);c.useGateway(gw);
  const run=await c.start('2-42',{revision:1,sourceUpdated:1000});
  let s=c.status(run.id);for(let i=0;i<300&&s.state==='running';i++){await new Promise(r=>setTimeout(r,10));s=c.status(run.id);}
  assert.equal(s.state,'ready',s.error);assert.equal(s.outcome,'plan');assert.ok(s.planVersion);assert.equal(s.sessionId,'sess-1');
  assert.match(reviews[0],/^Before this is final/);assert.match(reviews[1],/^Recorded/);
  assert.ok(started!.cwd.startsWith(shared+'/.support-agent/work/youtrack-INFRA-42'));
  assert.equal(started!.env.CLAUDE_CONFIG_DIR,shared+'/.claude');assert.equal(started!.env.ANTHROPIC_API_KEY,'support-gateway');
  assert.ok(!JSON.stringify(started).includes('Model-private-credential'),'the real credential never reaches the sandbox');
  assert.ok(!JSON.stringify(started!.input).includes('never-send-this'),'secret-looking ticket text is redacted');
  assert.ok(s.events.some(e=>e.tool==='Bash'&&e.status==='complete'&&e.result==='policy deny-all found'));
  assert.ok(!JSON.stringify(s.events).includes('never-send-this'));
  assert.deepEqual(inputs.at(-1),{end:true});
  assert.deepEqual(f.store.get('agentSession:'+s.connection+':2-42'),{...f.store.get<object>('agentSession:'+s.connection+':2-42'),sessionId:'sess-1'});
 }finally{gw.close();f.done();Object.assign(process.env,env);for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];}
});

test('search variants try each distinctive word, without top-level domains',()=>{
 assert.deepEqual(searchVariants('netpol.sahar.fr'),['netpol sahar fr','netpol','sahar']);
 assert.deepEqual(searchVariants('ingress'),[]);
});

test('an approval can be cancelled, except while a GitLab write needs verification',()=>{
 const f=fixture();
 try{
  const src={id:'2-42',key:'INFRA-42',title:'t',description:'',updated:1000,resolved:false,status:'Open',severity:'Low',assignee:'',project:'INFRA',fields:{},url:'https://yt.internal/issue/INFRA-42',connection:'yt-conn'};
  f.store.put('handling:'+src.connection+':'+src.id,{mode:'investigate'});
  let w=f.store.workSession(src);
  ({session:w}=localAction(f.store,src,{action:'plan',revision:w.revision,text:'1. Fix',sourceUpdated:1000}));
  ({session:w}=localAction(f.store,src,{action:'approve',revision:w.revision,sourceUpdated:1000}));
  assert.ok(w.approval);
  ({session:w}=localAction(f.store,src,{action:'unapprove',revision:w.revision,sourceUpdated:1000}));
  assert.equal(w.approval,null);
  assert.throws(()=>localAction(f.store,src,{action:'unapprove',revision:w.revision,sourceUpdated:1000}),/not approved/);
 }finally{f.done()}
});

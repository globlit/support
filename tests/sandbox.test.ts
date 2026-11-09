import test from 'node:test';
import assert from 'node:assert/strict';
import {runSandboxCommand,sandboxUrl,commandOutputLimit} from '../server/sandbox.js';

const base=new URL('http://sandbox.internal/');
const stream=(lines:unknown[],split=7)=>{const text=lines.map(l=>JSON.stringify(l)+'\n').join('');const chunks:string[]=[];for(let i=0;i<text.length;i+=split)chunks.push(text.slice(i,i+split));
 return new Response(new ReadableStream({start(c){for(const s of chunks)c.enqueue(new TextEncoder().encode(s));c.close();}}),{headers:{'Content-Type':'application/x-ndjson'}});};

test('a command streams its output, redacts secrets and returns its exit status',async()=>{
 let sent:any;const chunks:string[]=[];
 const fetcher=(async(url:RequestInfo|URL,init?:RequestInit)=>{assert.equal(String(url),'http://sandbox.internal/v1/exec');sent=JSON.parse(String(init?.body));
  return stream([{type:'stdout',data:'token hunter2\n'},{type:'stderr',data:'warn\n'},{type:'exit',code:2,signal:null,durationMs:40,truncated:false}]);}) as typeof fetch;
 const r=await runSandboxCommand({runId:'run-1',command:'echo',timeoutSeconds:30,signal:new AbortController().signal,onOutput:t=>chunks.push(t),redact:v=>v.replaceAll('hunter2','[redacted]'),fetcher,base});
 assert.deepEqual(sent,{runId:'run-1',command:'echo',timeoutSeconds:30});
 assert.deepEqual(chunks,['token [redacted]\n','warn\n']);
 assert.deepEqual(r,{exitCode:2,signal:null,durationMs:40,timedOut:false,truncated:false,output:'token [redacted]\nwarn\n'});
});

test('long output keeps its end, and failures become clear errors',async()=>{
 const big='a'.repeat(commandOutputLimit)+'END';
 const r=await runSandboxCommand({runId:'r',command:'x',timeoutSeconds:1,signal:new AbortController().signal,base,fetcher:(async()=>stream([{type:'stdout',data:big},{type:'exit',code:0,durationMs:1}],5000)) as typeof fetch});
 assert.equal(r.output.length,commandOutputLimit);assert.ok(r.output.endsWith('END'));assert.equal(r.truncated,true);
 await assert.rejects(runSandboxCommand({runId:'r',command:'x',timeoutSeconds:1,signal:new AbortController().signal,base,fetcher:(async()=>Response.json({error:'At most 8 commands'},{status:429})) as typeof fetch}),/HTTP 429\). At most 8 commands/);
 await assert.rejects(runSandboxCommand({runId:'r',command:'x',timeoutSeconds:1,signal:new AbortController().signal,base,fetcher:(async()=>stream([{type:'stdout',data:'x'}])) as typeof fetch}),/without an exit status/);
 await assert.rejects(runSandboxCommand({runId:'r',command:'x',timeoutSeconds:1,signal:new AbortController().signal,base:undefined}),/No command sandbox/);
 const stop=new AbortController();stop.abort();
 await assert.rejects(runSandboxCommand({runId:'r',command:'x',timeoutSeconds:1,signal:stop.signal,base,fetcher:(async(_u:unknown,init?:RequestInit)=>{init?.signal?.throwIfAborted();return stream([]);}) as typeof fetch}),/Command stopped/);
 assert.equal(sandboxUrl({}),undefined);assert.equal(sandboxUrl({SUPPORT_SANDBOX_URL:'http://172.31.250.20:7070'})?.href,'http://172.31.250.20:7070/');
});

import {inRunWindow} from '../src/dashboard-links.js';
import {randomUUID} from 'node:crypto';
import type {Store} from './store.js';
import {AppError} from './store.js';
import type {Diagnostic,LogTool,LogPage} from '../src/diagnostics-model.js';
const captureLimit=24*1024;
const sensitive=/^(authorization|proxy-authorization|cookie|set-cookie|private-token|.*password.*|.*token.*|.*secret.*|.*credential.*|api[_-]?key|private[_-]?key|encrypted_content|reasoning|thinking|signature)$/i;
export function redactDiagnostic(text:string,secrets:string[]=[]):string{
 for(const secret of secrets.sort((a,b)=>b.length-a.length))if(secret)text=text.split(secret).join('[redacted]');
 text=text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted private key]');
 try{const value=JSON.parse(text);const clean=(v:unknown):unknown=>Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sensitive.test(k)?'[redacted]':clean(x)])):typeof v==='string'?plain(v):v;return JSON.stringify(clean(value),null,2);}catch{return plain(text);}
}
function plain(text:string){return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi,'$1 [redacted]').replace(/\b(password|token|secret|authorization|api[_-]?key|private[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,'$1=[redacted]').replace(/\b(?:sk-[A-Za-z0-9_-]+|glpat-[A-Za-z0-9_-]+|perm:[A-Za-z0-9:._-]+)\b/g,'[redacted]');}
export function pruneLogs(store:Store){store.db.prepare('DELETE FROM diagnostics WHERE at < ?').run(new Date(Date.now()-store.snapshot().config.retentionDays*86400000).toISOString());store.db.exec('DELETE FROM diagnostics WHERE seq NOT IN (SELECT seq FROM diagnostics ORDER BY seq DESC LIMIT 2000)');}
export function recordDiagnostic(store:Store,entry:Omit<Diagnostic,'id'|'at'>&Partial<Pick<Diagnostic,'id'|'at'>>,secrets?:string[]){
 if(!store.key)return;
 try{const clean=(s:string)=>redactDiagnostic(s,secrets??store.secretValues()).slice(0,captureLimit);const value:Diagnostic={...entry,id:entry.id??randomUUID(),at:entry.at??new Date().toISOString(),operation:clean(entry.operation),request:entry.request?clean(entry.request):undefined,output:clean(entry.output)};
 store.db.prepare('INSERT OR IGNORE INTO diagnostics(id,at,tool,status,value) VALUES (?,?,?,?,?)').run(value.id,value.at,value.tool,value.status,store.encrypt(JSON.stringify(value),store.key));pruneLogs(store);}catch{/* Diagnostics must not change the result of an operation. */}
}
export function readLogs(store:Store,{tool,status,before,limit=50,query='',time,duration,from,to,zone}:{tool?:string;status?:string;before?:number;limit?:number;query?:string;time?:'hour'|'day'|'week';duration?:'fast'|'normal'|'slow';from?:string;to?:string;zone?:string}={}):LogPage{
 if(!store.key)throw new AppError(423,'Unlock the Vault to view logs.');pruneLogs(store);
 const clauses:string[]=[],args:(string|number)[]=[];if(tool){clauses.push('tool=?');args.push(tool)}if(status){clauses.push('status=?');args.push(status)}
 if(time){clauses.push('at>=?');args.push(new Date(Date.now()-({hour:3600000,day:86400000,week:604800000}[time])).toISOString());}
 const where=clauses.length?' WHERE '+clauses.join(' AND '):'';limit=Math.max(1,Math.min(100,limit));
 const rows=store.db.prepare('SELECT seq,value FROM diagnostics'+where+' ORDER BY seq DESC').iterate(...args);
 const entries:Diagnostic[]=[];let total=0,next:number|undefined,last:number|undefined;
 for(const row of rows){const entry=JSON.parse(store.decrypt(String(row.value),store.key)) as Diagnostic;
  if(!inRunWindow(entry.at,{page:'logs',from,to,zone}))continue;
  if(query&&!entry.operation.toLowerCase().includes(query.toLowerCase()))continue;
  if(duration==='fast'&&entry.durationMs>=100||duration==='normal'&&(entry.durationMs<100||entry.durationMs>=1000)||duration==='slow'&&entry.durationMs<1000)continue;
  total++;if(before&&Number(row.seq)>=before)continue;
  if(entries.length<limit){entries.push(entry);last=Number(row.seq)}else if(!next)next=last;
 }
 return {entries,next,total,limit};
}
export function loggedFetch(store:Store,fetcher:typeof fetch=fetch):typeof fetch{
 return async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  // Never capture OAuth exchanges.
  if(url.hostname==='auth.openai.com')return fetcher(input,init);
  const config=store.snapshot().config;
  const tool=(['Model','YouTrack','GitLab','Alertmanager','Prometheus','Slack'] as const).find(name=>{try{const base=new URL(config.connections[name].endpoint);return base.origin===url.origin&&url.pathname.startsWith(base.pathname.replace(/\/$/,''));}catch{return false;}});
  if(!tool||!store.key)return fetcher(input,init);
  const revision=store.snapshot().configRevision,credentialEpoch=store.credentialEpoch,epoch=store.vaultEpoch,secrets=store.secretValues(),start=Date.now();
  const path=url.pathname;const query=Object.fromEntries([...url.searchParams].map(([k,v])=>[k,sensitive.test(k)?'[redacted]':v]));
  const request=JSON.stringify({method:init?.method??'GET',path,query,...(tool!=='Model'&&typeof init?.body==='string'&&Buffer.byteLength(init.body)<=captureLimit?{body:init.body}:{})});
  let finished=false;const done=(status:Diagnostic['status'],output:string,code?:number,truncated=false)=>{if(finished)return;finished=true;if(store.vaultEpoch===epoch)recordDiagnostic(store,{tool,operation:(init?.method??'GET')+' '+path,status,durationMs:Date.now()-start,code,request,output,truncated},secrets)};
  let response:Response;try{response=await fetcher(input,init)}catch(e){done('error','Connection interrupted. No automatic retry.');throw e;}
  if(tool==='Model'){done(response.ok?'ok':'error','Model transport body omitted. Inspect the conversation for tool results and produced work.',response.status);return response;}
  if(!response.body){done(response.ok?'ok':'error','Empty response',response.status);return response;}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  const stream=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(next.done){done(response.ok?'ok':'error',size<=captureLimit?Buffer.concat(chunks).toString('utf8'):'Response exceeded the 24 KB capture limit; body omitted.',response.status,size>captureLimit);controller.close();return;}size+=next.value.byteLength;if(size<=captureLimit)chunks.push(next.value);else chunks.length=0;controller.enqueue(next.value);}catch(e){done('error','Response stream interrupted.',response.status);controller.error(e);}},async cancel(reason){done(response.ok?'cancelled':'error','Response was not fully read; body omitted.',response.status);await reader.cancel(reason);}});
  return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}

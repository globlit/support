import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {deployment} from '../server/deployment.js';
import {Sessions} from '../server/sessions.js';
import {humanAttribution,localOwner,withIdentity,workspaceIdentity} from '../server/identity.js';
import {Store} from '../server/store.js';
import {localAction} from '../server/youtrack.js';
import {cliEnvironment} from '../server/claude-cli.js';
const req=(cookie='',method='GET',csrf?:string)=>({method,headers:{cookie,...(csrf?{'x-support-csrf':csrf}:{})}} as IncomingMessage);
const response=()=>{let value='';return {res:{setHeader(_name:string,v:string){value=v}} as unknown as ServerResponse,cookie:()=>value.split(';')[0]};};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-security-')),store=new Store(dir);store.unlock('security fixture passphrase',true);return {store,done(){store.close();rmSync(dir,{recursive:true,force:true})}}}
test('deployment is strict, loopback by default, with explicit container mapping and no hosted fallback',()=>{
 assert.equal(deployment({}).bindHost,'127.0.0.1');
 assert.equal(deployment({SUPPORT_DEPLOYMENT:'container',SUPPORT_BIND_HOST:'0.0.0.0',SUPPORT_PORT:'8080',SUPPORT_PUBLIC_ORIGIN:'http://127.0.0.1:4173'}).host,'127.0.0.1:4173');
 for(const env of [{SUPPORT_BIND_HOST:'0.0.0.0'},{SUPPORT_PORT:'0'},{SUPPORT_PORT:'NaN'},{SUPPORT_DEPLOYMENT:'hosted'},{SUPPORT_DEPLOYMENT:'container'},{SUPPORT_PUBLIC_ORIGIN:'https://remote.test'},{SUPPORT_PUBLIC_ORIGIN:'http://127.0.0.1:4173/extra'},{SUPPORT_PUBLIC_ORIGIN:'http://user@127.0.0.1:4173'},{SUPPORT_PUBLIC_ORIGIN:'http://127.0.0.1:4174'},{SUPPORT_TRUST_PROXY:'true'},{SUPPORT_SESSION_SECONDS:'9999999'}])assert.throws(()=>deployment(env));
});
test('sessions require their cookie and CSRF, expire, rotate, revoke and do not survive lock/restart',()=>{
 const f=fixture();let now=1000;try{
  const sessions=new Sessions(f.store,deployment({SUPPORT_SESSION_SECONDS:'300'}),()=>now),out=response(),session=sessions.issue(req(),out.res),cookie=out.cookie();
  assert.equal(sessions.status(req()).authenticated,false);assert.equal(sessions.require(req(cookie)),session);
  assert.throws(()=>sessions.require(req(cookie,'POST')),/verification/);assert.throws(()=>sessions.require(req(cookie,'POST','é'.repeat(43))),/verification/);assert.equal(sessions.require(req(cookie,'POST',session.csrf)),session);
  assert.equal(sessions.status(req(cookie+'; '+cookie)).authenticated,false);
  const next=response();sessions.issue(req(cookie),next.res);assert.equal(sessions.status(req(cookie)).authenticated,false);
  const newCookie=next.cookie();assert.equal(sessions.status(req(newCookie)).authenticated,true);
  f.store.verifyPassphrase('security fixture passphrase');assert.equal(sessions.status(req(newCookie)).authenticated,true);
  assert.equal(new Sessions(f.store,deployment({}),()=>now).status(req(newCookie)).authenticated,false);
  now+=300001;assert.equal(sessions.status(req(newCookie)).authenticated,false);
  sessions.issue(req(),next.res);f.store.lock();assert.equal(sessions.status(req(next.cookie())).authenticated,false);
  f.store.unlock('security fixture passphrase');sessions.issue(req(),next.res);sessions.logout(req(next.cookie()),next.res);assert.equal(sessions.valid(session),false);
 }finally{f.done()}
});
test('identity persists independently of display settings and context cannot leak across concurrent work',async()=>{
 const f=fixture(),other=fixture();try{
  const owner=localOwner(f.store),original=workspaceIdentity(f.store),s=f.store.snapshot();f.store.config({...s.config,engineer:'Forged approver'},s.configRevision);
  assert.throws(()=>humanAttribution(f.store),/Sign in/);
  assert.throws(()=>withIdentity(owner,()=>false,()=>humanAttribution(f.store)),/Sign in/);
  assert.throws(()=>withIdentity(owner,()=>true,()=>humanAttribution(other.store)),/another workspace/);
  await Promise.all([f,other].map(x=>withIdentity(localOwner(x.store),()=>true,async()=>{await new Promise(r=>setTimeout(r,5));assert.equal(humanAttribution(x.store).actorId,localOwner(x.store).id)})));
  assert.deepEqual(workspaceIdentity(f.store),original);assert.equal(withIdentity(owner,()=>true,()=>humanAttribution(f.store)).actor,'Workspace owner');assert.throws(()=>humanAttribution(f.store),/Sign in/);
 }finally{f.done();other.done()}
});
test('a real plan requires an active human identity; old approvals are preserved as history and need fresh review',()=>{
 const f=fixture();try{
  const issue={connection:'fixture',id:'1',key:'LAB-1',updated:1,title:'',description:'',resolved:false,status:'Open',severity:'',assignee:'',project:'',fields:{},url:''};
  let w=f.store.workSession(issue);w.plans=[{version:1,text:'Inspect the service',at:new Date().toISOString()}];f.store.saveWorkSession(w);
  assert.throws(()=>localAction(f.store,issue,{action:'approve',revision:w.revision,sourceUpdated:1}),/Sign in/);assert.equal(f.store.workSession(issue).approval,null);
  const owner=localOwner(f.store);w=withIdentity(owner,()=>true,()=>localAction(f.store,issue,{action:'approve',revision:w.revision,sourceUpdated:1})).session;
  assert.equal(w.approval!.actorId,owner.id);assert.equal(w.approval!.workspaceId,owner.workspaceId);
  delete w.approval!.actorId;delete w.approval!.workspaceId;f.store.saveWorkSession(w);new Sessions(f.store,deployment({}));
  const migrated=f.store.workSession(issue);assert.equal(migrated.approval,null);assert.equal(migrated.plans[0].text,'Inspect the service');assert.ok(f.store.get('security.legacy-approval:fixture:1'));
 }finally{f.done()}
});
test('tools cannot inherit host agent sockets or service/browser authentication environment',()=>{
 const input={HOME:'/workspace',PATH:'/usr/bin',SSH_AUTH_SOCK:'/host/agent',SSH_CONNECTION:'host',SUPPORT_SESSION_SECRET:'secret',GIT_ASKPASS:'/host/run',NODE_OPTIONS:'--require /host/run',AWS_SECRET_ACCESS_KEY:'secret',DYLD_INSERT_LIBRARIES:'/host/lib'};
 for(const env of [cliEnvironment(input)])for(const key of ['SSH_AUTH_SOCK','SSH_CONNECTION','SUPPORT_SESSION_SECRET','GIT_ASKPASS','NODE_OPTIONS','AWS_SECRET_ACCESS_KEY','DYLD_INSERT_LIBRARIES'])assert.equal(env[key],undefined,key);
});

test('browser session recovery distinguishes provider token errors and ignores an obsolete session check',async()=>{
 const {api}=await import('../src/api.js'),{refreshSession,sessionLost,csrfToken,sessionEvent}=await import('../src/session.js');
 const originalFetch=globalThis.fetch,oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),events:unknown[]=[];const win=new EventTarget();win.addEventListener(sessionEvent,e=>events.push((e as CustomEvent).detail));Object.defineProperty(globalThis,'window',{value:win,configurable:true});
 try{
  globalThis.fetch=async()=>Response.json({error:'Provider rejected token'},{status:401});await assert.rejects(api('/youtrack/issues'));assert.equal(events.length,0);
  globalThis.fetch=async()=>Response.json({error:'Sign in',code:'SESSION_REQUIRED'},{status:401});await assert.rejects(api('/state'));assert.equal(events.length,1);
  let finish!:(value:Response)=>void;globalThis.fetch=async()=>new Promise(r=>finish=r);const pending=refreshSession();sessionLost();finish(Response.json({authenticated:true,initialized:true,csrf:'obsolete'}));await pending;assert.equal(csrfToken(),undefined);assert.equal(events.length,2);
 }finally{globalThis.fetch=originalFetch;if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window')}
});

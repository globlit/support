import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSync} from '../src/workspace-sync.js';
import {openVaultSettings,resumeAfterVaultUnlock,navigate,routeHash} from '../src/navigation.js';
import type {Snapshot} from '../src/model.js';

test('a lock discards an older unlocked snapshot; only a fresh read resumes the workspace',async()=>{
 let finish!:(s:Snapshot)=>void,locks=0;const applied:Snapshot[]=[];
 const sync=new WorkspaceSync(()=>new Promise(r=>finish=r),s=>applied.push(s),()=>locks++);
 const old=sync.refresh();sync.locked();finish({vault:{unlocked:true}} as Snapshot);await old;
 assert.equal(locks,1);assert.equal(applied.length,0);
 const fresh=sync.refresh();finish({vault:{unlocked:false}} as Snapshot);await fresh;
 assert.equal(applied.at(-1)?.vault.unlocked,false);
 const unlocked=sync.refresh();finish({vault:{unlocked:true}} as Snapshot);await unlocked;
 assert.equal(applied.at(-1)?.vault.unlocked,true);
 const closing=sync.refresh();sync.close();finish({vault:{unlocked:false}} as Snapshot);await closing;
 assert.equal(applied.length,2);
});

function browser(){
 const keys=['location','history','window','sessionStorage'] as const;
 const original=keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const),values=new Map<string,string>();
 const location={hash:'#/youtrack'},history={pushState:(_a:unknown,_b:string,url:string)=>{location.hash=url},replaceState:(_a:unknown,_b:string,url:string)=>{location.hash=url}};
 for(const [key,value] of Object.entries({location,history,window:new EventTarget(),sessionStorage:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)}}))Object.defineProperty(globalThis,key,{configurable:true,value});
 return {location,values,close(){for(const [key,descriptor] of original)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}};
}
test('unlock return keeps issue steps, list filters and dashboard ranges; return location persists in tab storage',()=>{
 const b=browser();try{
  for(const route of [
   {page:'logs' as const,tool:'GitLab',step:'error',from:'2026-11-08T00:00:00Z',to:'2026-11-09T00:00:00Z',query:'pipeline'},
   {page:'ai' as const,section:'runs',step:'blocked',tool:'youtrack'},
   {page:'youtrack' as const,issue:'3-0',connection:'example',step:'plan'},
   {page:'alerts' as const,section:'board'},
   {page:'dashboard' as const,section:'day',step:'30'},
  ]){
   const hash=routeHash(route);b.location.hash=hash;b.values.set('support.filter.example','["critical"]');
   openVaultSettings();assert.equal(b.location.hash,'#/settings?section=Vault');assert.equal(b.values.get('support.vault-return'),hash);
   resumeAfterVaultUnlock();assert.equal(b.location.hash,hash);assert.equal(b.values.get('support.filter.example'),'["critical"]');assert.equal(b.values.has('support.vault-return'),false);
  }
 }finally{b.close()}
});
test('leaving Vault intentionally cancels return, and external destinations cannot be restored',()=>{
 const b=browser();try{
  b.location.hash='#/logs?step=error';openVaultSettings();navigate({page:'settings',section:'Model'});navigate({page:'settings',section:'Vault'});resumeAfterVaultUnlock();assert.equal(b.location.hash,'#/settings?section=Vault');
  b.values.set('support.vault-return','https://untrusted.example');resumeAfterVaultUnlock();assert.equal(b.location.hash,'#/settings?section=Vault');assert.equal(b.values.has('support.vault-return'),false);
 }finally{b.close()}
});

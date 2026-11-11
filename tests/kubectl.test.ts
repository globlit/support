import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaults} from '../src/model.js';
import {toolboxKubectl} from '../server/toolbox.js';

const linux=process.platform==='linux';
test('kubectl in the sandbox accepts short names, prints tables, describes with events and strips managedFields',{skip:!linux},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-kubectl-')),log=join(dir,'calls');
 const fake=join(dir,'toolbox');
 writeFileSync(fake,`#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
const i=a.indexOf('get'),r=a[i+1];
const pod={metadata:{name:'web-0',namespace:'app',creationTimestamp:new Date(Date.now()-3600e3).toISOString(),managedFields:[{big:'x'.repeat(5000)}]},spec:{nodeName:'n1',containers:[{}]},status:{phase:'Running',podIP:'10.0.0.5',containerStatuses:[{ready:true,restartCount:2}]}};
if(a.includes('logs')){console.log(JSON.stringify({text:'line 1\\nline 2'}));process.exit(0);}
if(r==='pods'){console.log(JSON.stringify({data:{kind:'PodList',items:[pod]}}));process.exit(0);}
if(r==='networkpolicies.networking.k8s.io'){console.log(JSON.stringify({data:{kind:'NetworkPolicyList',items:[{metadata:{name:'deny-all',namespace:'app'},spec:{podSelector:{}}}]}}));process.exit(0);}
if(r==='events'){console.log(JSON.stringify({data:{kind:'EventList',items:[{type:'Warning',reason:'BackOff',message:'Back-off restarting',involvedObject:{kind:'Pod',name:'web-0'},metadata:{name:'e1'}}]}}));process.exit(0);}
console.log(JSON.stringify({error:'resource is not permitted'}));process.exit(1);
`);chmodSync(fake,0o755);
 const env=process.env.SUPPORT_TOOLBOX_BINARY;process.env.SUPPORT_TOOLBOX_BINARY=fake;
 const config=structuredClone(defaults);config.connections.Toolbox={...config.connections.Toolbox,enabled:true,path:join(dir,'toolbox.json'),scope:'dev'};
 const run=(...args:string[])=>toolboxKubectl(config,args,new AbortController().signal,null);
 try{
  let r=await run('get','po','-n','app','--context','dev');
  assert.equal(r.code,0);assert.match(r.stdout,/^NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE\nweb-0\s+1\/1\s+Running\s+2\s+60m$/);
  r=await run('get','pods','-n','app','-o','wide');assert.match(r.stdout,/IP\s+NODE/);assert.match(r.stdout,/10\.0\.0\.5\s+n1/);
  r=await run('get','netpol','-n','app');assert.match(r.stdout,/deny-all/);
  const calls=readFileSync(log,'utf8');assert.match(calls,/"networkpolicies\.networking\.k8s\.io"/);
  r=await run('get','pods','-n','app','-o','json');assert.ok(!r.stdout.includes('managedFields'));
  r=await run('describe','pod','web-0','-n','app');assert.match(r.stdout,/# Pod\/web-0/);assert.match(r.stdout,/Events:\nTYPE\s+REASON\s+OBJECT\s+MESSAGE/);assert.match(r.stdout,/BackOff/);assert.ok(!r.stdout.includes('managedFields'));
  r=await run('logs','pod/web-0','-n','app','--tail','5');assert.equal(r.stdout,'line 1\nline 2');assert.match(readFileSync(log,'utf8'),/"--tail","5"/);
  r=await run('exec','web-0','--','sh');assert.equal(r.code,1);assert.match(r.stderr,/not available/);
  r=await run('get','pods','-o','jsonpath={.items}');assert.equal(r.code,1);assert.match(r.stderr,/-o json and jq/);
  r=await run('get','secrets');assert.equal(r.code,1);assert.match(r.stderr,/not in the Toolbox catalog/);
 }finally{if(env===undefined)delete process.env.SUPPORT_TOOLBOX_BINARY;else process.env.SUPPORT_TOOLBOX_BINARY=env;rmSync(dir,{recursive:true,force:true});}
});

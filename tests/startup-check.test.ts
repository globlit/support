import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {storedConfigProblem} from '../server/startup-check.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-startup-'));const store=new Store(dir);return {store,dir,done:()=>{store.close();rmSync(dir,{recursive:true,force:true})}};}
test('a readable configuration passes the startup check',()=>{
 const f=fixture();try{assert.equal(storedConfigProblem(f.store,f.dir),undefined);}finally{f.done();}
});
test('settings saved by an earlier version are named in the startup message',()=>{
 const f=fixture();try{
  const config=f.store.snapshot().config;
  f.store.put('config',{...config,modelAuth:'claude_cli',toolbox:{path:'/usr/local/bin/toolbox'}});
  const message=storedConfigProblem(f.store,f.dir)!;
  assert.ok(message.startsWith(`The saved configuration in ${f.dir} cannot be read by this version of Support.`));
  assert.match(message,/- modelAuth: /);assert.match(message,/Unrecognized key/);assert.match(message,/did not start/);
 }finally{f.done();}
});
test('a corrupt stored value is reported without throwing', ()=>{
 const f=fixture();try{
  f.store.db.prepare("UPDATE state SET value='{broken' WHERE id='config'").run();
  assert.match(storedConfigProblem(f.store,f.dir)!,/^The saved configuration[\s\S]*\n- /);
 }finally{f.done();}
});
test('the message lists at most ten rejected settings and counts the rest',()=>{
 const f=fixture();try{
  const config=f.store.snapshot().config;
  f.store.put('config',{...config,modelAuth:'x',modelProvider:'x',theme:'x',hoursStart:1,hoursEnd:1,engineer:'',timezone:1,retentionDays:'x',maxRuns:'x',connections:{}});
  const lines=storedConfigProblem(f.store,f.dir)!.split('\n').filter(l=>l.startsWith('- '));
  assert.equal(lines.length,11);assert.match(lines[10],/^- \d+ more$/);
 }finally{f.done();}
});

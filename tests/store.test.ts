import {test} from './authenticated-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestStore as Store} from './authenticated-fixture.js';
import {configSchema} from '../src/model.js';
import {onDisk} from './disk.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-test-'));const store=new Store(dir);return {store,dir,done:()=>{store.close();rmSync(dir,{recursive:true,force:true})}}}
test('configuration changes clear work session approvals and stale settings cannot overwrite',()=>{const f=fixture();try{
 const issue={connection:'fixture',id:'1',key:'LAB-1',updated:1,title:'',description:'',resolved:false,status:'Open',severity:'',assignee:'',project:'',fields:{},url:''};
 const state=f.store.snapshot();const w=f.store.workSession(issue);w.plans=[{version:1,text:'Inspect the service',at:new Date().toISOString()}];w.approval={version:1,sourceUpdated:1,configRevision:state.configRevision,actor:'Engineer',actorId:'a',workspaceId:'w',at:new Date().toISOString()} as typeof w.approval;f.store.saveWorkSession(w);
 f.store.config({...state.config,retentionDays:7},state.configRevision);
 const after=f.store.workSession(issue);assert.equal(after.approval,null);assert.equal(after.plans.length,1);assert.ok(after.revision>w.revision);
 assert.throws(()=>f.store.config(state.config,state.configRevision),/another window/);assert.equal(f.store.snapshot().config.retentionDays,7)}finally{f.done()}});
test('vault stays encrypted and locks on restart',()=>{const f=fixture();let reopened:Store|undefined;try{f.store.unlock('a sufficiently long test passphrase',true);f.store.credential('GitLab','secret-token-must-not-be-in-database');const raw=f.store.db.prepare('SELECT value FROM secrets WHERE id=?').get('GitLab') as {value:string};assert.ok(!raw.value.includes('secret-token'));assert.equal(f.store.decrypt(raw.value,f.store.key!),'secret-token-must-not-be-in-database');f.store.lock();assert.throws(()=>f.store.credential('Slack','token'),/Unlock/);assert.throws(()=>f.store.unlock('wrong passphrase value'),/Incorrect/);reopened=new Store(f.dir);assert.equal(reopened.vaultStatus().unlocked,false);assert.deepEqual(reopened.vaultStatus().credentials,[]);assert.throws(()=>reopened!.snapshot(),/Unlock/);reopened.unlock('a sufficiently long test passphrase');assert.ok(reopened.key);assert.deepEqual(reopened.vaultStatus().credentials,['GitLab']);assert.ok(!readFileSync(join(f.dir,'support.sqlite')).includes(Buffer.from('secret-token-must-not-be-in-database')))}finally{reopened?.close();f.done()}});
test('the database file is encrypted and cannot be read without the passphrase',async()=>{const f=fixture();try{
 f.store.unlock('a sufficiently long test passphrase',true);f.store.put('marker','ticket-text-that-must-not-be-on-disk');f.store.lock();
 assert.ok(!onDisk(f.store).includes('ticket-text-that-must-not-be-on-disk'));assert.ok(!onDisk(f.store).includes('SQLite format 3'));
 const {default:Database}=await import('better-sqlite3-multiple-ciphers');assert.throws(()=>(new Database(f.store.file).prepare('SELECT count(*) FROM sqlite_master') as {get():unknown}).get(),/not a database|encrypted/i);
 f.store.unlock('a sufficiently long test passphrase');assert.equal(f.store.get('marker'),'ticket-text-that-must-not-be-on-disk');
}finally{f.done()}});
test('configuration rejects inline credentials and credential-bearing URLs',()=>{const f=fixture();try{const c=f.store.snapshot().config;assert.equal(configSchema.safeParse({...c,token:'secret'}).success,false);assert.equal(configSchema.safeParse({...c,connections:{...c.connections,GitLab:{...c.connections.GitLab,endpoint:'https://user:secret@gitlab.internal'}}}).success,false);assert.equal(configSchema.safeParse({...c,connections:{...c.connections,GitLab:{...c.connections.GitLab,endpoint:'https://gitlab.internal?token=secret'}}}).success,false)}finally{f.done()}});

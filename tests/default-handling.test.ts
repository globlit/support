import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {handling} from '../server/intake.js';
import {configSchema} from '../src/model.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'support-default-handling-'));const store=new Store(dir);store.unlock('default handling passphrase',true);return {store,close(){store.close();rmSync(dir,{recursive:true,force:true})}};}
const setDefault=(store:Store,defaultHandling:'ignore'|'ticket'|'investigate')=>{const s=store.snapshot();store.config({...s.config,alerting:{...s.config.alerting,defaultHandling}},s.configRevision);};

test('alerts without a decision follow the default handling setting, which defaults to ignore',()=>{const f=fixture();try{
 const alert={connection:'alertmanager:abc',id:'a1'};
 assert.equal(f.store.snapshot().config.alerting.defaultHandling,'ignore');
 assert.deepEqual([handling(f.store,alert).mode,handling(f.store,alert).defaultIgnored],['pending',true]);
 setDefault(f.store,'ticket');assert.equal(handling(f.store,alert).mode,'ticket');assert.equal(handling(f.store,alert).defaultIgnored,undefined);
 setDefault(f.store,'investigate');assert.equal(handling(f.store,alert).mode,'investigate');
 f.store.put('handling:alertmanager:abc:a1',{mode:'human',reason:'Mine',revision:1,at:'',actor:'me',history:[]});
 assert.equal(handling(f.store,alert).mode,'human');
 assert.equal(handling(f.store,{connection:'yt',id:'1'}).mode,'investigate');
 assert.deepEqual([handling(f.store,{connection:'slack:support',id:'s1'}).mode,handling(f.store,{connection:'slack:support',id:'s1'}).defaultIgnored],['pending',undefined]);
}finally{f.close()}});
test('stored configurations without the setting load with ignore',()=>{const f=fixture();try{
 const s=f.store.snapshot();const {defaultHandling:_removed,...legacy}=s.config.alerting;
 assert.equal(configSchema.parse({...s.config,alerting:legacy}).alerting.defaultHandling,'ignore');
 assert.equal(configSchema.safeParse({...s.config,alerting:{...legacy,defaultHandling:'ask'}}).success,false);
}finally{f.close()}});

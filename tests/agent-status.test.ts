import test from 'node:test';
import assert from 'node:assert/strict';
import {agentCards,type AgentStatusInput} from '../src/agent-status';
const ok:AgentStatusInput={halted:false,sandbox:{configured:true,reachable:true},gateway:{listening:true},kubernetes:{name:'Kubernetes',state:'green',label:'Reachable',detail:'2 contexts answer.'},modelHealth:{name:'Model',state:'green',label:'Reachable',detail:'ok'}};
const tone=(s:AgentStatusInput,key:string,now?:number)=>agentCards(s,now).find(c=>c.key===key)!;
test('every component is green when nothing is wrong',()=>{assert.deepEqual(agentCards(ok).map(c=>c.tone),['green','green','green','green','green']);});
test('Stop all shows a red agent card with Resume',()=>{const c=tone({...ok,halted:true},'agent');assert.equal(c.tone,'red');assert.equal(c.resume,true);});
test('a usage limit is yellow until its reset time and ignored afterwards',()=>{
 const limit={at:'2026-11-11T10:00:00Z',resetAt:'2026-11-11T12:00:00Z'};
 assert.equal(tone({...ok,model:{limit}},'model',Date.parse('2026-11-11T11:00:00Z')).text,'Usage limit');
 assert.equal(tone({...ok,model:{limit}},'model',Date.parse('2026-11-11T13:00:00Z')).tone,'green');
 assert.equal(tone({...ok,model:{limit:{at:limit.at}}},'model',Date.parse('2026-11-12T00:00:00Z')).text,'Usage limit');
});
test('an unreachable sandbox, a missing gateway and a failing context are red',()=>{
 assert.equal(tone({...ok,sandbox:{configured:true,reachable:false,lastOkAt:'2026-11-11T09:00:00Z'}},'sandbox').text,'Unreachable');
 assert.equal(tone({...ok,sandbox:{configured:false,reachable:false}},'sandbox').text,'Not configured');
 assert.equal(tone({...ok,gateway:{listening:false}},'gateway').detail,'SUPPORT_RELAY_BIND is missing.');
 assert.equal(tone({...ok,kubernetes:{name:'Kubernetes',state:'red',label:'Failed',detail:'1 of 2 contexts failed.'}},'kubernetes').tone,'red');
});
test('a failed run without a limit makes the model card yellow and a disabled Kubernetes connection is off',()=>{
 assert.equal(tone({...ok,model:{lastError:'The agent session failed.'}},'model').tone,'yellow');
 assert.equal(tone({...ok,kubernetes:{name:'Kubernetes',state:'off',label:'Disabled',detail:''}},'kubernetes').tone,'off');
});

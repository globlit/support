import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {defaults,type Snapshot,type AlertDetail} from '../src/model.js';
import {Dashboard} from '../src/Dashboard.js';
import {Alerts} from '../src/Alerts.js';
import {YouTrackTickets} from '../src/YouTrackTickets.js';
import {IntakeDecision,SourceTrail} from '../src/IntakeDecision.js';
import {requestOrigin} from '../src/intake-model.js';
import {vaultRecovery} from '../src/RecoveryState.js';
import {routeHash} from '../src/navigation.js';

test('Dashboard, Alerts and YouTrack share one locked-Vault presentation without queue controls or duplicate notices',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'location');
 Object.defineProperty(globalThis,'location',{configurable:true,value:{hash:'#/youtrack'}});
 try{
  const config=structuredClone(defaults);config.connections.YouTrack={enabled:true,endpoint:'https://yt.test',scope:'project: LAB',path:''};config.connections.Alertmanager={enabled:true,endpoint:'https://am.test',scope:'',path:''};
  const data={config,configRevision:1,vault:{initialized:true,unlocked:false,credentials:['YouTrack']},tickets:[]} as unknown as Snapshot;
  const pages=[createElement(Dashboard,{data}),createElement(Alerts,{data,openTicket:()=>{}}),createElement(YouTrackTickets,{data})];
  for(const page of pages){const html=renderToStaticMarkup(page);assert.match(html,/<div class="empty-state" role="status"><h2>Unlock your Vault<\/h2>/);assert.equal((html.match(/>Unlock Vault<\/button>/g)??[]).length,1);assert.doesNotMatch(html,/recovery-notice|queue-toolbar|<table|Dashboard interval|Set up/);}
  assert.equal(routeHash(vaultRecovery(data.vault,'load tickets').route),'#/settings?section=Vault');
  assert.equal(vaultRecovery({initialized:false},'load tickets').action,'Create Vault');
 }finally{if(descriptor)Object.defineProperty(globalThis,'location',descriptor);else Reflect.deleteProperty(globalThis,'location')}
});

test('linked alerts keep ignore available and legacy handoffs identify the original alert',()=>{
 const detail={issue:{connection:'alertmanager:test',id:'a'},session:{handling:{mode:'investigate',history:[]}},alert:{title:'ServiceDown',members:[],ticket:{key:'LAB-1'}}} as unknown as AlertDetail;
 const html=renderToStaticMarkup(createElement(IntakeDecision,{detail,alert:detail.alert,changed:()=>{}}));
 assert.match(html,/Continues in LAB-1/);assert.match(html,/>Ignore alert<\/button>/);assert.doesNotMatch(html,/The agent may investigate/);
 const session={alertHandoffs:[{alertId:'a',alertConnection:'alertmanager:test',alertTitle:'ServiceDown'}]} as unknown as AlertDetail['session'];
 assert.equal(requestOrigin(session)?.kind,'alert');
 const trail=renderToStaticMarkup(createElement(SourceTrail,{detail:{...detail,issue:{...detail.issue,connection:'youtrack',key:'LAB-1'},session}}));
 assert.match(trail,/ServiceDown/);assert.match(trail,/LAB-1/);
 const explicit={kind:'slack' as const,id:'s',connection:'slack:test',title:'Slack question'};
 assert.deepEqual(requestOrigin({...session,origin:explicit}),explicit);
});

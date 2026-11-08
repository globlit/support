import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults,type Snapshot} from '../src/model.js';
import {youTrackRecovery} from '../src/youtrack-recovery.js';
import {routeHash} from '../src/navigation.js';
function fixture():Pick<Snapshot,'config'|'vault'>{const config=structuredClone(defaults);config.connections.YouTrack={endpoint:'https://yt.internal',scope:'project: LAB',enabled:true,path:''};return {config,vault:{initialized:true,unlocked:true,credentials:['YouTrack']}};}
test('a configured connection with a locked vault routes to Vault, including stale browser status',()=>{
 const data=fixture();data.vault.unlocked=false;let result=youTrackRecovery(data)!;
 assert.equal(result.action,'Unlock Vault');assert.equal(routeHash(result.route),'#/settings?section=Vault');assert.doesNotMatch(result.message,/Configure|search query/);
 data.vault.unlocked=true;result=youTrackRecovery(data,'Unlock the credential vault in Settings → Vault first.',423)!;assert.equal(result.action,'Unlock Vault');
});
test('missing URL, query or disabled intake routes directly to YouTrack connection settings',()=>{
 for(const field of ['endpoint','scope','enabled'] as const){const data=fixture();if(field==='enabled')data.config.connections.YouTrack.enabled=false;else data.config.connections.YouTrack[field]='';data.vault.unlocked=false;const result=youTrackRecovery(data)!;assert.equal(routeHash(result.route),'#/settings?section=Connections&tool=YouTrack');assert.equal(result.title,'Set up YouTrack');}
});
test('missing vault, missing token and rejected credentials each explain their own recovery',()=>{
 const data=fixture();data.vault.initialized=false;assert.equal(youTrackRecovery(data)?.action,'Create Vault');data.vault.initialized=true;data.vault.credentials=[];
 assert.equal(youTrackRecovery(data)?.action,'Add YouTrack token');data.vault.credentials=['YouTrack'];
 for(const error of ['YouTrack rejected the token.','The token cannot read this YouTrack resource.'])assert.equal(youTrackRecovery(data,error,403)?.route.section,'Vault');
 assert.equal(youTrackRecovery(data),null);const network=youTrackRecovery(data,'YouTrack could not be reached.',502)!;assert.equal(network.route.tool,'YouTrack');assert.equal(network.retry,true);
});

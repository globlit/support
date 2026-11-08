import type {Snapshot} from './model';
import type {Route} from './navigation';
export type YouTrackRecovery={title:string;message:string;action:string;route:Route;retry?:boolean};
const vault:Route={page:'settings',section:'Vault'};
const connection:Route={page:'settings',section:'Connections',tool:'YouTrack'};
/** Use saved prerequisites first; a locked vault is not a missing connection. */
export function youTrackRecovery(data:Pick<Snapshot,'config'|'vault'>,error='',status?:number):YouTrackRecovery|null{
 const config=data.config.connections.YouTrack;
 const missing=[!config.endpoint.trim()?'instance URL':null,!config.scope.trim()?'search query':null].filter(Boolean);
 if(missing.length||!config.enabled)return {title:'Set up YouTrack',message:missing.length?`Add the ${missing.join(' and ')} in YouTrack connection settings.${!config.enabled?' Turn on ticket intake there too.':''}`:'Turn on ticket intake in YouTrack connection settings.',action:'Open YouTrack settings',route:connection};
 if(!data.vault.initialized)return {title:'Create your Vault',message:'Your YouTrack connection is configured. Create the Vault to store its access token.',action:'Create Vault',route:vault};
 if(!data.vault.unlocked||status===423)return {title:'Unlock your Vault',message:'Your YouTrack connection is configured. Unlock the Vault to use its saved token and load tickets.',action:'Unlock Vault',route:vault};
 if(!data.vault.credentials.includes('YouTrack'))return {title:'Add a YouTrack token',message:'Your instance URL and query are configured. Add a YouTrack permanent token under Credentials in YouTrack connection settings.',action:'Add YouTrack token',route:connection};
 if(error==='YouTrack rejected the token.'||error==='The token cannot read this YouTrack resource.')return {title:error.startsWith('YouTrack rejected')?'YouTrack token rejected':'YouTrack token needs access',message:error.startsWith('YouTrack rejected')?'Replace the YouTrack token under Credentials in YouTrack connection settings. Your connection settings are already saved.':'The saved token cannot read this resource. Check its YouTrack permissions or replace it under Credentials in YouTrack connection settings.',action:'Review YouTrack token',route:connection};
 if(!error)return null;
 if(error.includes('rate limit')||status===409)return {title:'Try loading tickets again',message:error,action:'Open YouTrack settings',route:connection,retry:true};
 return {title:'Could not load YouTrack',message:error,action:'Check YouTrack settings',route:connection,retry:true};
}

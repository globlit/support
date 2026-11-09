import {configSchema,type Config} from './model';
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function mergeSettings(base:Config,draft:Config,saved:Config){
 const conflicts:string[]=[];
 function merge(b:unknown,d:unknown,s:unknown,path:string):unknown{
  if(equal(d,b))return s;if(equal(s,b)||equal(d,s))return d;
  if(b&&d&&s&&typeof b==='object'&&typeof d==='object'&&typeof s==='object'&&!Array.isArray(b)&&!Array.isArray(d)&&!Array.isArray(s))return Object.fromEntries(Object.keys(s).map(k=>[k,merge((b as Record<string,unknown>)[k],(d as Record<string,unknown>)[k],(s as Record<string,unknown>)[k],path?path+'.'+k:k)]));
  conflicts.push(path);return d;
 }
 return {config:merge(base,draft,saved,'') as Config,conflicts};
}
export function settingsSection(path:string){if(path.startsWith('connections.Model')||path.startsWith('model'))return 'Model';if(path.startsWith('connections.')||path.startsWith('alerting'))return 'Connections';if(path.startsWith('notifications'))return 'Notifications';if(path==='retentionDays')return 'Storage & export';if(path==='excludedNamespaces'||path==='maxRuns'||path==='autoInvestigate')return 'Approvals & access';return 'General';}
export function settingsErrors(config:Config){const result=configSchema.safeParse(config);return result.success?[]:result.error.issues.map(i=>({path:i.path.join('.'),message:i.message,section:settingsSection(i.path.join('.'))}));}
/**
 * Saves the configuration when `changed` is true, then each pending credential in key order.
 * Calls `stored` after each saved credential and stops at the first failure, so unsaved credentials stay pending.
 * Returns the names of the saved credentials.
 */
export async function saveSettingsAndCredentials<N extends string>(changed:boolean,saveConfig:()=>Promise<void>,pending:Partial<Record<N,unknown>>,saveCredential:(body:unknown)=>Promise<unknown>,stored:(name:N)=>void){
 if(changed)await saveConfig();
 const names=Object.keys(pending) as N[];
 for(const name of names){await saveCredential(pending[name]);stored(name);}
 return names;
}

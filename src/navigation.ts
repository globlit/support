export const pages=['dashboard','youtrack','slack','alerts','ai','logs','workflows','settings','onboarding','auth'] as const;
export type AppPage=typeof pages[number];
export type Route={page:AppPage;issue?:string;connection?:string;step?:string;section?:string;tool?:string;result?:string;from?:string;to?:string;zone?:string;focus?:string;query?:string};
export function parseRoute(hash:string):Route{
 const [path,query='']=hash.replace(/^#\/?/,'').split('?');
 const page=pages.includes(path as AppPage)?path as AppPage:'youtrack';
 const params=new URLSearchParams(query),r:Route={page};
 for(const key of ['issue','connection','step','section','tool','result','from','to','zone','focus','query'] as const){const v=params.get(key);if(v&&v.length<=200&&!/[\x00-\x1f]/.test(v))r[key]=v;}
 return r.page==='onboarding'?{page:'settings',section:'Setup & tour'}:r;
}
export function routeHash(route:Route){const q=new URLSearchParams();for(const key of ['issue','connection','step','section','tool','result','from','to','zone','focus','query'] as const)if(route[key])q.set(key,route[key]!);return '#/'+route.page+(q.size?'?'+q:'');}
const vaultReturnKey='support.vault-return';
let vaultReturn:string|null=null;
const isVault=(route:Route)=>route.page==='settings'&&route.section==='Vault';
function clearVaultReturn(){vaultReturn=null;try{sessionStorage.removeItem(vaultReturnKey)}catch{/* In-memory navigation still works. */}}
export function openVaultSettings(){
 const current=parseRoute(location.hash);
 if(!isVault(current)&&current.page!=='auth'){
  vaultReturn=routeHash(current);try{sessionStorage.setItem(vaultReturnKey,vaultReturn)}catch{/* Storage may be unavailable. */}
 }
 navigate({page:'settings',section:'Vault'});
}
export function resumeAfterVaultUnlock(){
 if(!isVault(parseRoute(location.hash)))return;
 let saved=vaultReturn;try{saved=sessionStorage.getItem(vaultReturnKey)??saved}catch{/* Use the in-memory fallback. */}
 if(!saved)return;
 clearVaultReturn();
 if(!saved.startsWith('#/'))return;
 const target=parseRoute(saved);if(target.page!=='auth'&&!isVault(target))navigate(target,true);
}
export function navigate(route:Route,replace=false){const next=routeHash(route);if(location.hash===next)return;if(isVault(parseRoute(location.hash))&&!isVault(route))clearVaultReturn();history[replace?'replaceState':'pushState'](null,'',next);window.dispatchEvent(new Event('support:navigate'));}

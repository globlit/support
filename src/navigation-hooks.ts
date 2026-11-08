import {useEffect,useState} from 'react';
import type {Route} from './navigation';
import {useWorkspaceNavigation} from './WorkspaceRuntime';
// URL-backed tabs and filters. Draft text stays out of the route.
export function useRouteChoice<K extends keyof Omit<Route,'page'|'issue'|'connection'|'result'>,T extends string>(key:K,values:readonly T[],fallback:T):[T,(value:string|((current:T)=>T))=>void]{
 const {navigate,readRoute}=useWorkspaceNavigation();
 const read=()=>{const value=readRoute()[key];return values.includes(value as T)?value as T:fallback;};
 const [value,setValue]=useState<T>(read);
 useEffect(()=>{const sync=()=>setValue(read());window.addEventListener('support:navigate',sync);window.addEventListener('hashchange',sync);window.addEventListener('popstate',sync);return()=>{window.removeEventListener('support:navigate',sync);window.removeEventListener('hashchange',sync);window.removeEventListener('popstate',sync)}},[key,fallback]);
 return [value,(update)=>{const next=typeof update==='function'?update(value):update;if(!values.includes(next as T))return;setValue(next as T);navigate({...readRoute(),[key]:next},true)}];
}

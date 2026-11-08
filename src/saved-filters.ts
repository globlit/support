import {useWorkspacePreview} from './WorkspaceRuntime';
import {useEffect,useState} from 'react';
type FilterValue=string|string[];
export function parseSavedFilter<T extends FilterValue>(raw:string|null,fallback:T):T{
 try{const value=JSON.parse(raw??'null');if(typeof fallback==='string')return typeof value==='string'&&value.length<=2000?value as T:fallback;if(Array.isArray(value)&&value.length<=100&&value.every(v=>typeof v==='string'&&v.length<=500))return value as T;}catch{}return fallback;
}
function read<T extends FilterValue>(key:string,fallback:T){try{return parseSavedFilter(sessionStorage.getItem('support.filter.'+key),fallback)}catch{return fallback}}
// Tab-local preferences. Never stored in config or URLs.
export function useSavedFilter<T extends FilterValue>(key:string,fallback:T):[T,(next:T|((previous:T)=>T))=>void]{
 const preview=useWorkspacePreview();const load=()=>preview?fallback:read(key,fallback);
 const [state,setState]=useState(()=>({key,value:load()}));
 const value=state.key===key?state.value:load();
 useEffect(()=>{if(state.key!==key)setState({key,value:load()})},[key,state.key]);
 return [value,next=>{const updated=typeof next==='function'?next(value):next;try{if(!preview)sessionStorage.setItem('support.filter.'+key,JSON.stringify(updated))}catch{/* Storage may be unavailable; filtering still works in memory. */}setState({key,value:updated})}];
}

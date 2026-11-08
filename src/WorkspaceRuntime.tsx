import {createContext,useContext,type ReactNode} from 'react';
import {api} from './api';
import {navigate,parseRoute,type Route} from './navigation';
import type {HandlingMode} from './intake-model';

// Scoped dependencies let the tour render production screens without service access,
// browser navigation, or changes to the engineer's saved filters.
export type WorkspacePreview={
 request:typeof api;
 route:Route;
 intakeEditor?:{choice:HandlingMode|'ignore';reason:string;duration?:string;scope?:string;values?:string[]};
};
const PreviewContext=createContext<WorkspacePreview|null>(null);
export function WorkspacePreviewProvider({value,children}:{value:WorkspacePreview;children:ReactNode}){
 return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}
export const useWorkspacePreview=()=>useContext(PreviewContext);
export function useWorkspaceApi(){return useWorkspacePreview()?.request??api;}
const readBrowserRoute=()=>parseRoute(location.hash);
const ignoreNavigation=()=>{};
export function useWorkspaceNavigation(){const preview=useWorkspacePreview();return {readRoute:preview?()=>preview.route:readBrowserRoute,navigate:preview?ignoreNavigation:navigate};}

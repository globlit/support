import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store.js';
export type Principal={id:string;workspaceId:string;name:string;role:'owner'};
const context=new AsyncLocalStorage<{principal:Principal;valid:()=>boolean}>();
export function workspaceIdentity(store:Store){
 let identity=store.get<{workspaceId:string;ownerId:string}>('security.identity.v1');
 if(!identity){identity={workspaceId:randomUUID(),ownerId:randomUUID()};store.put('security.identity.v1',identity);}
 return identity;
}
export function localOwner(store:Store):Principal{const i=workspaceIdentity(store);return {id:i.ownerId,workspaceId:i.workspaceId,name:'Workspace owner',role:'owner'};}
export function withIdentity<T>(principal:Principal,valid:()=>boolean,work:()=>T):T{return context.run({principal:Object.freeze({...principal}),valid},work);}
export function assertActiveRequest(){const current=context.getStore();if(current&&!current.valid())throw new AppError(401,'Sign in again before changing this work.','SESSION_REQUIRED');}
export function humanAttribution(store:Store){
 const current=context.getStore();
 if(!current||!current.valid())throw new AppError(401,'Sign in again before approving or changing this work.','SESSION_REQUIRED');
 if(current.principal.workspaceId!==workspaceIdentity(store).workspaceId)throw new AppError(403,'This identity belongs to another workspace.');
 return {actor:current.principal.name,actorId:current.principal.id,workspaceId:current.principal.workspaceId};
}
/** Approval record of the signed-in engineer for the content with `hash`. Throws 401 or 403 like `humanAttribution`. */
export function approval(store:Store,hash:string){return {hash,...humanAttribution(store),at:new Date().toISOString()};}

import {test as nodeTest,type TestContext,type TestOptions} from 'node:test';
import {Store} from '../server/store.js';
import {withIdentity,type Principal} from '../server/identity.js';
// Human identity for service-level fixtures.
const principal:Principal={id:'test-owner',workspaceId:'test-workspace',name:'Workspace owner',role:'owner'};
export class TestStore extends Store{
 constructor(dir:string){super(dir);if(!this.get('security.identity.v1'))this.put('security.identity.v1',{workspaceId:principal.workspaceId,ownerId:principal.id});}
}
export const test=((name:string,options:TestOptions|((t:TestContext)=>void|Promise<void>),fn?:(t:TestContext)=>void|Promise<void>)=>{
 const body=typeof options==='function'?options:fn!;
 return nodeTest(name,typeof options==='function'?{}:options,t=>withIdentity(principal,()=>true,()=>body(t)));
}) as typeof nodeTest;

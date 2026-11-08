export type BrowserSession={authenticated:boolean;initialized:boolean;principal?:{id:string;workspaceId:string;name:string;role:'owner'};csrf?:string;expiresAt?:number;deployment?:{mode:'local'|'container';publicOrigin:string}};
export const sessionEvent='support:session-changed';
let csrf:string|undefined;let generation=0;
export function csrfToken(){return csrf;}
export function sessionLost(){++generation;csrf=undefined;if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(sessionEvent,{detail:{authenticated:false}}));}
export async function refreshSession():Promise<BrowserSession>{
 const current=++generation;const res=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'});
 if(!res.ok)throw new Error('Could not check the browser session.');
 const session:BrowserSession=await res.json();if(current!==generation)return session;csrf=session.csrf;
 if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(sessionEvent,{detail:session}));return session;
}

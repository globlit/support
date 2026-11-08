import type {Snapshot} from './model';

export const vaultEvent='support:vault-changed';
export function notifyVaultChange(unlocked:boolean){
 if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(vaultEvent,{detail:{unlocked}}));
}

/** A lock invalidates older reads so a slow response cannot reopen the UI. */
export class WorkspaceSync{
 private generation=0;
 private active=true;
 constructor(private read:()=>Promise<Snapshot>,private apply:(snapshot:Snapshot)=>void,private lock:()=>void){}
 async refresh(){const generation=++this.generation;const next=await this.read();if(this.active&&generation===this.generation)this.apply(next);return next;}
 locked(){++this.generation;if(this.active)this.lock();}
 close(){this.active=false;++this.generation;}
}

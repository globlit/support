import {navigate,openVaultSettings,type Route} from './navigation';
import type {Snapshot} from './model';

export type Recovery={title:string;message:string;action:string;route:Route;retry?:boolean};

/** One full-page recovery presentation for blocked workspace views. */
export function RecoveryState({recovery,retry}:{recovery:Recovery;retry?:()=>void}){
 return <div className="empty-state" role="status"><h2>{recovery.title}</h2><p>{recovery.message}</p><div className="actions" style={{justifyContent:'center'}}>{recovery.retry&&retry&&<button type="button" onClick={retry}>Retry</button>}<button type="button" onClick={()=>['Unlock Vault','Create Vault'].includes(recovery.action)?openVaultSettings():navigate(recovery.route)}>{recovery.action}</button></div></div>;
}

export function vaultRecovery(vault:Pick<Snapshot['vault'],'initialized'>,purpose:string):Recovery{
 return {title:vault.initialized?'Unlock your Vault':'Create your Vault',message:vault.initialized?`Unlock the Vault to ${purpose}.`:`Create the Vault to ${purpose}.`,action:vault.initialized?'Unlock Vault':'Create Vault',route:{page:'settings',section:'Vault'}};
}

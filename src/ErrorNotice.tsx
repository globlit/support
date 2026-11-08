import type {ReactNode} from 'react';
import type {ConnectionName} from './model';
import {errorRecovery,recoveryMessage} from './error-recovery';
import {navigate,openVaultSettings} from './navigation';
export function ErrorRecoveryAction({message,context}:{message:string;context?:ConnectionName}){
 const action=errorRecovery(message,context);
 return action?<button type="button" className="text-button recovery-link" onClick={()=>['Unlock Vault','Create Vault'].includes(action.label)?openVaultSettings():navigate(action.route)}>{action.label} →</button>:null;
}
export function ErrorNotice({message,context,detail,retry,tone='error'}:{message:string;context?:ConnectionName;detail?:ReactNode;retry?:()=>void;tone?:'error'|'notice'}){
 return <div className={tone+' recovery-notice'} role={tone==='error'?'alert':'status'}><span>{recoveryMessage(message)}{detail&&<> {detail}</>}</span><div className="recovery-actions"><ErrorRecoveryAction message={message} context={context}/>{retry&&<button type="button" className="text-button" onClick={retry}>Refresh</button>}</div></div>;
}

import type {ConnectionName} from './model';
import type {Route} from './navigation';
export type RecoveryAction={label:string;route:Route};
const vault=(label='Open Vault'):RecoveryAction=>({label,route:{page:'settings',section:'Vault'}});
const model=(label='Open Model settings'):RecoveryAction=>({label,route:{page:'settings',section:'Model'}});
const connection=(tool:ConnectionName):RecoveryAction=>tool==='Model'?model():({label:`Open ${tool} settings`,route:{page:'settings',section:'Connections',tool}});
const credentials=(tool:ConnectionName,label=`Manage ${tool} credentials`):RecoveryAction=>tool==='Model'?model():{label,route:{page:'settings',section:'Connections',tool}};
const logs=(tool?:ConnectionName):RecoveryAction=>({label:tool==='Model'?'View model logs':'View logs',route:{page:'logs',tool,step:'error'}});
const services:ConnectionName[]=['YouTrack','GitLab','Alertmanager','Prometheus','Outline','Slack','Kubernetes','Model'];
/** Recovery destinations come from this allowlist, never from error text. */
export function errorRecovery(message:string,context?:ConnectionName):RecoveryAction|null{
 const m=message.trim();
 if(!m)return null;
 if(/(?:unlock[^.]*vault|vault[^.]*locked|locked[^.]*vault|incorrect vault passphrase|create the vault)/i.test(m))return vault(/create/i.test(m)?'Create Vault':'Unlock Vault');
 const credential=m.match(/^Save the (\w+) credential in the Vault first\./i);
 if(credential){if(/Model|ChatGPT/i.test(credential[1]))return model();const tool=services.find(t=>t.toLowerCase()===credential[1].toLowerCase());return tool?credentials(tool):null;}
 // Rate limits and provider faults are not sign-in failures.
 if(/rate.limit|usage allowance|insufficient_quota|usage_limit_exceeded|temporarily unavailable|provider could not process|provider rejected the model request|signing in again will not|response reached its output limit/i.test(m))return logs(context??(/provider|ChatGPT|Claude/i.test(m)?'Model':undefined));
 // Changed settings need a fresh read, never a write retry.
 if(/changed.*(?:review|refresh|again)|(?:ticket|plan|approval|source|session).*(?:changed|stale)|remote status before retry|pending.*(?:write|creation)|namespace excluded/i.test(m))return null;
 if(/^(?:Continue with ChatGPT|ChatGPT sign-in requires|ChatGPT authentication expired|ChatGPT token exchange|This account has not granted ChatGPT|Sign in to Claude Code|Local Claude requires|Set the absolute path to the Claude|Claude executable|Could not start Claude CLI|Claude CLI could not report login status|Save an API key for the selected model|Select a model from this ChatGPT|Enable Model|The local Claude connection)/i.test(m)||/Settings\s*→\s*Model|selected account|selected model provider/i.test(m))return model();
 if(/^(?:YouTrack rejected the token|The token cannot read this YouTrack resource)/i.test(m))return credentials('YouTrack','Review YouTrack token');
 if(/rejected.*(?:credential|API key)|authentication expired|sign.in (?:expired|required|failed)|check login or usage in Claude Code/i.test(m))return context==='Model'||/ChatGPT|Claude|provider/i.test(m)?model():context&&context!=='Kubernetes'?credentials(context):null;
 if(context==='Model'&&/^(?:Connection returned HTTP|Use HTTPS for model and tool)/.test(m))return logs('Model');
 const named=services.find(tool=>new RegExp('\\b'+tool+'\\b','i').test(m));
 const tool=named??context;
 if(tool&&/connections\.[A-Za-z]+\.|modelAuth|modelProvider/.test(m))return connection(tool);
 if(/Slack: (?:invalid_auth|token_revoked|not_authed|missing_scope)|HTTP (?:401|403)\b|unauthorized|invalid.*token|authentication failed/i.test(m)&&tool)return tool==='Model'?model():tool==='Kubernetes'?connection(tool):credentials(tool);

 if(tool&&/(?:configure|enable|endpoint|base URL|instance URL|HTTPS|could not be reached|connection refused|configuration|context is not enabled|executable path|binary|connection.*unavailable)/i.test(m))return connection(tool);
 if(tool==='Model'&&/returned (?:an? )?(?:unsupported|invalid)|unknown tool call|truncated|no structured result|no result was applied|could not complete/i.test(m))return logs('Model');
 return null;
}

/** Older stored failures sometimes mention the former location of model credentials. */
export function recoveryMessage(message:string){
 if(message==='ChatGPT response failed or reached a limit. Check your ChatGPT usage or sign in again. No result was applied.')return 'This earlier ChatGPT request failed without a detailed error. Review the model logs before retrying. No result was applied.';
 if(message==='Save the Model credential in the Vault first.')return 'Add the model API key in Settings → Model.';
 if(message==='Save the ChatGPT credential in the Vault first.')return 'Connect your ChatGPT account in Settings → Model.';
 if(message==='Enable Model in Connections and set its API base URL, model ID and vault API key.')return 'Configure and enable the model in Settings → Model. Select a model and connect an account or add its API key.';
 return message;
}

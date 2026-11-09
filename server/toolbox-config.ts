import {z} from 'zod';

export const kubeconfigPlaceholder='{{kubeconfig}}';
const kubeconfigKey=/kube[-_]?config/i;
/** Context of a generated configuration, with its allowed and excluded namespace counts. */
const storedContext=z.object({name:z.string(),namespaces:z.number().int(),excluded:z.number().int()}).strict();
/** Vault value: v1 holds a pasted custom configuration, v2 a configuration generated from the Toolbox settings. */
const stored=z.union([
 z.object({v:z.literal(1),toolboxConfig:z.string(),kubeconfig:z.string()}).strict(),
 z.object({v:z.literal(2),toolboxConfig:z.string(),kubeconfig:z.string(),contexts:z.array(storedContext),settingsHash:z.string(),generatedAt:z.string()}).strict(),
]);
export type ToolboxFiles=z.infer<typeof stored>;

type Located={count:number;keyed:number};
function locate(value:unknown,key='',found:Located={count:0,keyed:0}):Located{
 if(typeof value==='string'){if(value===kubeconfigPlaceholder)found.count++;else if(kubeconfigKey.test(key))found.keyed++;}
 else if(Array.isArray(value))for(const item of value)locate(item,key,found);
 else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))locate(v,k,found);
 return found;
}
function replace(value:unknown,path:string,byKey:boolean,key=''):unknown{
 if(typeof value==='string')return value===kubeconfigPlaceholder||(byKey&&kubeconfigKey.test(key))?path:value;
 if(Array.isArray(value))return value.map(item=>replace(item,path,byKey,key));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v,path,byKey,k)]));
 return value;
}

const noNul=(v:string)=>!v.includes('\0');
/** Largest accepted kubeconfig, in bytes: 4 MiB, enough for a merge of many kubeconfig files. */
export const maxKubeconfigBytes=4*1024*1024;
/** Request body that saves a kubeconfig and the contexts to include. Support generates the Toolbox configuration. */
export const toolboxCredentialSchema=z.object({
 kubeconfig:z.string().min(1).max(maxKubeconfigBytes).refine(noNul,'The kubeconfig must not contain NUL characters.').refine(v=>v.trim().length>0,'Paste the kubeconfig.'),
 contexts:z.array(z.string().trim().min(1).max(253)).min(1,'Select at least one context.').max(100),
}).strict();

/** Returns the Vault value for a generated configuration. */
export function toolboxStoredValue(setup:{config:string;contexts:{name:string;namespaces:string[];excluded:number}[]},kubeconfig:string,settingsHash:string,now=new Date()){
 return JSON.stringify({v:2,toolboxConfig:setup.config,kubeconfig,contexts:setup.contexts.map(c=>({name:c.name,namespaces:c.namespaces.length,excluded:c.excluded})),settingsHash,generatedAt:now.toISOString()});
}
export function parseToolboxFiles(raw:string):ToolboxFiles{return stored.parse(JSON.parse(raw));}

/** Returns the Toolbox JSON with the kubeconfig path set to kubeconfigPath. */
export function resolveToolboxConfig(text:string,kubeconfigPath:string){
 const parsed=JSON.parse(text) as unknown,found=locate(parsed);
 if(!found.count&&found.keyed>1)throw new Error('Ambiguous kubeconfig field in the Toolbox configuration.');
 return JSON.stringify(replace(parsed,kubeconfigPath,!found.count&&found.keyed===1),null,1);
}

/** Returns kubeconfig credential values for redaction. */
export function kubeconfigSecrets(text:string){
 const values:string[]=[];
 for(const m of text.matchAll(/^\s*-?\s*(token|password|client-key-data|client-certificate-data|id-token|refresh-token|client-secret)\s*:\s*["']?([^"'\s#]+)/gm))if(m[2].length>=8)values.push(m[2]);
 return values;
}

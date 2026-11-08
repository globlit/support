import {z} from 'zod';

export const kubeconfigPlaceholder='{{kubeconfig}}';
const kubeconfigKey=/kube[-_]?config/i;
const stored=z.object({v:z.literal(1),toolboxConfig:z.string(),kubeconfig:z.string()}).strict();
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
/** Request body for a pasted Toolbox configuration. */
export const toolboxCredentialSchema=z.object({
 config:z.string().min(2).max(65536).refine(noNul,'The Toolbox configuration must not contain NUL characters.').superRefine((text,ctx)=>{
  let parsed:unknown;try{parsed=JSON.parse(text);}catch{ctx.addIssue({code:'custom',message:'The Toolbox configuration is not valid JSON.'});return;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){ctx.addIssue({code:'custom',message:'The Toolbox configuration must be a JSON object.'});return;}
  const found=locate(parsed);
  if(!found.count&&found.keyed>1)ctx.addIssue({code:'custom',message:`Several fields look like a kubeconfig path. Set the right one to "${kubeconfigPlaceholder}".`});
 }),
 kubeconfig:z.string().min(1).max(262144).refine(noNul,'The kubeconfig must not contain NUL characters.').refine(v=>v.trim().length>0,'Paste the kubeconfig.'),
}).strict();

/** Returns the stored Vault value for a pasted Toolbox configuration. */
export function toolboxCredential(input:unknown){const {config,kubeconfig}=toolboxCredentialSchema.parse(input);return JSON.stringify({v:1,toolboxConfig:config,kubeconfig});}
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

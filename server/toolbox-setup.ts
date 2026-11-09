import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import type {ToolboxSettings} from '../src/model.js';
import {AppError} from './store.js';
import {kubeconfigPlaceholder} from './toolbox-config.js';
import {toolboxEnvironment} from './toolbox.js';
const exec=promisify(execFile);

/** Toolbox accepts at most 100 contexts per configuration and 100 namespaces per context. */
export const maxContexts=100,maxNamespaces=100;
export type GeneratedContext={name:string;namespaces:string[];excluded:number};
export type ToolboxSetup={config:string;contexts:GeneratedContext[]};

function binaries(){
 if(process.platform!=='linux')throw new AppError(403,'Toolbox setup requires Support to run on Linux.');
 const kubectl=process.env.SUPPORT_KUBECTL_BINARY??'/usr/local/bin/kubectl',toolbox=process.env.SUPPORT_TOOLBOX_BINARY??'/usr/local/bin/toolbox';
 if(!isAbsolute(kubectl)||!isAbsolute(toolbox))throw new AppError(400,'SUPPORT_KUBECTL_BINARY and SUPPORT_TOOLBOX_BINARY must be absolute paths.');
 return {kubectl,toolbox};
}
/** Returns the last non-empty line of a command error, which carries kubectl's message. */
function lastLine(error:unknown){
 const text=String((error as {stderr?:string})?.stderr??'')||String((error as {stdout?:string})?.stdout??'');
 return (text.split('\n').map(l=>l.trim()).filter(Boolean).at(-1)??'The command failed.').replace(/^error: /,'').slice(0,300);
}
/** True when the namespace matches one of the patterns. "*" matches any characters; other characters match literally. */
export function isExcluded(namespace:string,patterns:string[]){
 return patterns.some(p=>new RegExp('^'+p.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$').test(namespace));
}
/** Hash of the settings and contexts a configuration was generated from, used to detect outdated configurations. */
export function setupHash(settings:ToolboxSettings,contexts:string[]){return createHash('sha256').update(JSON.stringify([settings,[...contexts].sort()])).digest('hex');}

/** Writes the kubeconfig to a private temporary folder, runs `work`, then deletes the folder. */
async function withKubeconfig<T>(kubeconfig:string,work:(path:string,dir:string)=>Promise<T>){
 const dir=await mkdtemp(join(tmpdir(),'support-toolbox-setup-')),path=join(dir,'kubeconfig');
 try{await writeFile(path,kubeconfig,{mode:0o600,flag:'wx'});return await work(path,dir);}
 finally{await rm(dir,{recursive:true,force:true});}
}
const env=()=>({...toolboxEnvironment(),KUBECONFIG:''});

/** Returns the context names of a kubeconfig. Reads the file only: no cluster is contacted. */
export async function kubeconfigContexts(kubeconfig:string){
 const {kubectl}=binaries();
 return withKubeconfig(kubeconfig,async path=>{
  try{const {stdout}=await exec(kubectl,['config','get-contexts','-o','name','--kubeconfig',path],{timeout:20000,maxBuffer:1_000_000,encoding:'utf8',shell:false,env:env()});return stdout.split('\n').map(l=>l.trim()).filter(Boolean);}
  catch(e){throw new AppError(400,`The kubeconfig could not be read: ${lastLine(e)}`);}
 });
}

/** Returns the Toolbox configuration JSON for the given contexts and allowed namespaces. The kubeconfig path is the {{kubeconfig}} placeholder. */
export function toolboxConfigJson(settings:ToolboxSettings,contexts:{name:string;namespaces:string[]}[],kubectl:string){
 return JSON.stringify({
  kubectl:{
   binary:kubectl,kubeconfig:kubeconfigPlaceholder,
   contexts:contexts.map(c=>({name:c.name,default_namespace:c.namespaces.includes('default')?'default':c.namespaces[0],namespaces:c.namespaces,allow_cluster_scoped:settings.allowClusterScoped,allow_port_forward:settings.allowPortForward,disable_configmaps:!settings.allowConfigMaps})),
   timeout_seconds:settings.timeoutSeconds,max_output_bytes:settings.maxOutputMiB*1024*1024,port_forward_max_seconds:settings.portForwardMaxSeconds,
  },
  redaction:{literals:settings.redactionLiterals,patterns:settings.redactionPatterns},
 },null,2);
}

/**
 * Generates a Toolbox configuration. For each selected context, lists the cluster's namespaces with kubectl, removes
 * the excluded patterns, and allows the remaining namespaces. Validates the result with Toolbox before returning it.
 * Fails when a context's namespaces cannot be listed, when none remain, or when more than 100 remain.
 */
export async function generateToolboxSetup(kubeconfig:string,selected:string[],settings:ToolboxSettings):Promise<ToolboxSetup>{
 const {kubectl,toolbox}=binaries();
 const names=[...new Set(selected)];
 if(!names.length)throw new AppError(400,'Select at least one context.');
 if(names.length>maxContexts)throw new AppError(400,`Toolbox accepts at most ${maxContexts} contexts. ${names.length} are selected.`);
 return withKubeconfig(kubeconfig,async (path,dir)=>{
  const available=await kubeconfigContexts(kubeconfig);
  const missing=names.filter(n=>!available.includes(n));
  if(missing.length)throw new AppError(400,`The kubeconfig has no context named ${missing.slice(0,3).join(', ')}.`);
  const contexts:GeneratedContext[]=[];
  for(const name of names){
   let listed:string[];
   try{const {stdout}=await exec(kubectl,['--kubeconfig',path,'--context',name,'get','namespaces','-o','jsonpath={.items[*].metadata.name}','--request-timeout=15s'],{timeout:30000,maxBuffer:4_000_000,encoding:'utf8',shell:false,env:env()});listed=stdout.split(/\s+/).filter(Boolean);}
   catch(e){throw new AppError(400,`Namespaces of context ${name} could not be listed: ${lastLine(e)}. The kubeconfig user needs the list permission on namespaces, and the cluster must be reachable.`);}
   const allowed=listed.filter(ns=>!isExcluded(ns,settings.excludedNamespaces)).sort();
   if(!allowed.length)throw new AppError(400,`Every namespace of context ${name} is excluded. Remove an exclusion or deselect the context.`);
   if(allowed.length>maxNamespaces)throw new AppError(400,`Context ${name} has ${allowed.length} allowed namespaces. Toolbox accepts at most ${maxNamespaces}: exclude more namespaces, for example with patterns like *-preview.`);
   contexts.push({name,namespaces:allowed,excluded:listed.length-allowed.length});
  }
  const config=toolboxConfigJson(settings,contexts,kubectl),check=join(dir,'toolbox.json');
  await writeFile(check,config.replace(JSON.stringify(kubeconfigPlaceholder),JSON.stringify(path)),{mode:0o600,flag:'wx'});
  try{const {stdout}=await exec(toolbox,['--config',check,'kubectl','contexts'],{timeout:20000,maxBuffer:4_000_000,encoding:'utf8',shell:false,env:env()});JSON.parse(stdout);}
  catch(e){throw new AppError(400,`Toolbox rejected the generated configuration: ${lastLine(e)}`);}
  return {config,contexts};
 });
}

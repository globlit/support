import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,join} from 'node:path';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {z} from 'zod';
import type {Config} from '../src/model.js';
import {AppError,type Store} from './store.js';
import {parseToolboxFiles,resolveToolboxConfig,type ToolboxFiles} from './toolbox-config.js';
const exec=promisify(execFile);
export function toolboxEnvironment(source:NodeJS.ProcessEnv=process.env){
 const env:NodeJS.ProcessEnv={};
 for(const key of ['HOME','PATH','LANG','LC_ALL','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_USE_ENV_PROXY'])if(source[key])env[key]=source[key];
 return env;
}
export const resources=['pods','deployments','services','replicasets','daemonsets','statefulsets','jobs','cronjobs','ingresses','persistentvolumeclaims','networkpolicies','events'] as const;
export const contexts=(config:Config)=>config.connections.Toolbox.scope.split(',').map(s=>s.trim()).filter(Boolean);
/** Returns Toolbox arguments for one read. */
export function toolboxArgs(config:Config,input:unknown,configPath=config.connections.Toolbox.path){
 const {context,namespace,resource}=z.object({context:z.string().min(1).max(200),namespace:z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(63),resource:z.enum(resources)}).strict().parse(input);
 const c=config.connections.Toolbox;
 if(!c.enabled||!configPath||!isAbsolute(configPath)||!contexts(config).includes(context))throw new AppError(403,'Toolbox context is not enabled in Settings.');
 for(const pattern of config.excludedNamespaces.split(',').map(s=>s.trim()).filter(Boolean)){
  const regex='^'+pattern.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$';
  if(new RegExp(regex).test(namespace))throw new AppError(403,'Namespace excluded by Settings.');
 }
 return ['--config',configPath,'kubectl','get',resource,'--context',context,'--namespace',namespace,'-o','json'];
}
/** Returns the pasted Toolbox configuration saved in the Vault, or null when none is saved. */
export function toolboxFiles(store:Store):ToolboxFiles|null{
 return store.vaultStatus().credentials.includes('Toolbox')?parseToolboxFiles(store.readCredential('Toolbox')):null;
}
/**
 * Prepares the Toolbox configuration for one run. A pasted configuration and its kubeconfig go to a private temporary
 * folder; otherwise the configured path is used. Call `cleanup` after the run to delete the folder.
 */
async function toolboxRunConfig(config:Config,files:ToolboxFiles|null){
 const env=toolboxEnvironment();
 if(!files)return {configPath:config.connections.Toolbox.path,env,cleanup:async()=>{}};
 const dir=await mkdtemp(join(tmpdir(),'support-toolbox-'));
 const kubeconfig=join(dir,'kubeconfig'),configPath=join(dir,'toolbox.json');
 try{
  await writeFile(kubeconfig,files.kubeconfig,{mode:0o600,flag:'wx'});
  await writeFile(configPath,resolveToolboxConfig(files.toolboxConfig,kubeconfig),{mode:0o600,flag:'wx'});
 }catch(e){await rm(dir,{recursive:true,force:true});throw e;}
 env.KUBECONFIG=kubeconfig;
 return {configPath,env,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
function toolboxBinary(){
 if(process.platform!=='linux')throw new AppError(403,'Toolbox execution requires Support to run on Linux.');
 const binary=process.env.SUPPORT_TOOLBOX_BINARY??'/usr/local/bin/toolbox';
 if(!isAbsolute(binary))throw new AppError(400,'SUPPORT_TOOLBOX_BINARY must be an absolute path.');
 return binary;
}
/** Runs one Toolbox read. Pasted files go to a private temporary folder, deleted after the run. */
export async function readToolbox(config:Config,input:unknown,signal:AbortSignal,files:ToolboxFiles|null=null){
 const binary=toolboxBinary();
 toolboxArgs(config,input,files?'/pasted':undefined);
 let run:Awaited<ReturnType<typeof toolboxRunConfig>>|undefined;
 try{
  run=await toolboxRunConfig(config,files);
  const {stdout}=await exec(binary,toolboxArgs(config,input,run.configPath),{signal,timeout:20000,maxBuffer:512000,encoding:'utf8',shell:false,env:run.env});return JSON.parse(stdout);
 }catch{throw new AppError(502,'Toolbox read failed. Check its binary, configuration, context access and response size where Support runs.');}
 finally{await run?.cleanup();}
}
/**
 * Reads the Kubernetes API version from each allowed context, at most 3, with `toolbox kubectl get --raw /version`.
 * Toolbox reports cluster errors in an `error` field of its JSON output. Returns the reached contexts and their
 * Kubernetes versions, or the first failure.
 */
export async function probeToolboxContexts(config:Config,files:ToolboxFiles|null,signal:AbortSignal,timeoutMs=10000){
 const binary=toolboxBinary(),allowed=contexts(config).slice(0,3);
 if(!allowed.length)return {ok:false,detail:'List the contexts Support may read in Allowed context names.'};
 const run=await toolboxRunConfig(config,files);
 try{
  const reached:string[]=[];
  for(const context of allowed){
   let stdout:string;
   try{stdout=(await exec(binary,['--config',run.configPath,'kubectl','get','--raw','/version','--context',context],{signal,timeout:timeoutMs,maxBuffer:65536,encoding:'utf8',shell:false,env:run.env})).stdout;}
   catch{return {ok:false,detail:`Toolbox could not run for context ${context}. Check its binary and configuration.`};}
   let value:unknown;try{value=JSON.parse(stdout);}catch{return {ok:false,detail:`Toolbox refused the check for context ${context}: ${stdout.trim().split('\n')[0].slice(0,200)}`};}
   if(!value||typeof value!=='object'||'error' in value)return {ok:false,detail:`Context ${context} could not be reached (${String((value as {error?:unknown})?.error??'unexpected response').slice(0,200)}). Check the cluster address, VPN and kubeconfig credentials.`};
   const version=stdout.match(/"gitVersion"\s*:\s*"([^"]+)"/)?.[1];
   reached.push(version?`${context} (Kubernetes ${version})`:context);
  }
  return {ok:true,detail:`Toolbox reached the Kubernetes API in ${reached.join(', ')}.`};
 }finally{await run.cleanup();}
}

/**
 * Generates a Toolbox configuration for a pasted kubeconfig with `toolbox config generate --detect-contexts`.
 * Returns the configuration JSON with the kubeconfig path set to the {{kubeconfig}} placeholder, and the detected context names.
 * Each detected context allows only the `default` namespace. The kubeconfig is written to a private temporary folder, deleted after the run.
 */
export async function generateToolboxConfig(kubeconfig:string){
 if(process.platform!=='linux')throw new AppError(403,'Toolbox execution requires Support to run on Linux.');
 const binary=process.env.SUPPORT_TOOLBOX_BINARY??'/usr/local/bin/toolbox';
 if(!isAbsolute(binary))throw new AppError(400,'SUPPORT_TOOLBOX_BINARY must be an absolute path.');
 const dir=await mkdtemp(join(tmpdir(),'support-toolbox-generate-'));
 try{
  const kubeconfigPath=join(dir,'kubeconfig'),configPath=join(dir,'toolbox.json');
  await writeFile(kubeconfigPath,kubeconfig,{mode:0o600,flag:'wx'});
  try{await exec(binary,['config','generate','--path',configPath,'--detect-contexts','--kubeconfig',kubeconfigPath],{timeout:20000,maxBuffer:512000,encoding:'utf8',shell:false,env:toolboxEnvironment()});}
  catch{throw new AppError(400,'Toolbox could not generate a configuration. Check that the kubeconfig is valid YAML and defines at least one context.');}
  const generated=z.object({kubectl:z.object({kubeconfig:z.string(),context:z.string().nullish(),contexts:z.array(z.object({name:z.string()}).passthrough()).nullish()}).passthrough()}).passthrough().parse(JSON.parse(await readFile(configPath,'utf8')));
  generated.kubectl.kubeconfig='{{kubeconfig}}';
  // Toolbox writes a single detected context to `context` and several to `contexts`.
  const contexts=generated.kubectl.contexts?.length?generated.kubectl.contexts.map(c=>c.name):generated.kubectl.context?[generated.kubectl.context]:[];
  return {config:JSON.stringify(generated,null,2),contexts};
 }finally{await rm(dir,{recursive:true,force:true});}
}

export type KubeconfigFile={name:string;content:string};
type Entry={name:string;[key:string]:unknown};
const kubeconfigView=z.object({clusters:z.array(z.object({name:z.string()}).passthrough()).nullish(),users:z.array(z.object({name:z.string()}).passthrough()).nullish(),contexts:z.array(z.object({name:z.string()}).passthrough()).nullish()}).passthrough();
/** Returns the first line of a kubectl error, with temporary file paths replaced by the uploaded file names. */
function kubectlError(error:unknown,paths:string[],names:string[]){
 let line=String((error as {stderr?:string})?.stderr??'').split('\n').find(l=>l.trim())??'kubectl failed.';
 paths.forEach((path,i)=>{line=line.split(path).join(names[i]);});
 return line.replace(/^error: /,'').slice(0,300);
}

/**
 * Merges kubeconfig files into one self-contained kubeconfig with `kubectl config view --flatten`.
 * The current context comes from the first file that sets one. A cluster, user or context name may appear in several
 * files only with identical content: kubectl keeps only the first entry for a name, so a differing duplicate would make
 * a context use the wrong credentials. Files are written to a private temporary folder, deleted after the merge.
 * Returns the merged kubeconfig YAML and its context names.
 */
export async function mergeKubeconfigs(files:KubeconfigFile[]){
 if(process.platform!=='linux')throw new AppError(403,'Merging kubeconfig files requires Support to run on Linux.');
 const binary=process.env.SUPPORT_KUBECTL_BINARY??'/usr/local/bin/kubectl';
 if(!isAbsolute(binary))throw new AppError(400,'SUPPORT_KUBECTL_BINARY must be an absolute path.');
 const dir=await mkdtemp(join(tmpdir(),'support-kubeconfig-merge-'));
 const names=files.map(f=>f.name),paths=files.map((_,i)=>join(dir,'kubeconfig-'+i));
 try{
  const seen=new Map<string,{file:string;entry:string}>(),conflicts:string[]=[];
  for(const [i,file] of files.entries()){
   await writeFile(paths[i],file.content,{mode:0o600,flag:'wx'});
   let view:z.infer<typeof kubeconfigView>;
   try{const {stdout}=await exec(binary,['config','view','--kubeconfig',paths[i],'--raw','-o','json'],{timeout:20000,maxBuffer:2_000_000,encoding:'utf8',shell:false,env:{...toolboxEnvironment(),KUBECONFIG:''}});view=kubeconfigView.parse(JSON.parse(stdout));}
   catch(e){throw new AppError(400,`${file.name} is not a valid kubeconfig: ${kubectlError(e,paths,names)}`);}
   for(const [kind,label] of [['clusters','Cluster'],['users','User'],['contexts','Context']] as const){
    for(const entry of (view[kind]??[]) as Entry[]){
     const key=label+'\u0000'+entry.name,value=JSON.stringify(entry),prior=seen.get(key);
     if(!prior)seen.set(key,{file:file.name,entry:value});
     else if(prior.entry!==value)conflicts.push(`${label} "${entry.name}" is defined differently in ${prior.file} and ${file.name}.`);
    }
   }
  }
  if(conflicts.length)throw new AppError(400,conflicts.slice(0,3).join(' ')+(conflicts.length>3?` ${conflicts.length-3} more conflicts.`:'')+' Rename the entries in one file, then load the files again.');
  let merged:string;
  try{merged=(await exec(binary,['config','view','--flatten'],{timeout:20000,maxBuffer:2_000_000,encoding:'utf8',shell:false,env:{...toolboxEnvironment(),KUBECONFIG:paths.join(':')}})).stdout;}
  catch(e){throw new AppError(400,`The kubeconfig files could not be merged: ${kubectlError(e,paths,names)}. Embed certificates and keys with the *-data fields instead of file paths.`);}
  const contexts=[...seen.keys()].filter(k=>k.startsWith('Context\u0000')).map(k=>k.slice('Context\u0000'.length));
  return {kubeconfig:merged,contexts};
 }finally{await rm(dir,{recursive:true,force:true});}
}

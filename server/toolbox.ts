import {execFile,spawn,type ChildProcess} from 'node:child_process';
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
/** Namespaced resources of the Toolbox v0.4 catalog (docs/catalog.md). ConfigMaps are separate because a setting enables them. */
export const namespacedResources=['pods','services','endpoints','events','persistentvolumeclaims','deployments','statefulsets','daemonsets','replicasets','jobs','cronjobs','endpointslices','ingresses','networkpolicies','horizontalpodautoscalers','poddisruptionbudgets','certificates','certificaterequests','issuers','orders','challenges','clusters.postgresql.cnpg.io','backups.postgresql.cnpg.io','scheduledbackups.postgresql.cnpg.io','poolers.postgresql.cnpg.io','databases.postgresql.cnpg.io','rabbitmqclusters','opensearchclusters','prometheuses','alertmanagers','servicemonitors','podmonitors','prometheusrules','probes','kustomizations','helmreleases','gitrepositories','helmrepositories','sealedsecrets','gateways','httproutes','grpcroutes','ciliumendpoints','ciliumnetworkpolicies','pods.metrics.k8s.io'] as const;
/** Cluster-scoped resources of the Toolbox v0.4 catalog, readable when cluster-wide access is enabled. */
export const clusterResources=['nodes','namespaces','persistentvolumes','storageclasses','clusterissuers','gatewayclasses','ciliumnodes','ciliumclusterwidenetworkpolicies','nodes.metrics.k8s.io'] as const;
/** Returns the resources the agent may read with the saved Toolbox settings. */
export function readableResources(config:Config):string[]{
 const t=config.toolbox;
 return [...namespacedResources,...(t.allowConfigMaps?['configmaps']:[]),...(t.allowClusterScoped?clusterResources:[])];
}
/**
 * Returns the contexts the agent may use: the contexts of a generated configuration, or, for a configuration pasted or
 * set by path before generation existed, the context names listed in Settings.
 */
export function toolboxContexts(config:Config,files:ToolboxFiles|null){
 if(files?.v===2)return files.contexts.map(c=>c.name);
 return config.connections.Toolbox.scope.split(',').map(s=>s.trim()).filter(Boolean);
}
const namespaceName=z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(63);
/** Returns Toolbox arguments for one read. Toolbox's configuration decides which namespaces are allowed. */
export function toolboxArgs(config:Config,input:unknown,configPath:string,allowedContexts:string[]){
 const {context,namespace,resource}=z.object({context:z.string().min(1).max(253),resource:z.string().min(1).max(100),namespace:namespaceName.optional()}).strict().parse(input);
 if(!config.connections.Toolbox.enabled||!configPath||!isAbsolute(configPath)||!allowedContexts.includes(context))throw new AppError(403,'Toolbox context is not enabled in Settings.');
 if(!readableResources(config).includes(resource))throw new AppError(403,`Reading ${resource} is not enabled in Settings → Connections → Toolbox.`);
 const cluster=(clusterResources as readonly string[]).includes(resource);
 if(!cluster&&!namespace)throw new AppError(400,`Name a namespace to read ${resource}.`);
 return ['--config',configPath,'kubectl','get',resource,'--context',context,...(cluster?[]:['--namespace',namespace!]),'-o','json'];
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
 const allowed=toolboxContexts(config,files);
 toolboxArgs(config,input,files?'/pasted':config.connections.Toolbox.path,allowed);
 let run:Awaited<ReturnType<typeof toolboxRunConfig>>|undefined;
 try{
  run=await toolboxRunConfig(config,files);
  const {stdout}=await exec(binary,toolboxArgs(config,input,run.configPath,allowed),{signal,timeout:20000,maxBuffer:512000,encoding:'utf8',shell:false,env:run.env});return JSON.parse(stdout);
 }catch{throw new AppError(502,'Toolbox read failed. Check its binary, configuration, context access and response size where Support runs.');}
 finally{await run?.cleanup();}
}
/**
 * Reads the Kubernetes API version from each allowed context, at most 3, with `toolbox kubectl get --raw /version`.
 * Toolbox reports cluster errors in an `error` field of its JSON output. Returns the reached contexts and their
 * Kubernetes versions, or the first failure.
 */
export async function probeToolboxContexts(config:Config,files:ToolboxFiles|null,signal:AbortSignal,timeoutMs=10000){
 const binary=toolboxBinary(),allowed=toolboxContexts(config,files).slice(0,3);
 if(!allowed.length)return {ok:false,detail:'Generate the Toolbox configuration and select at least one context.'};
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
  try{merged=(await exec(binary,['config','view','--flatten'],{timeout:60000,maxBuffer:16_000_000,encoding:'utf8',shell:false,env:{...toolboxEnvironment(),KUBECONFIG:paths.join(':')}})).stdout;}
  catch(e){throw new AppError(400,`The kubeconfig files could not be merged: ${kubectlError(e,paths,names)}. Embed certificates and keys with the *-data fields instead of file paths.`);}
  const contexts=[...seen.keys()].filter(k=>k.startsWith('Context\u0000')).map(k=>k.slice('Context\u0000'.length));
  return {kubeconfig:merged,contexts};
 }finally{await rm(dir,{recursive:true,force:true});}
}

const tunnels=new Set<ChildProcess>();
/** Port-forward request from the agent, as accepted by `toolbox kubectl port-forward`. */
export const portForwardInput=z.object({
 context:z.string().min(1).max(253),namespace:namespaceName,
 target:z.string().max(253).regex(/^((pod|service|deployment)\/)?[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/,'Use a pod name, pod/NAME, service/NAME or deployment/NAME.'),
 ports:z.array(z.string().regex(/^(\d{1,5})?:\d{1,5}$|^\d{1,5}$/,'Use REMOTE, :REMOTE or LOCAL:REMOTE.')).min(1).max(8),
 durationSeconds:z.number().int().min(1).max(3600),
}).strict();
/**
 * Starts a Toolbox tunnel and returns Toolbox's first status line (ID, local address and ports, expiry).
 * The tunnel runs in the background until its duration, capped by the port-forward lifetime setting, ends.
 * Toolbox listens on 127.0.0.1 inside the Support container only.
 */
export async function startPortForward(config:Config,input:unknown,files:ToolboxFiles|null){
 const binary=toolboxBinary(),p=portForwardInput.parse(input);
 if(!config.connections.Toolbox.enabled||!config.toolbox.allowPortForward)throw new AppError(403,'Port forwarding is not enabled in Settings → Connections → Toolbox.');
 if(!toolboxContexts(config,files).includes(p.context))throw new AppError(403,'Toolbox context is not enabled in Settings.');
 const duration=Math.min(p.durationSeconds,config.toolbox.portForwardMaxSeconds),run=await toolboxRunConfig(config,files);
 const child=spawn(binary,['--config',run.configPath,'kubectl','port-forward',p.target,...p.ports,'-n',p.namespace,'--context',p.context,'--duration',`${duration}s`],{env:run.env,stdio:['ignore','pipe','pipe'],shell:false});
 tunnels.add(child);
 const stop=setTimeout(()=>child.kill('SIGTERM'),(duration+15)*1000);stop.unref();
 child.once('exit',()=>{tunnels.delete(child);clearTimeout(stop);void run.cleanup();});
 return await new Promise<unknown>((resolve,reject)=>{
  let out='';
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new AppError(504,'The tunnel did not start within 20 seconds.'));},20000);
  child.stdout!.on('data',(chunk:Buffer)=>{out+=chunk.toString('utf8');const end=out.indexOf('\n');if(end<0)return;clearTimeout(timer);
   try{resolve(JSON.parse(out.slice(0,end)));}catch{child.kill('SIGTERM');reject(new AppError(502,`Toolbox refused the tunnel: ${out.slice(0,end).slice(0,200)}`));}});
  child.once('exit',()=>{clearTimeout(timer);reject(new AppError(502,`The tunnel stopped before it started: ${out.trim().split('\n')[0]?.slice(0,200)||'no output'}`));});
 });
}
/** Stops every running tunnel. */
export function stopTunnels(){for(const t of tunnels)t.kill('SIGTERM');}

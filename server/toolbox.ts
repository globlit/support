import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,join} from 'node:path';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer,connect,type Server} from 'node:net';
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
/**
 * Namespaced resources of the Toolbox catalog (internal/integrations/kubectl/policy.go), by the exact name Toolbox
 * accepts. Core resources use their plural, which Toolbox maps to the core API. ConfigMaps are separate because a
 * setting enables them.
 */
export const namespacedResources=['pods','services','endpoints','events','persistentvolumeclaims','deployments.apps','statefulsets.apps','daemonsets.apps','replicasets.apps','jobs.batch','cronjobs.batch','endpointslices.discovery.k8s.io','ingresses.networking.k8s.io','networkpolicies.networking.k8s.io','horizontalpodautoscalers.autoscaling','poddisruptionbudgets.policy','certificates.cert-manager.io','certificaterequests.cert-manager.io','issuers.cert-manager.io','orders.acme.cert-manager.io','challenges.acme.cert-manager.io','clusters.postgresql.cnpg.io','backups.postgresql.cnpg.io','scheduledbackups.postgresql.cnpg.io','poolers.postgresql.cnpg.io','databases.postgresql.cnpg.io','databaseroles.postgresql.cnpg.io','imagecatalogs.postgresql.cnpg.io','publications.postgresql.cnpg.io','subscriptions.postgresql.cnpg.io','failoverquorums.postgresql.cnpg.io','rabbitmqclusters.rabbitmq.com','opensearchclusters.opensearch.opster.io','prometheuses.monitoring.coreos.com','alertmanagers.monitoring.coreos.com','servicemonitors.monitoring.coreos.com','podmonitors.monitoring.coreos.com','prometheusrules.monitoring.coreos.com','probes.monitoring.coreos.com','thanosrulers.monitoring.coreos.com','alertmanagerconfigs.monitoring.coreos.com','scrapeconfigs.monitoring.coreos.com','prometheusagents.monitoring.coreos.com','pods.metrics.k8s.io','fluentbits.fluentbit.fluent.io','fluentbitconfigs.fluentbit.fluent.io','collectors.fluentbit.fluent.io','filters.fluentbit.fluent.io','outputs.fluentbit.fluent.io','parsers.fluentbit.fluent.io','multilineparsers.fluentbit.fluent.io','fluentds.fluentd.fluent.io','fluentdconfigs.fluentd.fluent.io','filters.fluentd.fluent.io','inputs.fluentd.fluent.io','outputs.fluentd.fluent.io','kustomizations.kustomize.toolkit.fluxcd.io','helmreleases.helm.toolkit.fluxcd.io','gitrepositories.source.toolkit.fluxcd.io','helmrepositories.source.toolkit.fluxcd.io','sealedsecrets.bitnami.com','gateways.gateway.networking.k8s.io','httproutes.gateway.networking.k8s.io','grpcroutes.gateway.networking.k8s.io','ciliumendpoints.cilium.io','ciliumnetworkpolicies.cilium.io'] as const;
/** Cluster-scoped resources of the Toolbox catalog, readable when cluster-wide access is enabled. */
export const clusterResources=['nodes','namespaces','persistentvolumes','storageclasses.storage.k8s.io','clusterissuers.cert-manager.io','clusterimagecatalogs.postgresql.cnpg.io','nodes.metrics.k8s.io','clusterfilters.fluentbit.fluent.io','clusterfluentbitconfigs.fluentbit.fluent.io','clusterinputs.fluentbit.fluent.io','clustermultilineparsers.fluentbit.fluent.io','clusteroutputs.fluentbit.fluent.io','clusterparsers.fluentbit.fluent.io','clusterfilters.fluentd.fluent.io','clusterfluentdconfigs.fluentd.fluent.io','clusterinputs.fluentd.fluent.io','clusteroutputs.fluentd.fluent.io','gatewayclasses.gateway.networking.k8s.io','ciliumnodes.cilium.io','ciliumclusterwidenetworkpolicies.cilium.io'] as const;
/**
 * Returns the catalog name for a resource given by its full name or by its plural alone, such as "networkpolicies"
 * for "networkpolicies.networking.k8s.io". A plural shared by several API groups is returned unchanged.
 */
export function catalogName(resource:string,catalog:readonly string[]){
 if(catalog.includes(resource))return resource;
 const matches=catalog.filter(r=>r.split('.')[0]===resource);
 return matches.length===1?matches[0]:resource;
}
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
 const {context,namespace,resource:requested,name,selector}=z.object({context:z.string().min(1).max(253),resource:z.string().min(1).max(100),namespace:namespaceName.optional(),name:z.string().max(253).regex(/^[a-z0-9]([-a-z0-9.:]*[a-z0-9])?$/,'Use a resource name.').optional(),selector:z.string().max(500).regex(/^[A-Za-z0-9_./!=, ()-]+$/,'Use a label selector such as app=web,tier!=cache.').optional()}).strict().parse(input);
 if(!config.connections.Toolbox.enabled||!configPath||!isAbsolute(configPath)||!allowedContexts.includes(context))throw new AppError(403,'Toolbox context is not enabled in Settings.');
 const resource=catalogName(requested,readableResources(config));
 if(!readableResources(config).includes(resource))throw new AppError(403,`Reading ${resource} is not enabled in Settings → Connections → Toolbox.`);
 const cluster=(clusterResources as readonly string[]).includes(resource);
 if(!cluster&&!namespace)throw new AppError(400,`Name a namespace to read ${resource}.`);
 return ['--config',configPath,'kubectl','get',resource,...(name?[name]:[]),'--context',context,...(cluster?[]:['--namespace',namespace!]),...(selector?['-l',selector]:[]),'-o','json'];
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
/**
 * Returns the error to report for a failed Toolbox run. Toolbox prints a JSON result with an `error` field and exits
 * with code 1 when it refuses or kubectl fails, and prints a single line on stderr when it rejects its arguments or
 * configuration. That reason is kept, so the agent and the engineer see why the read failed.
 */
export function toolboxFailure(e:unknown,action:string,signal?:AbortSignal){
 if(signal?.aborted)return new AppError(409,'Toolbox read stopped.');
 const err=e as {stdout?:unknown;stderr?:unknown;code?:unknown;killed?:boolean};
 if(err?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return new AppError(502,`${action}: the response is larger than Support accepts. Narrow the request with a name, a selector or a smaller tail.`);
 if(err?.code==='ENOENT'||err?.code==='EACCES')return new AppError(502,`${action}: the Toolbox binary cannot run where Support runs. Check SUPPORT_TOOLBOX_BINARY.`);
 if(err?.killed)return new AppError(504,`${action}: Toolbox did not answer in time.`);
 let result:{error?:unknown;diagnostics?:unknown}|undefined;
 try{const v=JSON.parse(String(err?.stdout??''));if(v&&typeof v==='object')result=v;}catch{result=undefined;}
 const clean=(v:unknown)=>String(v).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').trim().slice(0,600);
 if(typeof result?.error==='string'&&result.error.trim())return new AppError(502,`${action}: ${clean(result.error)}${typeof result.diagnostics==='string'&&result.diagnostics.trim()?` (${clean(result.diagnostics).slice(0,300)})`:''}`);
 const line=String(err?.stderr??'').split('\n').map(l=>l.trim()).find(Boolean);
 if(line)return new AppError(502,`${action}: Toolbox refused the request: ${clean(line)}`);
 return new AppError(502,`${action}: Toolbox failed without a reason. Check its binary, configuration and context access where Support runs.`);
}
/** Runs one Toolbox read. Pasted files go to a private temporary folder, deleted after the run. */
/** Input of `toolbox_logs`: one pod's container logs. */
export const logsInput=z.object({
 context:z.string().min(1).max(253),namespace:namespaceName,
 pod:z.string().max(253).regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/),
 container:z.string().max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).optional(),
 previous:z.boolean().optional(),
 tail:z.number().int().min(1).max(2000).optional(),
 since:z.string().regex(/^\d{1,5}[smh]$/,'Use a duration such as 30s, 15m or 2h.').optional(),
}).strict();
/** Returns the Toolbox arguments that read one pod's logs. Fails for a context that the configuration does not allow. */
export function toolboxLogsArgs(config:Config,input:unknown,configPath:string,allowedContexts:string[]){
 const p=logsInput.parse(input);
 if(!config.connections.Toolbox.enabled||!configPath||!isAbsolute(configPath)||!allowedContexts.includes(p.context))throw new AppError(403,'Toolbox context is not enabled in Settings.');
 return ['--config',configPath,'kubectl','logs',p.pod,'-n',p.namespace,'--context',p.context,...(p.container?['-c',p.container]:[]),...(p.previous?['--previous']:[]),'--tail',String(p.tail??200),...(p.since?['--since',p.since]:[])];
}
/** Reads one pod's logs through Toolbox, which sanitizes them. Returns Toolbox's JSON, or the text when it is not JSON. */
export async function readToolboxLogs(config:Config,input:unknown,signal:AbortSignal,files:ToolboxFiles|null=null){
 const binary=toolboxBinary(),allowed=toolboxContexts(config,files);
 toolboxLogsArgs(config,input,files?'/pasted':config.connections.Toolbox.path,allowed);
 let run:Awaited<ReturnType<typeof toolboxRunConfig>>|undefined;
 try{
  run=await toolboxRunConfig(config,files);
  const {stdout}=await exec(binary,toolboxLogsArgs(config,input,run.configPath,allowed),{signal,timeout:30000,maxBuffer:2_000_000,encoding:'utf8',shell:false,env:run.env});
  try{return JSON.parse(stdout);}catch{return {logs:stdout.slice(-20000)};}
 }catch(e){throw toolboxFailure(e,'Toolbox could not read the logs',signal);}
 finally{await run?.cleanup();}
}
export async function readToolbox(config:Config,input:unknown,signal:AbortSignal,files:ToolboxFiles|null=null){
 const binary=toolboxBinary();
 const allowed=toolboxContexts(config,files);
 toolboxArgs(config,input,files?'/pasted':config.connections.Toolbox.path,allowed);
 let run:Awaited<ReturnType<typeof toolboxRunConfig>>|undefined;
 try{
  run=await toolboxRunConfig(config,files);
  const {stdout}=await exec(binary,toolboxArgs(config,input,run.configPath,allowed),{signal,timeout:20000,maxBuffer:512000,encoding:'utf8',shell:false,env:run.env});return JSON.parse(stdout);
 }catch(e){throw e instanceof SyntaxError?new AppError(502,'Toolbox read failed: the output is not JSON.'):toolboxFailure(e,'Toolbox read failed',signal);}
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
 target:z.string().max(253).regex(/^((pod|service|svc|deployment|statefulset)\/)?[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/,'Use a pod name, pod/NAME, service/NAME, deployment/NAME or statefulset/NAME.'),
 ports:z.array(z.string().regex(/^(\d{1,5})?:\d{1,5}$|^\d{1,5}$/,'Use REMOTE, :REMOTE or LOCAL:REMOTE.')).min(1).max(8),
 durationSeconds:z.number().int().min(1).max(3600),
}).strict();
/**
 * Starts a Toolbox tunnel and resolves with Toolbox's first status line (ID, local address and ports, expiry) and the
 * tunnel process. The tunnel runs until its duration, capped by the port-forward lifetime setting, ends.
 * Toolbox listens on 127.0.0.1 inside the Support container only.
 */
export async function openTunnel(config:Config,input:unknown,files:ToolboxFiles|null){
 const binary=toolboxBinary(),p=portForwardInput.parse(input);
 if(!config.connections.Toolbox.enabled||!config.toolbox.allowPortForward)throw new AppError(403,'Port forwarding is not enabled in Settings → Connections → Toolbox.');
 if(!toolboxContexts(config,files).includes(p.context))throw new AppError(403,'Toolbox context is not enabled in Settings.');
 const duration=Math.min(p.durationSeconds,config.toolbox.portForwardMaxSeconds),run=await toolboxRunConfig(config,files);
 const child=spawn(binary,['--config',run.configPath,'kubectl','port-forward',p.target,...p.ports,'-n',p.namespace,'--context',p.context,'--duration',`${duration}s`],{env:run.env,stdio:['ignore','pipe','pipe'],shell:false});
 tunnels.add(child);
 const stop=setTimeout(()=>child.kill('SIGTERM'),(duration+15)*1000);stop.unref();
 child.once('exit',()=>{tunnels.delete(child);clearTimeout(stop);void run.cleanup();});
 return await new Promise<{status:unknown;child:ChildProcess;ports:string[]}>((resolve,reject)=>{
  let out='';
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new AppError(504,'The tunnel did not start within 20 seconds.'));},20000);
  child.stdout!.on('data',(chunk:Buffer)=>{out+=chunk.toString('utf8');const end=out.indexOf('\n');if(end<0)return;clearTimeout(timer);
   let status:unknown;try{status=JSON.parse(out.slice(0,end));}catch{child.kill('SIGTERM');reject(new AppError(502,`Toolbox refused the tunnel: ${out.slice(0,end).slice(0,200)}`));return;}
   resolve({status,child,ports:p.ports});});
  child.once('exit',()=>{clearTimeout(timer);reject(new AppError(502,`The tunnel stopped before it started: ${out.trim().split('\n')[0]?.slice(0,200)||'no output'}`));});
 });
}
/**
 * Starts a Toolbox tunnel for the agent and returns Toolbox's status with the relay addresses that sandbox commands
 * can reach. Without SUPPORT_RELAY_BIND, no relay is started.
 */
export async function startPortForward(config:Config,input:unknown,files:ToolboxFiles|null){
 const {status,child,ports}=await openTunnel(config,input,files);
 return relayPorts(tunnelLocalPorts(ports,status),child).then(relays=>relays.length?{tunnel:status,reachableFromSandbox:relays.map(r=>`${r.address}:${r.port} → local ${r.local}`)}:{tunnel:status,reachableFromSandbox:[],note:'No relay: SUPPORT_RELAY_BIND is not set, so sandbox commands cannot reach this tunnel.'},()=>({tunnel:status,reachableFromSandbox:[],note:'The relay for sandbox commands could not start.'}));
}
/** Stops every running tunnel. */
export function stopTunnels(){for(const t of tunnels)t.kill('SIGTERM');}

/**
 * Returns the local ports of a tunnel: LOCAL for LOCAL:REMOTE, REMOTE for a bare REMOTE, and for :REMOTE the
 * port numbers found under keys containing "local" in Toolbox's status.
 */
export function tunnelLocalPorts(ports:string[],status:unknown){
 const found:number[]=[];
 const walk=(v:unknown,key='')=>{if(Array.isArray(v))v.forEach(x=>walk(x,key));else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))walk(x,k);else if(/local/i.test(key)){const n=typeof v==='number'?v:Number(String(v).match(/:(\d{1,5})$/)?.[1]??v);if(Number.isInteger(n)&&n>0&&n<65536)found.push(n);}};
 walk(status);
 const explicit=ports.filter(p=>!p.startsWith(':')).map(p=>Number(p.includes(':')?p.split(':')[0]:p));
 return [...new Set([...explicit,...(ports.some(p=>p.startsWith(':'))?found:[])])];
}
/**
 * Listens on SUPPORT_RELAY_BIND, one random port per tunnel port, and forwards each connection to 127.0.0.1:<local>.
 * The relays close when the tunnel process exits. Returns no relay when SUPPORT_RELAY_BIND is not set.
 */
export async function relayPorts(locals:number[],tunnel:ChildProcess,address=process.env.SUPPORT_RELAY_BIND?.trim()){
 if(!address||!locals.length)return [];
 const servers:Server[]=[];
 const relays=await Promise.all(locals.map(local=>new Promise<{address:string;port:number;local:number}>((resolve,reject)=>{
  const server=createServer(socket=>{const upstream=connect(local,'127.0.0.1');socket.pipe(upstream).pipe(socket);const close=()=>{socket.destroy();upstream.destroy();};socket.on('error',close);upstream.on('error',close);});
  servers.push(server);server.once('error',reject);
  server.listen(0,address,()=>resolve({address,port:(server.address() as {port:number}).port,local}));
 })));
 const close=()=>{for(const s of servers)s.close();};
 if(tunnel.exitCode!==null||tunnel.signalCode!==null)close();else tunnel.once('exit',close);
 return relays;
}

/** kubectl short names, mapped to the names Toolbox accepts. */
const kubectlAliases:Record<string,string>={po:'pods',pod:'pods',svc:'services',service:'services',deploy:'deployments',deployment:'deployments',sts:'statefulsets',statefulset:'statefulsets',ds:'daemonsets',daemonset:'daemonsets',rs:'replicasets',replicaset:'replicasets',job:'jobs',cj:'cronjobs',cronjob:'cronjobs',ing:'ingresses',ingress:'ingresses',netpol:'networkpolicies',networkpolicy:'networkpolicies',ep:'endpoints',ev:'events',event:'events',pvc:'persistentvolumeclaims',pv:'persistentvolumes',ns:'namespaces',namespace:'namespaces',no:'nodes',node:'nodes',cm:'configmaps',configmap:'configmaps',hpa:'horizontalpodautoscalers',pdb:'poddisruptionbudgets',sc:'storageclasses',hr:'helmreleases',helmrelease:'helmreleases',ks:'kustomizations',kustomization:'kustomizations',smon:'servicemonitors',servicemonitor:'servicemonitors',pmon:'podmonitors',podmonitor:'podmonitors',prometheusrule:'prometheusrules',cert:'certificates',certificate:'certificates',cnp:'ciliumnetworkpolicies',ciliumnetworkpolicy:'ciliumnetworkpolicies',ccnp:'ciliumclusterwidenetworkpolicies'};
type K8sObject={kind?:string;metadata?:{name?:string;namespace?:string;creationTimestamp?:string;managedFields?:unknown;annotations?:Record<string,string>};spec?:Record<string,unknown>;status?:Record<string,unknown>;[k:string]:unknown};
/** Removes managedFields and the last-applied annotation, which are large and rarely useful to read. */
function slim<T>(value:T):T{
 if(Array.isArray(value))return value.map(slim) as T;
 if(value&&typeof value==='object'){const out:Record<string,unknown>={};for(const [k,v] of Object.entries(value)){if(k==='managedFields')continue;if(k==='annotations'&&v&&typeof v==='object'){const a={...v as Record<string,unknown>};delete a['kubectl.kubernetes.io/last-applied-configuration'];out[k]=a;continue;}out[k]=slim(v);}return out as T;}
 return value;
}
const age=(ts?:string)=>{if(!ts)return '';const s=Math.max(0,(Date.now()-Date.parse(ts))/1000);return s<120?`${Math.round(s)}s`:s<7200?`${Math.round(s/60)}m`:s<172800?`${Math.round(s/3600)}h`:`${Math.round(s/86400)}d`;};
/** Formats objects as a kubectl-like table: common columns for pods, workloads, services and events, NAME and AGE otherwise. */
function table(items:K8sObject[],wide:boolean,allNamespaces:boolean){
 if(!items.length)return 'No resources found.';
 const kind=items[0].kind??'';
 const cols:[string,(o:K8sObject)=>string][]=[];
 if(allNamespaces)cols.push(['NAMESPACE',o=>o.metadata?.namespace??'']);
 cols.push(['NAME',o=>o.metadata?.name??'']);
 const st=(o:K8sObject)=>o.status as Record<string,any>|undefined,sp=(o:K8sObject)=>o.spec as Record<string,any>|undefined;
 if(kind==='Pod'){
  cols.push(['READY',o=>{const c=(st(o)?.containerStatuses??[]) as {ready?:boolean}[];return `${c.filter(x=>x.ready).length}/${c.length||((sp(o)?.containers??[]) as unknown[]).length}`;}],
   ['STATUS',o=>{const c=(st(o)?.containerStatuses??[]) as {state?:{waiting?:{reason?:string};terminated?:{reason?:string}}}[];return c.map(x=>x.state?.waiting?.reason??x.state?.terminated?.reason).find(Boolean)??st(o)?.phase??'';}],
   ['RESTARTS',o=>String(((st(o)?.containerStatuses??[]) as {restartCount?:number}[]).reduce((n,x)=>n+(x.restartCount??0),0))]);
  if(wide)cols.push(['IP',o=>st(o)?.podIP??''],['NODE',o=>sp(o)?.nodeName??'']);
 }else if(['Deployment','StatefulSet','ReplicaSet'].includes(kind))cols.push(['READY',o=>`${st(o)?.readyReplicas??0}/${sp(o)?.replicas??0}`],['UP-TO-DATE',o=>String(st(o)?.updatedReplicas??0)],['AVAILABLE',o=>String(st(o)?.availableReplicas??0)]);
 else if(kind==='DaemonSet')cols.push(['DESIRED',o=>String(st(o)?.desiredNumberScheduled??0)],['READY',o=>String(st(o)?.numberReady??0)]);
 else if(kind==='Service')cols.push(['TYPE',o=>sp(o)?.type??''],['CLUSTER-IP',o=>sp(o)?.clusterIP??''],['PORTS',o=>((sp(o)?.ports??[]) as {port?:number;protocol?:string}[]).map(p=>`${p.port}/${p.protocol??'TCP'}`).join(',')]);
 else if(kind==='Event')cols.splice(cols.findIndex(c=>c[0]==='NAME'),1,['TYPE',o=>String((o as any).type??'')],['REASON',o=>String((o as any).reason??'')],['OBJECT',o=>`${(o as any).involvedObject?.kind??''}/${(o as any).involvedObject?.name??''}`],['MESSAGE',o=>String((o as any).message??'').replace(/\s+/g,' ').slice(0,wide?400:120)]);
 else if(kind==='Node')cols.push(['STATUS',o=>((st(o)?.conditions??[]) as {type?:string;status?:string}[]).find(c=>c.type==='Ready')?.status==='True'?'Ready':'NotReady'],['VERSION',o=>st(o)?.nodeInfo?.kubeletVersion??'']);
 else if(['HelmRelease','Kustomization'].includes(kind))cols.push(['READY',o=>((st(o)?.conditions??[]) as {type?:string;status?:string;message?:string}[]).find(c=>c.type==='Ready')?.status??''],['STATUS',o=>(((st(o)?.conditions??[]) as {type?:string;message?:string}[]).find(c=>c.type==='Ready')?.message??'').slice(0,wide?300:80)]);
 cols.push(['AGE',o=>age(o.metadata?.creationTimestamp)]);
 const rows=[cols.map(c=>c[0]),...items.map(o=>cols.map(c=>{try{return c[1](o);}catch{return '';}}))];
 const widths=cols.map((_,i)=>Math.max(...rows.map(r=>r[i].length)));
 return rows.map(r=>r.map((v,i)=>i===r.length-1?v:v.padEnd(widths[i])).join('   ')).join('\n');
}
/** Minimal YAML for kubectl -o yaml and describe. */
function yaml(v:unknown,indent=''):string{
 if(v===null||v===undefined)return 'null';
 if(typeof v!=='object')return typeof v==='string'&&(/^[\s-?:,[\]{}#&*!|>'"%@`]|[:#]\s|^$|^(true|false|null|\d[\d.eE+-]*)$/.test(v)||v.includes('\n'))?JSON.stringify(v):String(v);
 if(Array.isArray(v))return v.length?v.map(x=>`\n${indent}- ${yaml(x,indent+'  ').replace(/^\n\s*/,'')}`).join(''):'[]';
 const e=Object.entries(v as Record<string,unknown>);
 return e.length?e.map(([k,x])=>`\n${indent}${k}: ${typeof x==='object'&&x!==null&&(Array.isArray(x)?x.length:Object.keys(x).length)?yaml(x,indent+'  '):yaml(x,indent+'  ')}`).join(''):'{}';
}
/**
 * Runs a kubectl-style read through Toolbox for the agent's kubectl command. Accepts get (table by default, or -o wide,
 * yaml, json, name), describe (object and its events), logs, top, api-resources (the Toolbox catalog) and config
 * get-contexts. Short names such as po, svc or netpol are accepted. Toolbox applies its policy: allowed contexts,
 * namespaces and resources, sanitized output. Returns kubectl-like stdout, stderr and exit code.
 */
export async function toolboxKubectl(config:Config,argv:unknown,signal:AbortSignal,files:ToolboxFiles|null){
 const args=z.array(z.string().max(2000)).max(40).parse(argv);
 const usage='Read-only kubectl through Toolbox: get (table; -o wide|yaml|json|name), describe, logs, top pods|nodes, api-resources, config get-contexts. Flags: --context, -n, -A, -l, -c, --tail, --since, --previous. Not available: writes, exec, port-forward (use the toolbox_port_forward tool), jsonpath (use -o json | jq).';
 const verb=args[0];
 if(!verb||verb==='-h'||verb==='--help'||verb==='help')return {stdout:usage,stderr:'',code:0};
 if(!['get','describe','logs','top','api-resources','config'].includes(verb))return {stdout:'',stderr:`kubectl ${verb} is not available in the agent sandbox. ${usage}`,code:1};
 if(!config.connections.Toolbox.enabled)return {stdout:'',stderr:'Toolbox is disabled in Settings → Connections → Toolbox.',code:1};
 // Options with a value, normalised to their long form.
 const opts:Record<string,string>={};const flags=new Set<string>();const positional:string[]=[];
 const valued:Record<string,string>={'-n':'namespace','--namespace':'namespace','-l':'selector','--selector':'selector','-o':'output','--output':'output','--context':'context','-c':'container','--container':'container','--tail':'tail','--since':'since','--sort-by':'sort-by','--field-selector':'field-selector'};
 for(let i=1;i<args.length;i++){const a=args[i];const [k,v]=a.includes('=')&&a.startsWith('-')?[a.slice(0,a.indexOf('=')),a.slice(a.indexOf('=')+1)]:[a,undefined];
  if(k in valued){opts[valued[k]]=v??args[++i]??'';continue;}
  if(a==='-A'||a==='--all-namespaces'){flags.add('all');continue;}
  if(a==='-p'||a==='--previous'){flags.add('previous');continue;}
  if(a==='--no-headers'||a==='--show-labels'||a==='-w'||a==='--watch'){flags.add(a);continue;}
  if(a.startsWith('-o')&&a.length>2){opts.output=a.slice(2);continue;}
  if(a.startsWith('-'))return {stdout:'',stderr:`kubectl: option ${a} is not supported here. ${usage}`,code:1};
  positional.push(a);}
 if(flags.has('-w')||flags.has('--watch'))return {stdout:'',stderr:'kubectl: --watch is not available. Run the command again later instead.',code:1};
 const resolve=(r:string)=>{const [base,name]=r.split('/');const lower=base.toLowerCase();const mapped=kubectlAliases[lower]??lower;return {resource:catalogName(mapped,readableResources(config)),name};};
 const common=[...(opts.context?['--context',opts.context]:[]),...(opts.namespace?['--namespace',opts.namespace]:[])];
 const binary=toolboxBinary();let run:Awaited<ReturnType<typeof toolboxRunConfig>>|undefined;
 const exec2=(cli:string[])=>new Promise<{stdout:string;stderr:string;code:number}>((resolveP,reject)=>{execFile(binary,['--config',run!.configPath,'kubectl',...cli],{signal,timeout:60000,maxBuffer:16_000_000,encoding:'utf8',shell:false,env:run!.env},(error,stdout,stderr)=>{const code=(error as {code?:unknown}|null)?.code;if(error&&typeof code!=='number')return reject(error);resolveP({stdout:String(stdout),stderr:String(stderr),code:typeof code==='number'?code:0});});});
 // Runs Toolbox and returns its data, or the error it reported.
 const read=async(cli:string[]):Promise<{data?:unknown;text?:string;error?:string}>=>{const r=await exec2(cli);let v:{error?:string;data?:unknown;text?:string;diagnostics?:string}|undefined;try{v=JSON.parse(r.stdout);}catch{return r.code?{error:(r.stderr||r.stdout).trim().split('\n')[0]||'Toolbox failed.'}:{text:r.stdout};}if(v?.error)return {error:[v.error,v.diagnostics].filter(Boolean).join(' · ')};return {data:v?.data,text:v?.text};};
 const items=(d:unknown):K8sObject[]=>{const v=d as {items?:K8sObject[];kind?:string};return Array.isArray(v?.items)?v.items.map(i=>({kind:(v.kind??'').replace(/List$/,'')||i.kind,...i})):v&&typeof v==='object'?[v as K8sObject]:[];};
 try{
  run=await toolboxRunConfig(config,files);
  if(verb==='config'){if(positional[0]!=='get-contexts'&&positional[0]!=='current-context')return {stdout:'',stderr:'kubectl config: only get-contexts is available.',code:1};const r=await read(['contexts']);return r.error?{stdout:'',stderr:r.error,code:1}:{stdout:JSON.stringify(r.data??r.text,null,1),stderr:'',code:0};}
  if(verb==='api-resources'){const r=await read(['resources',...(opts.context?['--context',opts.context]:[])]);return r.error?{stdout:'',stderr:r.error,code:1}:{stdout:((r.data??[]) as {name?:string;cluster_scoped?:boolean}[]).map(x=>`${x.name}${x.cluster_scoped?'  (cluster-scoped)':''}`).join('\n')||JSON.stringify(r.data),stderr:'',code:0};}
  if(verb==='logs'){
   const target=positional[0]?.replace(/^(pod|po|pods)\//,'');if(!target)return {stdout:'',stderr:'kubectl logs: give a pod name.',code:1};
   const r=await read(['logs',target,...common,...(opts.container?['-c',opts.container]:[]),...(flags.has('previous')?['--previous']:[]),'--tail',opts.tail&&Number(opts.tail)>0?String(Math.min(2000,Number(opts.tail))):'200',...(opts.since?['--since',opts.since]:[])]);
   return r.error?{stdout:'',stderr:r.error,code:1}:{stdout:r.text??JSON.stringify(r.data),stderr:'',code:0};
  }
  if(verb==='top'){const kind=(positional[0]??'').toLowerCase();const resource=kind.startsWith('no')?'nodes.metrics.k8s.io':'pods.metrics.k8s.io';const r=await read(['get',resource,...common,...(flags.has('all')?['--all-namespaces']:[]),'-o','json']);if(r.error)return {stdout:'',stderr:r.error,code:1};
   const rows=items(r.data).map(o=>{const c=((o as any).containers??[{usage:(o as any).usage}]) as {usage?:{cpu?:string;memory?:string}}[];return [o.metadata?.namespace??'',o.metadata?.name??'',c.map(x=>x.usage?.cpu??'').join('+'),c.map(x=>x.usage?.memory??'').join('+')];});
   return {stdout:['NAMESPACE   NAME   CPU   MEMORY',...rows.map(r=>r.join('   '))].join('\n'),stderr:'',code:0};}
  if(verb==='get'||verb==='describe'){
   if(!positional.length)return {stdout:'',stderr:`kubectl ${verb}: give a resource, for example pods or netpol/NAME.`,code:1};
   const {resource,name:inline}=resolve(positional[0]);const name=inline??positional[1];
   if(!readableResources(config).includes(resource))return {stdout:'',stderr:`kubectl: ${positional[0]} is not in the Toolbox catalog. Run kubectl api-resources for the list.`,code:1};
   const r=await read(['get',resource,...(name?[name]:[]),...common,...(flags.has('all')&&!name?['--all-namespaces']:[]),...(opts.selector?['-l',opts.selector]:[]),'-o','json']);
   if(r.error)return {stdout:'',stderr:r.error,code:1};
   const list=slim(items(r.data));
   if(verb==='describe'){
    const parts:string[]=[];
    for(const o of list.slice(0,10)){
     parts.push(`# ${o.kind??resource}/${o.metadata?.name}${o.metadata?.namespace?` (namespace ${o.metadata.namespace})`:''}`+yaml(o));
     const ev=await read(['get','events',...(opts.context?['--context',opts.context]:[]),...(o.metadata?.namespace?['--namespace',o.metadata.namespace]:[]),'-o','json']);
     const mine=ev.error?[]:items(ev.data).filter(e=>(e as any).involvedObject?.name===o.metadata?.name);
     parts.push(mine.length?'Events:\n'+table(mine.map(e=>({...e,kind:'Event'})),false,false):'Events: <none>');
    }
    return {stdout:parts.join('\n\n'),stderr:list.length>10?`Showing 10 of ${list.length}. Name one object to describe it.`:'',code:0};
   }
   const out=(opts.output??'').toLowerCase();
   if(out==='json')return {stdout:JSON.stringify(list.length===1&&name?list[0]:{kind:'List',items:list},null,1),stderr:'',code:0};
   if(out==='yaml')return {stdout:yaml(list.length===1&&name?list[0]:{kind:'List',items:list}).replace(/^\n/,''),stderr:'',code:0};
   if(out==='name')return {stdout:list.map(o=>`${(o.kind??resource).toLowerCase()}/${o.metadata?.name}`).join('\n'),stderr:'',code:0};
   if(out&&out!=='wide')return {stdout:'',stderr:`kubectl: -o ${out} is not supported here. Use -o json and jq.`,code:1};
   const text=table(list,out==='wide',flags.has('all'));
   return {stdout:flags.has('--no-headers')?text.split('\n').slice(1).join('\n'):text,stderr:'',code:0};
  }
  return {stdout:'',stderr:`kubectl ${verb} is not available in the agent sandbox. ${usage}`,code:1};
 }catch(e){throw toolboxFailure(e,'kubectl failed',signal);}
 finally{await run?.cleanup();}
}

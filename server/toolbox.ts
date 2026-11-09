import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,join} from 'node:path';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
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
/** Runs one Toolbox read. Pasted files go to a private temporary folder, deleted after the run. */
export async function readToolbox(config:Config,input:unknown,signal:AbortSignal,files:ToolboxFiles|null=null){
 if(process.platform!=='linux')throw new AppError(403,'Toolbox execution requires Support to run on Linux.');
 const binary=process.env.SUPPORT_TOOLBOX_BINARY??'/usr/local/bin/toolbox';
 if(!isAbsolute(binary))throw new AppError(400,'SUPPORT_TOOLBOX_BINARY must be an absolute path.');
 toolboxArgs(config,input,files?'/pasted':undefined);
 const dir=files?await mkdtemp(join(tmpdir(),'support-toolbox-')):null;
 try{
  const env=toolboxEnvironment();let configPath=config.connections.Toolbox.path;
  if(files&&dir){
   const kubeconfig=join(dir,'kubeconfig');configPath=join(dir,'toolbox.json');
   await writeFile(kubeconfig,files.kubeconfig,{mode:0o600,flag:'wx'});
   await writeFile(configPath,resolveToolboxConfig(files.toolboxConfig,kubeconfig),{mode:0o600,flag:'wx'});
   env.KUBECONFIG=kubeconfig;
  }
  const {stdout}=await exec(binary,toolboxArgs(config,input,configPath),{signal,timeout:20000,maxBuffer:512000,encoding:'utf8',shell:false,env});return JSON.parse(stdout);
 }catch{throw new AppError(502,'Toolbox read failed. Check its binary, configuration, context access and response size where Support runs.');}
 finally{if(dir)await rm(dir,{recursive:true,force:true});}
}

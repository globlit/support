import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import type {Config} from '../src/model.js';
import {AppError} from './store.js';
const exec=promisify(execFile);
export function toolboxEnvironment(source:NodeJS.ProcessEnv=process.env){
 const env:NodeJS.ProcessEnv={};
 for(const key of ['HOME','PATH','LANG','LC_ALL','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_USE_ENV_PROXY'])if(source[key])env[key]=source[key];
 return env;
}
export const resources=['pods','deployments','services','replicasets','daemonsets','statefulsets','jobs','cronjobs','ingresses','persistentvolumeclaims','networkpolicies','events'] as const;
export const contexts=(config:Config)=>config.connections.Toolbox.scope.split(',').map(s=>s.trim()).filter(Boolean);
export function toolboxArgs(config:Config,input:unknown){
 const {context,namespace,resource}=z.object({context:z.string().min(1).max(200),namespace:z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(63),resource:z.enum(resources)}).strict().parse(input);
 const c=config.connections.Toolbox;
 if(!c.enabled||!c.path||!isAbsolute(c.path)||!contexts(config).includes(context))throw new AppError(403,'Toolbox context is not enabled in Settings.');
 for(const pattern of config.excludedNamespaces.split(',').map(s=>s.trim()).filter(Boolean)){
  const regex='^'+pattern.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$';
  if(new RegExp(regex).test(namespace))throw new AppError(403,'Namespace excluded by Settings.');
 }
 return ['--config',c.path,'kubectl','get',resource,'--context',context,'--namespace',namespace,'-o','json'];
}
export async function readToolbox(config:Config,input:unknown,signal:AbortSignal){
 if(process.platform!=='linux')throw new AppError(403,'Toolbox execution is restricted to the Linux VM.');
 const binary=process.env.SUPPORT_TOOLBOX_BINARY??'/usr/local/bin/toolbox';
 if(!isAbsolute(binary))throw new AppError(400,'SUPPORT_TOOLBOX_BINARY must be an absolute path.');
 const args=toolboxArgs(config,input);
 try{const {stdout}=await exec(binary,args,{signal,timeout:20000,maxBuffer:512000,encoding:'utf8',shell:false,env:toolboxEnvironment()});return JSON.parse(stdout);}catch{throw new AppError(502,'Toolbox read failed. Check its binary, configuration, context access and response size inside the VM.');}
}

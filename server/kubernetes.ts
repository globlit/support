import {request as httpsRequest} from 'node:https';
import {request as httpRequest,type ClientRequest,type IncomingHttpHeaders,type IncomingMessage,type ServerResponse} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,join} from 'node:path';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {z} from 'zod';
import {AppError,type Store} from './store.js';
import {kubernetesContextName,kubernetesCredential,type Config} from '../src/model.js';
import {kubernetesSecretSchema,type KubernetesSecret} from './service-auth.js';
export {kubernetesSecretSchema};
const exec=promisify(execFile);

export type KubernetesTarget={name:string;server:URL;secret:KubernetesSecret};

/** Contexts the agent can read: the Kubernetes connection and the context are enabled, and the context has a saved token. */
export function enabledContexts(store:Store,config:Config){
 if(!config.connections.Kubernetes.enabled)return [];
 const saved=new Set(store.vaultStatus().credentials);
 return config.kubernetesContexts.filter(c=>c.enabled&&saved.has(kubernetesCredential(c.name)));
}

/** Returns the API server and credential of an enabled context. Throws 404 for any other context. */
export function kubernetesTarget(store:Store,config:Config,name:string):KubernetesTarget{
 const contexts=enabledContexts(store,config),context=contexts.find(c=>c.name===name);
 if(!context)throw new AppError(404,`Kubernetes context ${name} is not enabled in Support. Enabled contexts: ${contexts.map(c=>c.name).join(', ')||'none'}.`);
 return {name,server:new URL(context.server),secret:kubernetesSecretSchema.parse(JSON.parse(store.readCredential(kubernetesCredential(name))))};
}

const refusedSubresource=/^\/api\/v1\/(?:namespaces\/[^/]+\/)?(?:pods|services|nodes)\/[^/]+\/(?:exec|attach|portforward|proxy)(?:\/|$)|^\/api\/v1\/proxy(?:\/|$)/;
/**
 * Returns why the gateway refuses an agent request to the Kubernetes API, or undefined when the request is a read.
 * Refused: methods other than GET and HEAD, connection upgrades, dot segments, and the exec, attach, portforward and
 * proxy subresources. Cluster RBAC still decides which reads succeed.
 */
export function kubernetesRefusal(method:string,path:string,headers:IncomingHttpHeaders){
 if(method!=='GET'&&method!=='HEAD')return `${method} requests are refused: Support gives read-only cluster access.`;
 if(headers.upgrade||/\bupgrade\b/i.test(String(headers.connection??'')))return 'Connection upgrades are refused: exec, attach and port-forward are not available.';
 let segments:string[];
 try{segments=path.split('/').map(s=>decodeURIComponent(s));}catch{return 'The request path is not valid.';}
 if(!path.startsWith('/')||segments.some(s=>s==='.'||s==='..'||s.includes('/')))return 'The request path is not valid.';
 if(refusedSubresource.test(segments.join('/')))return 'The exec, attach, portforward and proxy subresources are refused.';
 return undefined;
}

/** Request headers passed to the API server. Authorization and impersonation headers are never passed. */
const forwarded=['accept','accept-encoding','user-agent','kubectl-command','kubectl-session','if-none-match','if-modified-since'];
const hopByHop=new Set(['connection','keep-alive','transfer-encoding','upgrade','proxy-authenticate','proxy-authorization','te','trailer']);

/** Starts a request to the API server of `target`. `path` starts with / and may contain a query string. */
function open(target:KubernetesTarget,method:string,path:string,headers:Record<string,string>):ClientRequest{
 const {server,secret}=target,base=server.pathname.replace(/\/+$/,'');
 const options={method,hostname:server.hostname.replace(/^\[|\]$/g,''),port:server.port||undefined,path:base+path,headers:{...headers,authorization:'Bearer '+secret.token},ca:secret.ca?.trim()||undefined,rejectUnauthorized:!secret.insecure};
 return server.protocol==='https:'?httpsRequest(options):httpRequest(options);
}

/** Kubernetes Status object, so that kubectl prints `message`. */
export function kubernetesStatus(code:number,message:string){
 const reason=code===403?'Forbidden':code===404?'NotFound':code===502?'ServiceUnavailable':'BadRequest';
 return JSON.stringify({kind:'Status',apiVersion:'v1',metadata:{},status:'Failure',message,reason,code});
}

/** Short reason for a connection error to an API server. */
export function connectionReason(e:unknown){
 const code=String((e as {code?:unknown})?.code??'');
 if(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code))return 'TLS verification failed. Add the CA certificate of the cluster.';
 if(code==='ECONNREFUSED')return 'The API server refused the connection.';
 if(code==='ENOTFOUND'||code==='EAI_AGAIN')return 'The API server name does not resolve. Check the URL and the VPN.';
 if(code==='ETIMEDOUT'||code==='ECONNRESET')return 'The connection to the API server timed out or was reset. Check the URL and the VPN.';
 return 'The API server is unreachable. Check the URL and the VPN.';
}

/**
 * Forwards an agent request to the API server of `target` with the context's token, and streams the response back,
 * including watches and log follows. The request must have passed `kubernetesRefusal`. Closing the agent connection
 * closes the upstream request. Resolves when the response ends.
 */
export function proxyKubernetes(req:IncomingMessage,res:ServerResponse,target:KubernetesTarget,path:string){
 return new Promise<void>(resolve=>{
  const headers:Record<string,string>={};
  for(const h of forwarded){const v=req.headers[h];if(typeof v==='string')headers[h]=v;}
  const upstream=open(target,req.method??'GET',path,headers);
  upstream.on('response',up=>{
   const out:Record<string,string|string[]>={};
   for(const [k,v] of Object.entries(up.headers))if(v!==undefined&&!hopByHop.has(k))out[k]=v;
   res.writeHead(up.statusCode??502,out);
   up.pipe(res);
   up.on('end',resolve);
   up.on('error',()=>{res.destroy();resolve();});
  });
  upstream.on('error',e=>{
   if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(kubernetesStatus(502,`Context ${target.name}: ${connectionReason(e)}`));}
   else res.destroy();
   resolve();
  });
  res.on('close',()=>{upstream.destroy();resolve();});
  upstream.end();
 });
}

/**
 * Sends a GET request to the API server of `target` and returns its status and body. Bodies over `limit` bytes are
 * refused. Throws AppError 502 when the API server cannot be reached.
 */
export function kubernetesGet(target:KubernetesTarget,path:string,{signal,limit=8_000_000,accept='application/json',timeoutMs=30000}:{signal?:AbortSignal;limit?:number;accept?:string;timeoutMs?:number}={}){
 return new Promise<{status:number;body:string}>((resolve,reject)=>{
  const upstream=open(target,'GET',path,{accept,'user-agent':'support'});
  const fail=(e:unknown)=>{upstream.destroy();reject(e instanceof AppError?e:new AppError(502,`Context ${target.name}: ${connectionReason(e)}`));};
  const timer=setTimeout(()=>fail(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})),timeoutMs);
  const abort=()=>fail(new AppError(409,'Request stopped.'));
  signal?.addEventListener('abort',abort,{once:true});
  upstream.on('response',up=>{
   const chunks:Buffer[]=[];let size=0;
   up.on('data',(c:Buffer)=>{size+=c.length;if(size>limit){fail(new AppError(413,`The response of ${target.name} is larger than ${Math.round(limit/1_000_000)} MB. Narrow the request.`));return;}chunks.push(c);});
   up.on('end',()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({status:up.statusCode??502,body:Buffer.concat(chunks).toString('utf8')});});
   up.on('error',fail);
  });
  upstream.on('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);fail(e);});
  upstream.end();
 });
}

/** Message of a Kubernetes Status body, or the start of the body. */
export function statusMessage(body:string){try{const v=JSON.parse(body) as {message?:unknown};if(typeof v.message==='string')return v.message.slice(0,500);}catch{}return body.trim().split('\n')[0]?.slice(0,300)||'no detail';}

/** Sends a GET request and parses the JSON response. Throws AppError with the API server's message on HTTP errors. */
export async function kubernetesJSON(target:KubernetesTarget,path:string,signal?:AbortSignal):Promise<unknown>{
 const r=await kubernetesGet(target,path,{signal});
 if(r.status<200||r.status>=300)throw new AppError(r.status===401?502:r.status===403||r.status===404?r.status:502,`Context ${target.name} answered HTTP ${r.status}: ${statusMessage(r.body)}`);
 try{return JSON.parse(r.body);}catch{throw new AppError(502,`Context ${target.name} returned a response that is not JSON.`);}
}

/** Reads /version through one enabled context. Returns the Kubernetes version, or why the context cannot be read. */
export async function checkContext(store:Store,config:Config,name:string,signal?:AbortSignal){
 try{
  const r=await kubernetesGet(kubernetesTarget(store,config,name),'/version',{signal,timeoutMs:10000,limit:65536});
  if(r.status===401)return {ok:false,detail:`${name}: the API server rejected the token. It is invalid or expired.`};
  if(r.status<200||r.status>=300)return {ok:false,detail:`${name}: HTTP ${r.status}. ${statusMessage(r.body)}`};
  const version=(JSON.parse(r.body) as {gitVersion?:string}).gitVersion;
  return {ok:true,detail:`${name}: Kubernetes ${version??'version unknown'}.`};
 }catch(e){return {ok:false,detail:e instanceof AppError?e.message:`${name}: the check failed.`};}
}

/**
 * Kubeconfig for an agent session. Each enabled context points at the agent gateway URL of the session, without a
 * token or certificate: the gateway adds the context's token. `baseUrl` is the session URL of the gateway.
 */
export function agentKubeconfig(baseUrl:string,contexts:string[]){
 return JSON.stringify({
  apiVersion:'v1',kind:'Config',preferences:{},
  clusters:contexts.map(name=>({name,cluster:{server:`${baseUrl}/k8s/${encodeURIComponent(name)}`}})),
  users:[{name:'support',user:{}}],
  contexts:contexts.map(name=>({name,context:{cluster:name,user:'support'}})),
  'current-context':contexts[0]??'',
 },null,1)+'\n';
}

export type KubeconfigFile={name:string;content:string};
/** Context read from a kubeconfig. `secret` is set for token contexts; `unsupported` says why another context cannot be used. */
export type ImportedContext={name:string;server:string;secret?:KubernetesSecret;unsupported?:string};
type Named<T>={name:string}&T;
const view=z.object({
 clusters:z.array(z.object({name:z.string(),cluster:z.object({server:z.string().optional(),'certificate-authority-data':z.string().optional(),'insecure-skip-tls-verify':z.boolean().optional()}).passthrough()}).passthrough()).nullish(),
 users:z.array(z.object({name:z.string(),user:z.record(z.string(),z.unknown()).nullish()}).passthrough()).nullish(),
 contexts:z.array(z.object({name:z.string(),context:z.object({cluster:z.string().optional(),user:z.string().optional()}).passthrough()}).passthrough()).nullish(),
}).passthrough();

function kubectlBinary(){
 const binary=process.env.SUPPORT_KUBECTL_BINARY??'/usr/local/bin/kubectl';
 if(!isAbsolute(binary))throw new AppError(400,'SUPPORT_KUBECTL_BINARY must be an absolute path.');
 return binary;
}
/** Environment for kubectl: no inherited KUBECONFIG, proxy and TLS variables kept. */
function kubectlEnvironment(home:string,kubeconfig:string){
 const env:NodeJS.ProcessEnv={HOME:home,KUBECONFIG:kubeconfig};
 for(const key of ['PATH','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];
 return env;
}
/** Returns the first line of a kubectl error, with temporary file paths replaced by the uploaded file names. */
function kubectlError(error:unknown,paths:string[],names:string[]){
 let line=String((error as {stderr?:string})?.stderr??'').split('\n').find(l=>l.trim())??'kubectl failed.';
 paths.forEach((path,i)=>{line=line.split(path).join(names[i]);});
 return line.replace(/^error: /,'').slice(0,300);
}

/** Why a kubeconfig user cannot be used by Support, or undefined when it has a bearer token. */
function unsupportedUser(user:Record<string,unknown>|null|undefined){
 if(!user)return 'it has no user entry';
 if(typeof user.token==='string'&&user.token.trim())return undefined;
 if(user.exec)return 'it signs in with an exec plugin';
 if(user['auth-provider'])return 'it signs in with an auth provider';
 if(user['client-certificate-data']||user['client-certificate'])return 'it signs in with a client certificate';
 if(user.tokenFile)return 'it reads its token from a file';
 if(user.username||user.password)return 'it signs in with a username and password';
 return 'it has no token';
}

/** Converts a parsed kubeconfig into contexts. Contexts without a bearer token are returned with `unsupported`. */
export function kubeconfigContexts(value:unknown):ImportedContext[]{
 const v=view.parse(value);
 const clusters=new Map((v.clusters??[]).map(c=>[c.name,c.cluster])),users=new Map((v.users??[]).map(u=>[u.name,u.user]));
 return (v.contexts??[]).map(({name,context}):ImportedContext=>{
  const cluster=context.cluster?clusters.get(context.cluster):undefined,user=context.user?users.get(context.user):undefined;
  const server=cluster?.server??'';
  if(!kubernetesContextName.safeParse(name).success)return {name,server,unsupported:'Not supported: its name uses characters other than letters, digits and . _ @ : / -.'};
  if(!cluster||!server)return {name,server,unsupported:'Not supported: its cluster has no server URL.'};
  const reason=unsupportedUser(user);
  if(reason)return {name,server,unsupported:`Not supported: ${reason}. Use a ServiceAccount token.`};
  const ca=cluster['certificate-authority-data']?Buffer.from(cluster['certificate-authority-data'],'base64').toString('utf8'):undefined;
  return {name,server,secret:{token:String(user!.token).trim(),...(ca?{ca}:{}),...(cluster['insecure-skip-tls-verify']?{insecure:true}:{})}};
 });
}

/**
 * Merges kubeconfig files with `kubectl config view --flatten` and returns their contexts. Certificates referenced by
 * file path cannot be read and make the merge fail. A cluster, user or context name may appear in several files only
 * with identical content: kubectl keeps only the first entry for a name, so a differing duplicate would make a context
 * use the wrong credentials. Files are written to a private temporary folder, deleted after the merge.
 */
export async function importKubeconfigs(files:KubeconfigFile[]):Promise<ImportedContext[]>{
 if(process.platform!=='linux')throw new AppError(403,'Importing kubeconfig files requires Support to run on Linux.');
 const binary=kubectlBinary(),dir=await mkdtemp(join(tmpdir(),'support-kubeconfig-'));
 const names=files.map(f=>f.name),paths=files.map((_,i)=>join(dir,'kubeconfig-'+i));
 try{
  const seen=new Map<string,{file:string;entry:string}>(),conflicts:string[]=[];
  for(const [i,file] of files.entries()){
   await writeFile(paths[i],file.content,{mode:0o600,flag:'wx'});
   let parsed:z.infer<typeof view>;
   try{const {stdout}=await exec(binary,['config','view','--raw','-o','json'],{timeout:20000,maxBuffer:4_000_000,encoding:'utf8',shell:false,env:kubectlEnvironment(dir,paths[i])});parsed=view.parse(JSON.parse(stdout));}
   catch(e){throw new AppError(400,`${file.name} is not a valid kubeconfig: ${kubectlError(e,paths,names)}`);}
   for(const [kind,label] of [['clusters','Cluster'],['users','User'],['contexts','Context']] as const){
    for(const entry of (parsed[kind]??[]) as Named<object>[]){
     const key=label+'\u0000'+entry.name,value=JSON.stringify(entry),prior=seen.get(key);
     if(!prior)seen.set(key,{file:file.name,entry:value});
     else if(prior.entry!==value)conflicts.push(`${label} "${entry.name}" is defined differently in ${prior.file} and ${file.name}.`);
    }
   }
  }
  if(conflicts.length)throw new AppError(400,conflicts.slice(0,3).join(' ')+(conflicts.length>3?` ${conflicts.length-3} more conflicts.`:'')+' Rename the entries in one file, then import the files again.');
  let merged:unknown;
  try{merged=JSON.parse((await exec(binary,['config','view','--flatten','-o','json'],{timeout:60000,maxBuffer:16_000_000,encoding:'utf8',shell:false,env:kubectlEnvironment(dir,paths.join(':'))})).stdout);}
  catch(e){throw new AppError(400,`The kubeconfig files could not be merged: ${kubectlError(e,paths,names)}. Embed certificates with the *-data fields instead of file paths.`);}
  return kubeconfigContexts(merged);
 }finally{await rm(dir,{recursive:true,force:true});}
}

/** Input of the kubernetes_read tool. */
export const kubernetesReadInput=z.object({
 context:z.string().min(1).max(200),
 path:z.string().trim().min(1).max(2000).regex(/^\/(api|apis|version)(\/|\?|$)/,'Use an API path such as /api/v1/namespaces/NAME/pods or /apis/apps/v1/namespaces/NAME/deployments/NAME.'),
}).strict();
/** Returns `value` without the metadata.managedFields entries, which are long and rarely useful. */
export function withoutManagedFields(value:unknown):unknown{
 if(Array.isArray(value))return value.map(withoutManagedFields);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='managedFields').map(([k,v])=>[k,withoutManagedFields(v)]));
 return value;
}
/**
 * Reads one Kubernetes API path through an enabled context, with the same refusals as the agent gateway. Returns
 * parsed JSON without managedFields, or text for pod logs (at most the last 60,000 characters).
 */
export async function readKubernetes(store:Store,config:Config,input:unknown,signal?:AbortSignal){
 const i=kubernetesReadInput.parse(input),[path]=i.path.split('?');
 const reason=kubernetesRefusal('GET',path,{});
 if(reason)throw new AppError(403,reason);
 const target=kubernetesTarget(store,config,i.context);
 const r=await kubernetesGet(target,i.path,{signal,limit:4_000_000});
 if(r.status<200||r.status>=300)throw new AppError(r.status===403||r.status===404?r.status:502,`Context ${i.context} answered HTTP ${r.status}: ${statusMessage(r.body)}`);
 try{return withoutManagedFields(JSON.parse(r.body));}catch{return r.body.length>60000?'[earlier lines truncated]\n'+r.body.slice(-60000):r.body;}
}

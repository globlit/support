import {z} from 'zod';
import {AppError,type Store} from './store.js';
import {serviceBase} from './gitlab.js';
import {serverAuthHeaders} from './service-auth.js';
import {Grafana,grafanaAvailable,readJSON} from './grafana.js';
import {enabledContexts,kubernetesJSON,kubernetesTarget} from './kubernetes.js';
import {type Config,type PrometheusSource} from '../src/model.js';
type TunnelSource=Extract<PrometheusSource,{kind:'tunnel'}>;

/** Prometheus HTTP API endpoints that `prometheus_api` may read. All are GET requests under /api/v1. */
export const prometheusEndpoints=['targets','rules','alerts','labels','label_values','series','metadata','status/buildinfo','status/runtimeinfo','status/tsdb','status/flags','status/config'] as const;
export type SourceInfo={name:string;kind:'url'|'grafana'|'tunnel';detail:string};

/**
 * Path of a Prometheus API endpoint through the Kubernetes API service proxy, for a server inside a cluster.
 * The target is service/NAME (the service port) or a pod name (the container port). Needs `get` on services/proxy or
 * pods/proxy in the namespace.
 */
export function serviceProxyPath(source:TunnelSource,path:string){
 const [kind,name]=source.target.includes('/')?source.target.split('/',2):['pod',source.target];
 const resource=kind==='service'||kind==='svc'?'services':kind==='pod'?'pods':undefined;
 if(!resource)throw new AppError(400,`Prometheus server ${source.name}: use service/NAME or a pod name as target. ${kind} targets cannot be reached through the API server.`);
 const prefix=source.pathPrefix.replace(/^\/+|\/+$/g,'');
 return `/api/v1/namespaces/${encodeURIComponent(source.namespace)}/${resource}/${encodeURIComponent(name)}:${source.port}/proxy/${prefix?prefix+'/':''}api/v1/${path}`;
}
const timeValue=z.string().trim().min(1).max(40);
const step=z.string().regex(/^\d{1,6}(ms|s|m|h)?$/,'Use a duration such as 60s or 5m.');

/**
 * Prometheus servers the agent can query: each configured server reached by URL or through the Kubernetes API service
 * proxy of an enabled context, and each Prometheus datasource of Grafana.
 */
export class PrometheusSources {
 private grafana?:Grafana;private grafanaSources=new Map<string,string>();private grafanaError?:string;
 private constructor(private store:Store,private config:Config,private fetcher:typeof fetch){}
 /** Lists the sources. Grafana datasources are read once. A Grafana failure leaves the other sources available. */
 static async create(store:Store,config:Config,fetcher:typeof fetch=fetch,signal?:AbortSignal){
  const s=new PrometheusSources(store,config,fetcher);
  if(grafanaAvailable(config)){
   try{s.grafana=new Grafana(store,config,fetcher);for(const d of await s.grafana.prometheusDatasources(signal))s.grafanaSources.set('grafana/'+d.name,d.uid);}
   catch(e){s.grafanaError=e instanceof AppError?e.message:'Grafana datasources could not be read.';}
  }
  return s;
 }
 /** Grafana client, when Grafana is enabled and its datasources were read. */
 grafanaClient(){return this.grafana;}
 /** Source names, configured servers first. */
 names(){return this.list().map(s=>s.name);}
 /** Returns every source with how it is reached, and why Grafana datasources are missing when the read failed. */
 list():SourceInfo[]{
  const out:SourceInfo[]=[];
  for(const s of this.config.prometheusSources)if(this.usable(s))out.push(s.kind==='url'?{name:s.name,kind:'url',detail:s.endpoint}:{name:s.name,kind:'tunnel',detail:`context ${s.context}, namespace ${s.namespace}, ${s.target}:${s.port}`});
  for(const name of this.grafanaSources.keys())out.push({name,kind:'grafana',detail:'Grafana datasource proxy'});
  return out;
 }
 /** True when a configured server can be queried: Prometheus is enabled, and servers inside a cluster also need their Kubernetes context enabled. */
 private usable(s:PrometheusSource){
  if(!this.config.connections.Prometheus.enabled)return false;
  return s.kind==='url'||enabledContexts(this.store,this.config).some(c=>c.name===s.context);
 }
 /** Summary for the agent, with sources that are configured but unavailable. */
 describe(){
  const unavailable:string[]=[];
  if(this.grafanaError)unavailable.push(`Grafana datasources: ${this.grafanaError}`);
  if(!this.config.connections.Prometheus.enabled&&this.config.prometheusSources.length)unavailable.push('Configured servers: Prometheus is disabled in Settings.');
  else for(const s of this.config.prometheusSources)if(s.kind==='tunnel'&&!this.usable(s))unavailable.push(`${s.name}: Kubernetes context ${s.context} is not enabled in Settings.`);
  return {sources:this.list(),...(unavailable.length?{unavailable}:{})};
 }
 /** Builds the URL and headers of an /api/v1 path for a source reached over HTTP: a URL server or a Grafana datasource. */
 private async target(name:string,path:string):Promise<{url:URL;headers:Record<string,string>}>{
  const uid=this.grafanaSources.get(name);
  if(uid&&this.grafana)return {url:this.grafana.proxyURL(uid,'api/v1/'+path),headers:this.grafana.authHeaders()};
  const source=this.config.prometheusSources.find(s=>s.name===name);
  if(source?.kind==='url'&&this.usable(source))return {url:new URL('api/v1/'+path,serviceBase(source.endpoint)),headers:serverAuthHeaders(this.store,source.id)};
  throw new AppError(400,`Unknown Prometheus source ${name}. Use one of: ${this.names().join(', ')||'none configured'}.`);
 }
 private source(name:string|undefined){const n=name??this.names()[0];if(!n)throw new AppError(400,'No Prometheus source is configured.');return n;}
 private async get(name:string,path:string,params:Record<string,string|string[]>,signal?:AbortSignal){
  const source=this.config.prometheusSources.find(s=>s.name===name);
  if(source?.kind==='tunnel'&&this.usable(source)){
   const query=new URLSearchParams();for(const [k,v] of Object.entries(params))for(const x of Array.isArray(v)?v:[v])query.append(k,x);
   const target=kubernetesTarget(this.store,this.config,source.context),q=query.toString();
   return kubernetesJSON(target,serviceProxyPath(source,path)+(q?'?'+q:''),signal);
  }
  const {url,headers}=await this.target(name,path);
  for(const [k,v] of Object.entries(params))for(const x of Array.isArray(v)?v:[v])url.searchParams.append(k,x);
  return readJSON(this.fetcher,url,headers,signal,`Prometheus source ${name}`);
 }
 /** Runs an instant PromQL query. */
 query(input:unknown,signal?:AbortSignal){
  const i=z.object({source:z.string().max(120).optional(),query:z.string().min(1).max(4000),time:timeValue.optional()}).strict().parse(input);
  return this.get(this.source(i.source),'query',{query:i.query,timeout:'20s',limit:'200',...(i.time?{time:i.time}:{})},signal);
 }
 /** Runs a PromQL range query. */
 queryRange(input:unknown,signal?:AbortSignal){
  const i=z.object({source:z.string().max(120).optional(),query:z.string().min(1).max(4000),start:timeValue,end:timeValue,step}).strict().parse(input);
  return this.get(this.source(i.source),'query_range',{query:i.query,start:i.start,end:i.end,step:i.step,timeout:'20s',limit:'100'},signal);
 }
 /**
  * Reads one Prometheus API endpoint. `targets` returns a compact list (scrape pool, job, instance, health, last error)
  * and accepts `state` and `health` filters. `label_values` needs `label`. `series` needs one or more `match[]`.
  */
 async api(input:unknown,signal?:AbortSignal){
  const i=z.object({source:z.string().max(120).optional(),endpoint:z.enum(prometheusEndpoints),params:z.record(z.string().max(40),z.union([z.string().max(2000),z.array(z.string().max(2000)).max(20)])).optional()}).strict().parse(input);
  const name=this.source(i.source),params={...(i.params??{})};
  if(i.endpoint==='label_values'){const label=params.label;delete params.label;if(typeof label!=='string'||!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label))throw new AppError(400,'label_values needs params.label, a label name.');return this.get(name,`label/${label}/values`,params,signal);}
  if(i.endpoint==='targets'){
   const health=typeof params.health==='string'?params.health:undefined;delete params.health;
   const v=await this.get(name,'targets',{state:'active',...params},signal) as {data?:{activeTargets?:Record<string,unknown>[];droppedTargets?:unknown[]}};
   const all=(v.data?.activeTargets??[]).map(t=>{const l=(t.labels??{}) as Record<string,string>;return {scrapePool:t.scrapePool,job:l.job,instance:l.instance,labels:l,health:t.health,lastError:t.lastError||undefined,lastScrape:t.lastScrape,lastScrapeDuration:t.lastScrapeDuration,scrapeUrl:t.scrapeUrl};});
   const targets=health?all.filter(t=>t.health===health):all;
   const byHealth:Record<string,number>={};for(const t of all)byHealth[String(t.health)]=(byHealth[String(t.health)]??0)+1;
   return {total:all.length,byHealth,shown:Math.min(targets.length,300),targets:targets.slice(0,300),droppedTargets:v.data?.droppedTargets?.length};
  }
  return this.get(name,i.endpoint,params,signal);
 }
 /** Reads `status/buildinfo` from one source. Used by the Settings test. */
 buildInfo(name:string,signal?:AbortSignal){return this.get(name,'status/buildinfo',{},signal);}
}

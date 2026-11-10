import {createServer} from 'node:net';
import type {ChildProcess} from 'node:child_process';
import {z} from 'zod';
import {AppError,type Store} from './store.js';
import {serviceBase} from './gitlab.js';
import {serviceAuthHeaders} from './service-auth.js';
import {Grafana,grafanaAvailable,readJSON} from './grafana.js';
import {openTunnel,toolboxFiles} from './toolbox.js';
import type {Config,PrometheusSource} from '../src/model.js';

/** Prometheus HTTP API endpoints that `prometheus_api` may read. All are GET requests under /api/v1. */
export const prometheusEndpoints=['targets','rules','alerts','labels','label_values','series','metadata','status/buildinfo','status/runtimeinfo','status/tsdb','status/flags','status/config'] as const;
export type SourceInfo={name:string;kind:'direct'|'grafana'|'tunnel';detail:string};
type Tunnel={port:number;child:ChildProcess};
export type TunnelOpener=(config:Config,source:PrometheusSource,port:number)=>Promise<ChildProcess>;

/** Returns a free TCP port on 127.0.0.1. */
export function freePort(){return new Promise<number>((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address() as {port:number};s.close(()=>resolve(port));});});}
const defaultOpener=(store:Store):TunnelOpener=>async(config,source,port)=>(await openTunnel(config,{context:source.context,namespace:source.namespace,target:source.target,ports:[`${port}:${source.port}`],durationSeconds:config.toolbox.portForwardMaxSeconds},toolboxFiles(store))).child;
const timeValue=z.string().trim().min(1).max(40);
const step=z.string().regex(/^\d{1,6}(ms|s|m|h)?$/,'Use a duration such as 60s or 5m.');

/**
 * Prometheus servers the agent can query: the direct Prometheus connection, each Prometheus datasource of Grafana, and
 * each configured source reached through a Toolbox tunnel. A tunnel opens on the first request to its source and is
 * reused until it exits or `close` is called.
 */
export class PrometheusSources {
 private grafana?:Grafana;private grafanaSources=new Map<string,string>();private grafanaError?:string;
 private tunnels=new Map<string,Promise<Tunnel>>();
 private constructor(private store:Store,private config:Config,private fetcher:typeof fetch,private opener:TunnelOpener){}
 /** Lists the sources. Grafana datasources are read once. A Grafana failure leaves the other sources available. */
 static async create(store:Store,config:Config,fetcher:typeof fetch=fetch,signal?:AbortSignal,opener:TunnelOpener=defaultOpener(store)){
  const s=new PrometheusSources(store,config,fetcher,opener);
  if(grafanaAvailable(config)){
   try{s.grafana=new Grafana(store,config,fetcher);for(const d of await s.grafana.prometheusDatasources(signal))s.grafanaSources.set('grafana/'+d.name,d.uid);}
   catch(e){s.grafanaError=e instanceof AppError?e.message:'Grafana datasources could not be read.';}
  }
  return s;
 }
 /** Grafana client, when Grafana is enabled and its datasources were read. */
 grafanaClient(){return this.grafana;}
 /** Source names, direct source first. */
 names(){return this.list().map(s=>s.name);}
 /** Returns every source with how it is reached, and why Grafana datasources are missing when the read failed. */
 list():SourceInfo[]{
  const c=this.config.connections.Prometheus,t=this.config.toolbox,out:SourceInfo[]=[];
  if(c.enabled&&c.endpoint)out.push({name:'prometheus',kind:'direct',detail:c.endpoint});
  for(const name of this.grafanaSources.keys())out.push({name,kind:'grafana',detail:'Grafana datasource proxy'});
  if(this.config.connections.Toolbox.enabled&&t.allowPortForward)for(const s of this.config.prometheusSources)out.push({name:s.name,kind:'tunnel',detail:`context ${s.context}, namespace ${s.namespace}, ${s.target}:${s.port}`});
  return out;
 }
 /** Summary for the agent, with sources that are configured but unavailable. */
 describe(){
  const unavailable:string[]=[];
  if(this.grafanaError)unavailable.push(`Grafana datasources: ${this.grafanaError}`);
  if(this.config.prometheusSources.length&&!(this.config.connections.Toolbox.enabled&&this.config.toolbox.allowPortForward))unavailable.push('Sources through Kubernetes: Toolbox port forwarding is disabled in Settings.');
  return {sources:this.list(),...(unavailable.length?{unavailable}:{})};
 }
 private async tunnel(source:PrometheusSource){
  let pending=this.tunnels.get(source.name);
  if(pending){const t=await pending.catch(()=>undefined);if(t&&t.child.exitCode===null&&t.child.signalCode===null)return t;this.tunnels.delete(source.name);}
  pending=(async()=>{const port=await freePort();return {port,child:await this.opener(this.config,source,port)};})();
  this.tunnels.set(source.name,pending);
  try{return await pending;}catch(e){this.tunnels.delete(source.name);throw e;}
 }
 /** Builds the URL and headers of an /api/v1 path for a source. Opens the source's tunnel when needed. */
 private async target(name:string,path:string):Promise<{url:URL;headers:Record<string,string>}>{
  if(name==='prometheus'&&this.list().some(s=>s.name==='prometheus'))return {url:new URL('api/v1/'+path,serviceBase(this.config.connections.Prometheus.endpoint)),headers:serviceAuthHeaders(this.store,'Prometheus')};
  const uid=this.grafanaSources.get(name);
  if(uid&&this.grafana)return {url:this.grafana.proxyURL(uid,'api/v1/'+path),headers:this.grafana.authHeaders()};
  const source=this.config.prometheusSources.find(s=>s.name===name);
  if(source&&this.list().some(s=>s.name===name)){const {port}=await this.tunnel(source);const prefix=source.pathPrefix.replace(/^\/+|\/+$/g,'');return {url:new URL(`http://127.0.0.1:${port}/${prefix?prefix+'/':''}api/v1/${path}`),headers:{}};}
  throw new AppError(400,`Unknown Prometheus source ${name}. Use one of: ${this.names().join(', ')||'none configured'}.`);
 }
 private source(name:string|undefined){const n=name??this.names()[0];if(!n)throw new AppError(400,'No Prometheus source is configured.');return n;}
 private async get(name:string,path:string,params:Record<string,string|string[]>,signal?:AbortSignal){
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
 /** Stops every tunnel opened by this instance. */
 close(){for(const p of this.tunnels.values())void p.then(t=>t.child.kill('SIGTERM'),()=>{});this.tunnels.clear();}
}

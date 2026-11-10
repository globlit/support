import {z} from 'zod';
import {AppError,type Store} from './store.js';
import {serviceBase} from './gitlab.js';
import {serviceAuthHeaders} from './service-auth.js';
import {networkReason} from './network-reason.js';
import type {Config} from '../src/model.js';

/** Largest Grafana or Prometheus response read, in bytes. */
export const responseLimit=8_000_000;

/** Reads a JSON response of at most `responseLimit` bytes. Fails with an AppError on network errors, HTTP errors and oversized or invalid bodies. */
export async function readJSON(fetcher:typeof fetch,url:URL,headers:Record<string,string>,signal?:AbortSignal,service='Service'){
 let response:Response;
 try{response=await fetcher(url,{method:'GET',redirect:'manual',headers:{...headers,Accept:'application/json'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});}
 catch(e){if(signal?.aborted)throw new AppError(409,'Request stopped.');throw new AppError(502,`${service} is unreachable: ${networkReason(e)}`);}
 const chunks:Uint8Array[]=[];let size=0;
 if(response.body)for await(const c of response.body as unknown as AsyncIterable<Uint8Array>){size+=c.length;if(size>responseLimit){await response.body.cancel().catch(()=>{});throw new AppError(502,`${service} response is larger than 8 MB. Narrow the query.`);}chunks.push(c);}
 const text=Buffer.concat(chunks).toString('utf8');
 let value:unknown;try{value=JSON.parse(text);}catch{value=undefined;}
 if(!response.ok){
  const detail=(value as {error?:unknown;message?:unknown})?.error??(value as {message?:unknown})?.message;
  throw new AppError(502,`${service} returned HTTP ${response.status}${typeof detail==='string'?': '+detail.slice(0,300):'.'}`);
 }
 if(value===undefined)throw new AppError(502,`${service} returned a response that is not JSON.`);
 return value;
}

/** True when Grafana is enabled with a service URL. The credential is optional for instances with anonymous access. */
export function grafanaAvailable(config:Config){const c=config.connections.Grafana;return c.enabled&&!!c.endpoint.trim();}

export type GrafanaDatasource={uid:string;name:string;type:string};
const datasourceList=z.array(z.object({uid:z.string(),name:z.string(),type:z.string()}).passthrough());
const frontendSettings=z.object({datasources:z.record(z.string(),z.object({uid:z.string().optional(),name:z.string(),type:z.string()}).passthrough())}).passthrough();
const searchHits=z.array(z.object({uid:z.string(),title:z.string(),url:z.string().optional(),folderTitle:z.string().optional(),tags:z.array(z.string()).optional()}).passthrough());
type Panel={title?:string;type?:string;datasource?:unknown;targets?:{expr?:string;query?:string;refId?:string}[];panels?:Panel[]};

/** Read-only Grafana client. Requests use the Grafana credential saved in the Vault. */
export class Grafana {
 readonly base:URL;private headers:Record<string,string>;
 constructor(store:Store,config:Config,private fetcher:typeof fetch=fetch){
  this.base=serviceBase(config.connections.Grafana.endpoint);this.headers=serviceAuthHeaders(store,'Grafana');
 }
 private get(path:string,params:Record<string,string>={},signal?:AbortSignal){
  const u=new URL(path,this.base);for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);
  return readJSON(this.fetcher,u,this.headers,signal,'Grafana');
 }
 /**
  * Returns the Prometheus datasources visible to the user. Reads `/api/datasources`, or `/api/frontend/settings` when
  * the user may query but not list datasources.
  */
 async prometheusDatasources(signal?:AbortSignal):Promise<GrafanaDatasource[]>{
  let all:GrafanaDatasource[];
  try{all=datasourceList.parse(await this.get('api/datasources',{},signal)).map(d=>({uid:d.uid,name:d.name,type:d.type}));}
  catch(e){
   if(!(e instanceof AppError)||!/HTTP 403/.test(e.message))throw e;
   all=Object.values(frontendSettings.parse(await this.get('api/frontend/settings',{},signal)).datasources).flatMap(d=>d.uid?[{uid:d.uid,name:d.name,type:d.type}]:[]);
  }
  return all.filter(d=>d.type==='prometheus').slice(0,30);
 }
 /** Returns the URL of a Prometheus HTTP API path, such as `api/v1/query`, through the Grafana datasource proxy. */
 proxyURL(uid:string,path:string){return new URL(`api/datasources/proxy/uid/${encodeURIComponent(uid)}/${path}`,this.base);}
 /** Request headers for proxied datasource requests. */
 authHeaders(){return this.headers;}
 /** Searches dashboards by title. Returns at most 20 dashboards. */
 async searchDashboards(input:unknown,signal?:AbortSignal){
  const {query}=z.object({query:z.string().trim().max(200)}).strict().parse(input);
  const hits=searchHits.parse(await this.get('api/search',{type:'dash-db',query,limit:'20'},signal));
  return hits.map(h=>({uid:h.uid,title:h.title,folder:h.folderTitle,tags:h.tags,url:h.url?new URL(h.url.replace(/^\/+/,''),this.base).href:undefined}));
 }
 /** Reads one dashboard. Returns its title, variables and, for each panel, the title and its query expressions. */
 async dashboard(input:unknown,signal?:AbortSignal){
  const {uid}=z.object({uid:z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/)}).strict().parse(input);
  const value=z.object({dashboard:z.object({title:z.string(),panels:z.array(z.unknown()).optional(),rows:z.array(z.unknown()).optional(),templating:z.object({list:z.array(z.object({name:z.string(),query:z.unknown().optional()}).passthrough()).optional()}).passthrough().optional()}).passthrough()}).passthrough().parse(await this.get('api/dashboards/uid/'+encodeURIComponent(uid),{},signal));
  const panels:{title:string;type?:string;datasource?:string;queries:string[]}[]=[];
  const walk=(list:unknown[]|undefined)=>{for(const raw of list??[]){const p=raw as Panel;const queries=(p.targets??[]).map(t=>t.expr??t.query).filter((q):q is string=>typeof q==='string'&&!!q.trim());
   if(queries.length)panels.push({title:p.title??'',type:p.type,datasource:typeof p.datasource==='string'?p.datasource:(p.datasource as {uid?:string})?.uid,queries:queries.map(q=>q.slice(0,2000))});walk(p.panels);}};
  walk(value.dashboard.panels);for(const r of value.dashboard.rows??[])walk((r as {panels?:unknown[]}).panels);
  return {uid,title:value.dashboard.title,variables:(value.dashboard.templating?.list??[]).map(v=>({name:v.name,query:typeof v.query==='string'?v.query.slice(0,500):undefined})),panels:panels.slice(0,100)};
 }
}

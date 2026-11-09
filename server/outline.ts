import {z} from 'zod';
import {AppError,type Store} from './store.js';
import {boundedJSON,serviceBase} from './gitlab.js';
import type {Config} from '../src/model.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longest document text returned to the agent, in characters. */
export const outlineTextLimit=16000;

/**
 * Returns the parts of an Outline collection reference: the text to match against names and IDs, and the 10-character
 * URL ID when the reference is a collection URL (`…/collection/devops-AbC123xyz9`), a URL slug, or a bare URL ID.
 */
export function outlineCollectionRef(value:string){
 const text=value.trim(),path=text.match(/\/collection\/([^/?#]+)/)?.[1];
 const ref=path?decodeURIComponent(path):text;
 const urlId=ref.match(/(?:^|-)([A-Za-z0-9]{10})$/)?.[1];
 return {ref,urlId};
}

/** True when Outline is enabled, has a service URL, an allowed collection and a saved API key. */
export function outlineAvailable(store:Store,config:Config){
 const c=config.connections.Outline;
 return c.enabled&&!!c.endpoint.trim()&&!!c.scope.trim()&&store.vaultStatus().credentials.includes('Outline');
}

const collectionList=z.object({data:z.array(z.object({id:z.string(),urlId:z.string().optional(),name:z.string()}))});
const searchResult=z.object({data:z.array(z.object({context:z.string().optional(),document:z.object({id:z.string(),title:z.string(),url:z.string().optional(),updatedAt:z.string().optional(),collectionId:z.string().nullable().optional()})}))});
const documentInfo=z.object({data:z.object({id:z.string(),title:z.string(),text:z.string().optional(),url:z.string().optional(),updatedAt:z.string().optional(),collectionId:z.string().nullable().optional()})});

/**
 * Read-only access to the allowed Outline collection. The collection is resolved once, on first use.
 * A collection ID is used directly. A name or URL is resolved with `collections.list`, which needs `collections:read`.
 */
export class OutlineReader {
 private base:URL;private token:string;private reference:string;private collection?:Promise<string>;
 constructor(store:Store,config:Config,private fetcher:typeof fetch=fetch){
  const c=config.connections.Outline;
  this.base=serviceBase(c.endpoint);this.token=store.readCredential('Outline');this.reference=c.scope;
 }
 private call(method:string,body:unknown){return boundedJSON(this.fetcher,new URL('api/'+method,this.base),{Authorization:'Bearer '+this.token},body);}
 private link(path?:string){return path?new URL(path.replace(/^\/+/,''),this.base).href:undefined;}
 /** Returns the ID of the allowed collection. Fails when no visible collection matches the configured reference. */
 collectionId(){
  this.collection??=(async()=>{
   const {ref,urlId}=outlineCollectionRef(this.reference);
   if(uuid.test(ref))return ref;
   for(let offset=0;offset<1000;offset+=100){
    const page=collectionList.parse(await this.call('collections.list',{limit:100,offset}));
    const found=page.data.find(c=>c.id===ref||(!!urlId&&c.urlId===urlId)||c.name.toLowerCase()===ref.toLowerCase());
    if(found)return found.id;
    if(page.data.length<100)break;
   }
   throw new AppError(400,'The allowed Outline collection was not found. Check Settings → Connections → Outline.');
  })();
  return this.collection;
 }
 /** Searches documents of the allowed collection. Returns at most 10 results with a short context. */
 async search(input:unknown){
  const {query}=z.object({query:z.string().trim().min(1).max(200)}).strict().parse(input);
  const collectionId=await this.collectionId();
  const result=searchResult.parse(await this.call('documents.search',{query,collectionId,limit:10}));
  return {results:result.data.filter(r=>!r.document.collectionId||r.document.collectionId===collectionId).map(r=>({id:r.document.id,title:r.document.title,url:this.link(r.document.url),updatedAt:r.document.updatedAt,context:r.context?.replace(/<\/?b>/g,'').slice(0,500)}))};
 }
 /** Reads one document of the allowed collection, as Markdown. Fails for a document outside that collection. */
 async read(input:unknown){
  const {id}=z.object({id:z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9-]+$/)}).strict().parse(input);
  const collectionId=await this.collectionId();
  const {data}=documentInfo.parse(await this.call('documents.info',{id}));
  if(data.collectionId!==collectionId)throw new AppError(403,'The document is outside the allowed Outline collection.');
  const text=data.text??'';
  return {id:data.id,title:data.title,url:this.link(data.url),updatedAt:data.updatedAt,text:text.slice(0,outlineTextLimit),truncated:text.length>outlineTextLimit};
 }
}

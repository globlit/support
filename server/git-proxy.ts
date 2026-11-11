import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import type {Store} from './store.js';
import {serviceBase} from './gitlab.js';

const project=/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)+$/;
const route=/^\/([A-Za-z0-9_-]{32,64})\/(.+?)\.git\/(info\/refs|git-upload-pack)$/;
/**
 * Request headers passed to GitLab. Accept-Encoding is not passed: fetch negotiates compression itself and returns a
 * decompressed body, so the client must receive an uncompressed response without a Content-Encoding header.
 * Content-Encoding is passed because it describes the request body, which is forwarded unchanged.
 */
const forwarded=['content-type','content-encoding','git-protocol','accept'];

/**
 * Read-only Git HTTP proxy for sandbox commands. Forwards `git clone` and `git fetch` (upload-pack) to GitLab with the
 * GitLab token from the Vault, so that the sandbox never receives the token. Each URL contains a run token that is
 * valid until `release`. Pushes (receive-pack) and every other path are refused with 403.
 */
export class GitProxy {
 private tokens=new Set<string>();private server?:Server;private address?:string;private port?:number;
 constructor(private store:Store,private fetcher:typeof fetch=fetch){}
 /** True when the proxy listens. */
 get listening(){return !!this.port;}
 /** Starts listening on `address`. Resolves with the bound port. */
 listen(address:string,port=7071){
  return new Promise<number>((resolve,reject)=>{
   const server=createServer((req,res)=>void this.handle(req,res));
   server.once('error',reject);
   server.listen(port,address,()=>{this.server=server;this.address=address;this.port=(server.address() as {port:number}).port;resolve(this.port);});
  });
 }
 close(){this.server?.close();this.server=undefined;this.port=undefined;}
 /** Creates a run token. Clone URLs that contain it work until `release`. */
 register(){const token=randomBytes(24).toString('hex');this.tokens.add(token);return token;}
 release(token:string){this.tokens.delete(token);}
 /** Returns the clone URL of a GitLab project for sandbox commands. */
 url(token:string,path:string){if(!this.port)throw new Error('The Git proxy is not listening.');return `http://${this.address}:${this.port}/${token}/${path}.git`;}
 private async handle(req:IncomingMessage,res:ServerResponse){
  const deny=(status:number,text:string)=>{res.writeHead(status,{'Content-Type':'text/plain'});res.end(text+'\n');};
  try{
   const url=new URL(req.url??'/','http://proxy'),m=url.pathname.match(route);
   if(!m||!this.tokens.has(m[1]))return deny(403,'Unknown or expired clone URL. Use repo_checkout again.');
   const [,,path,action]=m;
   if(!project.test(path)||path.split('/').some(s=>s==='.'||s==='..'))return deny(400,'Invalid project path.');
   const read=action==='info/refs'?req.method==='GET'&&url.searchParams.get('service')==='git-upload-pack':req.method==='POST';
   if(!read)return deny(403,'Only clone and fetch are allowed. Pushes go through propose_change and engineer approval.');
   const config=this.store.snapshot().config.connections.GitLab;
   if(!config.enabled||!config.endpoint)return deny(503,'GitLab is not enabled in Settings.');
   const target=new URL(`${path}.git/${action}${action==='info/refs'?'?service=git-upload-pack':''}`,serviceBase(config.endpoint));
   const headers:Record<string,string>={Authorization:'Basic '+Buffer.from('oauth2:'+this.store.readCredential('GitLab')).toString('base64'),'User-Agent':'git/support-proxy'};
   for(const h of forwarded){const v=req.headers[h];if(typeof v==='string')headers[h]=v;}
   const upstream=await this.fetcher(target,{method:req.method,headers,redirect:'manual',...(req.method==='POST'?{body:Readable.toWeb(req) as ReadableStream,duplex:'half'}:{})} as RequestInit);
   if(upstream.status===401||upstream.status===403||upstream.status===404||(upstream.status>=300&&upstream.status<400)){await upstream.body?.cancel();return deny(upstream.status===404?404:403,`GitLab refused access to ${path} (HTTP ${upstream.status}).`);}
   const out:Record<string,string>={};for(const h of ['content-type','cache-control'])if(upstream.headers.get(h))out[h]=upstream.headers.get(h)!;
   res.writeHead(upstream.status,out);
   if(upstream.body)for await(const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>)if(!res.write(chunk))await new Promise(r=>res.once('drain',r));
   res.end();
  }catch{if(!res.headersSent)deny(502,'The Git proxy could not reach GitLab.');else res.destroy();}
 }
}

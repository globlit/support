import {createServer,request,type IncomingMessage} from 'node:http';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {createHash,createHmac} from 'node:crypto';

export const boundaryCSP="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin allow-forms allow-downloads";
export type GatewayOptions={port:number;guestPort:number;socketPath:string;publicDirectory:string;proofKey:Buffer;healthy:()=>boolean;timeoutMs?:number;connectionId?:string};
const maxBody=262144,maxResponse=4*1024*1024;
async function collect(stream:AsyncIterable<Buffer|string>,limit:number){let length=0;const chunks:Buffer[]=[];for await(const data of stream){const b=Buffer.from(data);length+=b.length;if(length>limit)throw Error('Size limit exceeded');chunks.push(b);}return Buffer.concat(chunks);}
function jsonData(data:Buffer){const parsed:unknown=JSON.parse(data.toString('utf8'));const todo:{value:unknown;depth:number}[]=[{value:parsed,depth:0}];while(todo.length){const {value,depth}=todo.pop()!;if(depth>64)throw Error('Response nesting limit exceeded');if(value&&typeof value==='object')for(const child of Object.values(value))todo.push({value:child,depth:depth+1});}return JSON.stringify(parsed);}
export async function loadAssets(root:string){
 const canonical=await realpath(root);if(canonical!==resolve(root))throw Error('Host UI directory cannot be a symlink.');
 const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')) as Record<string,string>;
 const assets=new Map<string,{bytes:Buffer;type:string}>();let total=0;
 for(const [path,hash] of Object.entries(manifest)){
  if(!/^\/(index\.html|assets\/[a-zA-Z0-9_.-]+|downloads\/[a-zA-Z0-9_.-]+)$/.test(path)||!/^[a-f0-9]{64}$/.test(hash))throw Error('Invalid host UI manifest.');
  const file=join(root,path);if(await realpath(file)!==file||(await lstat(file)).isSymbolicLink())throw Error('Host UI files cannot be symlinks.');
  const stat=await lstat(file);if(!stat.isFile()||stat.size>16*1024*1024||total+stat.size>32*1024*1024)throw Error('Host UI exceeds size limit.');
  let bytes=await readFile(file);total+=bytes.length;if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('Host UI integrity check failed.');
  if(path==='/index.html')bytes=Buffer.from(bytes.toString().replace('<head>','<head><meta name="support-host-boundary" content="isolated">'));
  const type:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.zip':'application/zip'};
  assets.set(path,{bytes,type:type[extname(file)]??'application/octet-stream'});
 }
 if(!assets.has('/index.html'))throw Error('Missing host UI.');
 return assets;
}
export async function createGateway(options:GatewayOptions){
 if(options.connectionId!==undefined&&!/^[a-f0-9]{32}$/.test(options.connectionId))throw Error('Invalid VM connection identity.');
 const assets=await loadAssets(options.publicDirectory),origin=`http://127.0.0.1:${options.port}`,guestOrigin=`http://127.0.0.1:${options.guestPort}`,cookieName=`support_session_${options.guestPort}`,browserCookieName=`support_session_${options.port}${options.connectionId?'_'+options.connectionId:''}`;
 let active=0;
 const server=createServer({maxHeaderSize:16384,headersTimeout:10000,requestTimeout:30000,keepAliveTimeout:5000},async(req,res)=>{
  const headers={'Cache-Control':'no-store','Content-Security-Policy':boundaryCSP,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Opener-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=(), usb=(), serial=(), local-network-access=()'};
  for(const [key,value] of Object.entries(headers))res.setHeader(key,value);
  const error=(status:number,message:string)=>{if(!res.headersSent)res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:message}));};
  let counted=false;
  try{
   if(req.headers.host!==new URL(origin).host) return error(403,'Use the Support loopback address.');
   if(req.headers.origin&&req.headers.origin!==origin||['cross-site','same-site'].includes(String(req.headers['sec-fetch-site']??'')))return error(403,'Cross-origin access denied.');
   const method=req.method??'GET',raw=req.url??'';
   if(!raw.startsWith('/')||raw.startsWith('//')||raw.length>8192||/[\\\x00-\x20\x7f]/.test(raw))return error(400,'Invalid path.');
   const url=new URL(raw,origin),path=url.pathname;
   if(!['GET','HEAD','POST','PUT','DELETE'].includes(method))return error(405,'Method not allowed.');
   if(!['GET','HEAD'].includes(method)&&req.headers.origin!==origin)return error(403,'Invalid request origin.');
   if(!options.healthy())return error(503,'VM boundary is unavailable. The host gateway is closed.');
   if(path==='/__support/host'&&method==='GET'){
    const nonce=url.searchParams.get('nonce')??'';if(!/^[a-f0-9]{64}$/.test(nonce))return error(400,'Invalid challenge.');
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(options.connectionId?{version:2,connectionId:options.connectionId,proof:createHmac('sha256',options.proofKey).update(nonce+'\n'+options.connectionId).digest('hex')}:{version:1,proof:createHmac('sha256',options.proofKey).update(nonce).digest('hex')}));return;
   }
   const callback=path==='/auth/chatgpt/callback'&&method==='GET';
   if(!path.startsWith('/api/')&&!callback){
    if(!['GET','HEAD'].includes(method))return error(405,'Method not allowed.');
    const asset=assets.get(path==='/'?'/index.html':path);if(!asset)return error(404,'Not found.');
    res.writeHead(200,{'Content-Type':asset.type,...(path.endsWith('.zip')?{'Content-Disposition':'attachment'}:{})});res.end(method==='HEAD'?undefined:asset.bytes);return;
   }
   if(!callback&&!/^\/api\/[A-Za-z0-9_/-]+$/.test(path))return error(400,'Invalid API path.');
   if(method==='HEAD')return error(405,'Method not allowed.');
   // Browser navigation must never display guest API documents or interpret guest HTML.
   if(!callback&&req.headers['sec-fetch-mode']==='navigate')return error(403,'API navigation is disabled.');
   if(active>=4)return error(503,'Too many active requests.');active++;counted=true;
   let body:Buffer|undefined;
   if(!['GET','HEAD'].includes(method)){
    body=await collect(req,maxBody);if(body.length){if(req.headers['content-type']!=='application/json')return error(415,'JSON required.');JSON.parse(body.toString());}else body=undefined;
   }
   const forwarded:Record<string,string>={Host:new URL(guestOrigin).host,Origin:guestOrigin,Accept:'application/json','Accept-Encoding':'identity'};
   const cookie=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(browserCookieName+'='));
   if(cookie.length>1)return error(403,'Ambiguous session.');
   const value=cookie[0]?.slice(browserCookieName.length+1);if(value&&/^[A-Za-z0-9_-]{43}$/.test(value))forwarded.Cookie=cookieName+'='+value;
   const csrf=req.headers['x-support-csrf'];if(typeof csrf==='string'&&/^[A-Za-z0-9_-]{43}$/.test(csrf))forwarded['X-Support-CSRF']=csrf;
   if(path.startsWith('/api/companion/')){if(options.connectionId&&req.headers['x-support-vm']!==options.connectionId)return error(409,'This notification pairing belongs to a different VM. Pair with this workspace first.');const auth=req.headers.authorization;if(auth&&/^Bearer [A-Za-z0-9_-]{43}$/.test(auth))forwarded.Authorization=auth;}
   if(body){forwarded['Content-Type']='application/json';forwarded['Content-Length']=String(body.length);}
   const result=await new Promise<{status:number;body:Buffer;cookies:string[];location?:string}>((resolve,reject)=>{
    const upstream=request({socketPath:options.socketPath,path:path+url.search,method,headers:forwarded,agent:false},async response=>{
     try{
      if(!callback&&!/^application\/json(?:;|$)/i.test(response.headers['content-type']??''))throw Error('Non-JSON guest response');
      const bytes=await collect(response,maxResponse);resolve({status:response.statusCode??502,body:bytes,cookies:response.headers['set-cookie']??[],location:response.headers.location});
     }catch(e){response.destroy();reject(e);}
    });
    const timer=setTimeout(()=>upstream.destroy(Error('Guest response deadline exceeded')),options.timeoutMs??120000);timer.unref();
    upstream.once('close',()=>clearTimeout(timer));upstream.once('error',reject);
    res.once('close',()=>{if(!res.writableEnded)upstream.destroy(Error('Client disconnected'));});
    upstream.end(body);
   });
   if(!options.healthy())return error(503,'VM boundary changed during the request.');
   if(callback){res.writeHead(303,{Location:result.status===303&&result.location==='/#/auth?result=success'?'/#/auth?result=success':'/#/auth?result=error'});res.end();return;}
   if(result.status<200||result.status>=300&&result.status<400||result.status>599)return error(502,'Unexpected guest response.');
   const data=jsonData(result.body);
   // Reconstruct our single session cookie; never forward guest headers, cache policies,
   // redirects, service-worker scope, CORS, CSP, alternate protocols or other cookies.
   if(['/api/vault','/api/session/logout'].includes(path))for(const c of result.cookies){
    const match=c.match(new RegExp('^'+cookieName+'=([A-Za-z0-9_-]{43}|);.*Max-Age=(\\d+)(?:;|$)'));
    if(match&&Number(match[2])<=43200)res.setHeader('Set-Cookie',`${browserCookieName}=${match[1]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Number(match[2])}`);
   }
   res.writeHead(result.status,{'Content-Type':'application/json; charset=utf-8'});res.end(data);
  }catch{return error(502,'The VM returned an invalid or unavailable response.');}
  finally{if(counted)active--;}
 });
 server.on('connect',(_req,socket)=>socket.destroy());server.on('upgrade',(_req,socket)=>socket.destroy());
 return server;
}

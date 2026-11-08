import {isIP} from 'node:net';
export type Deployment={mode:'local'|'container';port:number;bindHost:string;publicOrigin:string;host:string;sessionSeconds:number;cookieName:string};
/** Deployment authority belongs to the operator, never editable tool/model settings. */
export function deployment(env:NodeJS.ProcessEnv=process.env):Deployment{
 const mode=env.SUPPORT_DEPLOYMENT??'local';
 if(mode!=='local'&&mode!=='container')throw new Error('SUPPORT_DEPLOYMENT must be local or container. Hosted deployment is disabled until OIDC and runner isolation are implemented.');
 const port=Number(env.SUPPORT_PORT??4173);
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('SUPPORT_PORT must be an integer between 1024 and 65535.');
 const bindHost=env.SUPPORT_BIND_HOST??'127.0.0.1';
 if(!isIP(bindHost)||!['127.0.0.1','::1','0.0.0.0','::'].includes(bindHost))throw new Error('Unsupported SUPPORT_BIND_HOST.');
 if(mode==='local'&&!['127.0.0.1','::1'].includes(bindHost))throw new Error('Local mode must bind to loopback. Container mode requires explicit loopback publishing on the VM.');
 if(mode==='container'&&!env.SUPPORT_PUBLIC_ORIGIN)throw new Error('Container mode requires SUPPORT_PUBLIC_ORIGIN, the Mac loopback URL.');
 const value=env.SUPPORT_PUBLIC_ORIGIN??`http://${bindHost==='::1'?'[::1]':'127.0.0.1'}:${port}`;
 let url:URL;try{url=new URL(value)}catch{throw new Error('Invalid SUPPORT_PUBLIC_ORIGIN.');}
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||value.replace(/\/$/,'')!==url.origin)throw new Error('This release supports literal loopback HTTP origins only. Remote/hosted origins remain disabled.');
 if(mode==='local'&&Number(url.port||80)!==port)throw new Error('Local origin port must match SUPPORT_PORT. Use container mode for explicit port mapping.');
 if(env.SUPPORT_TRUST_PROXY)throw new Error('Proxy-header trust is not supported. Host and Origin must match SUPPORT_PUBLIC_ORIGIN; forwarded headers never establish identity.');
 const sessionSeconds=Number(env.SUPPORT_SESSION_SECONDS??43200);
 if(!Number.isInteger(sessionSeconds)||sessionSeconds<300||sessionSeconds>43200)throw new Error('Session lifetime must be 300–43200 seconds.');
 return {mode,port,bindHost,publicOrigin:url.origin,host:url.host,sessionSeconds,cookieName:'support_session_'+(url.port||80)};
}

import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {AppError,type Store} from './store.js';
import {localOwner,type Principal} from './identity.js';
import type {Deployment} from './deployment.js';
const token=()=>randomBytes(32).toString('base64url');
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
type Session={principal:Principal;csrf:string;expires:number;epoch:number};
/** Session secrets are never persisted. */
export class Sessions{
 private entries=new Map<string,Session>();
 constructor(private store:Store,private config:Deployment,private clock=Date.now){}
 private cookie(req:IncomingMessage){const values=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(this.config.cookieName+'='));return values.length===1?values[0].slice(this.config.cookieName.length+1):'';}
 private prune(){for(const [id,s] of this.entries)if(this.clock()>=s.expires||s.epoch!==this.store.vaultEpoch||!this.store.key)this.entries.delete(id);}
 current(req:IncomingMessage){this.prune();const value=this.cookie(req);return /^[A-Za-z0-9_-]{43}$/.test(value)?this.entries.get(digest(value)):undefined;}
 valid(session:Session){this.prune();return !!this.store.key&&session.epoch===this.store.vaultEpoch&&this.clock()<session.expires&&[...this.entries.values()].includes(session);}
 require(req:IncomingMessage){const s=this.current(req);if(!s)throw new AppError(401,'Unlock the Vault to sign in to this browser.','SESSION_REQUIRED');if(!['GET','HEAD'].includes(req.method??'')){const csrf=req.headers['x-support-csrf'];if(typeof csrf!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(csrf)||!timingSafeEqual(Buffer.from(csrf),Buffer.from(s.csrf)))throw new AppError(403,'Session verification failed. Refresh Support and try again.');}return s;}
 issue(req:IncomingMessage,res:ServerResponse){this.prune();this.entries.delete(digest(this.cookie(req)));while(this.entries.size>=16)this.entries.delete(this.entries.keys().next().value!);const value=token(),s:Session={principal:localOwner(this.store),csrf:token(),expires:this.clock()+this.config.sessionSeconds*1000,epoch:this.store.vaultEpoch};this.entries.set(digest(value),s);res.setHeader('Set-Cookie',`${this.config.cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${this.config.sessionSeconds}`);return s;}
 logout(req:IncomingMessage,res:ServerResponse){this.entries.delete(digest(this.cookie(req)));res.setHeader('Set-Cookie',`${this.config.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);}
 clear(){this.entries.clear();}
 status(req:IncomingMessage){const s=this.current(req);return {authenticated:!!s,initialized:this.store.vaultStatus().initialized,...(s?{principal:s.principal,csrf:s.csrf,expiresAt:s.expires,deployment:{mode:this.config.mode,publicOrigin:this.config.publicOrigin}}:{})};}
}

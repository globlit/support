import {loggedFetch} from './diagnostics.js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify,type JWTPayload,type JWTVerifyGetKey} from 'jose';
import {z} from 'zod';
import {Store,AppError} from './store.js';
import {boundedJSON} from './gitlab.js';
const issuer='https://auth.openai.com',resource='https://api.openai.com/v1';
const jwks=createRemoteJWKSet(new URL(issuer+'/.well-known/jwks.json'),{timeoutDuration:10000});
export async function verifyIdentity(token:string,client:string,nonce?:string,keys:JWTVerifyGetKey=jwks){const {payload}=await jwtVerify(token,keys,{issuer,audience:client,algorithms:['RS256'],requiredClaims:['exp','iat','sub']});if(nonce&&payload.nonce!==nonce)throw new AppError(400,'Sign-in nonce did not match.');if(payload.azp&&payload.azp!==client)throw new AppError(400,'Sign-in audience did not match.');return payload;}
const tokenSchema=z.object({access_token:z.string().min(1),refresh_token:z.string().min(1).optional(),id_token:z.string().min(1).optional(),token_type:z.string().refine(t=>t.toLowerCase()==='bearer'),expires_in:z.number().positive().max(604800),scope:z.string().optional()});
type Account={client:string;subject:string;email:string;tokens?:{access:string;refresh:string;identity:string;expires:number;scopes:string[]}};
type Data={active?:string;accounts:Account[]};
type Pending={state:string;nonce:string;verifier:string;client?:string;subject?:string;redirect:string;epoch:number;revision:number;expires:number};
export class ChatGPT{
 private pending?:Pending;private refreshing=new Map<string,Promise<string>>();private lastMessage='';
 constructor(private store:Store,private fetcher:typeof fetch=fetch,private verify:(t:string,c:string,n?:string)=>Promise<JWTPayload>=verifyIdentity){}
 private data():Data{if(!this.store.key)throw new AppError(423,'Unlock the Vault first.');if(!this.store.vaultStatus().credentials.includes('ChatGPT'))return {accounts:[]};return JSON.parse(this.store.readCredential('ChatGPT')) as Data;}
 private save(data:Data,rotation=false){if(!this.store.key)throw new AppError(423,'Unlock the Vault first.');this.store.db.prepare('INSERT OR REPLACE INTO secrets VALUES (?,?)').run('ChatGPT',this.store.encrypt(JSON.stringify(data),this.store.key));if(!rotation){this.store.credentialEpoch++;const s=this.store.snapshot();this.store.config(s.config,s.configRevision);}}
 status(){if(!this.store.key)return {locked:true,accounts:[],message:'Unlock the Vault to manage ChatGPT sign-in.'};const d=this.data();return {locked:false,revision:this.store.snapshot().configRevision,active:d.active,accounts:d.accounts.map(a=>({id:a.client,label:(a.email||'ChatGPT account')+' · '+a.client.slice(-8),connected:!!a.tokens,planEnabled:!!a.tokens?.scopes.includes('chatgpt.tokens.use.direct')})),pending:!!this.pending&&this.pending.expires>Date.now(),message:this.lastMessage};}
 begin(origin:string,client?:string){const d=this.data(),account=client?d.accounts.find(a=>a.client===client):undefined;if(client&&!account)throw new AppError(404,'Saved account not found.');let host=this.store.get<string>('chatgptHost');if(!host){host='urn:uuid:'+randomUUID();this.store.put('chatgptHost',host);}const p:Pending={state:randomBytes(32).toString('base64url'),nonce:randomBytes(32).toString('base64url'),verifier:randomBytes(48).toString('base64url'),client:account?.client,subject:account?.subject,redirect:origin+'/auth/chatgpt/callback',epoch:this.store.credentialEpoch,revision:this.store.snapshot().configRevision,expires:Date.now()+600000};this.pending=p;
 const u=new URL(issuer+'/api/accounts/authorize');const params={client_id:account?.client??'dynamic_agent_client',ext_agent_host_id:host,response_type:'code',redirect_uri:p.redirect,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource,state:p.state,nonce:p.nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(p.verifier).digest('base64url'),...(account?{}:{agent_name_hint:'Support'})};for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);this.lastMessage='Complete sign-in in the OpenAI browser window.';return {url:u.href};}
 failure(){this.lastMessage='Sign-in failed. Keep the Vault unlocked and settings unchanged, then try again.';}
 cancel(){this.pending=undefined;this.lastMessage='Sign-in cancelled.';return this.status();}
 private guard(p:Pick<Pending,'epoch'|'revision'>){if(!this.store.key||p.epoch!==this.store.credentialEpoch||p.revision!==this.store.snapshot().configRevision)throw new AppError(409,'Vault or settings changed. Sign in again.');}
 private async exchange(fields:Record<string,string>){let r:Response;try{r=await this.fetcher(issuer+'/api/accounts/oauth/token',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams(fields),signal:AbortSignal.timeout(20000)});}catch{throw new AppError(502,'ChatGPT token exchange was interrupted. Sign in again; no automatic retry was made.');}if(!r.ok){const raw=await readLimited(r,10000).catch(()=>'');let code='';try{const value=JSON.parse(raw);code=typeof value.error==='string'?value.error:value.error?.code??'';}catch{}const invalid=r.status===401||['invalid_grant','invalid_client'].includes(code);throw new AppError(invalid?401:502,invalid?'ChatGPT authentication expired or was revoked. Sign in again.':'ChatGPT authentication is temporarily unavailable. Your saved account has been kept.');}const bytes=await readLimited(r,100000);return tokenSchema.parse(JSON.parse(bytes));}
 async callback(params:URLSearchParams){const p=this.pending;if(!p||p.expires<Date.now()||params.getAll('state').length!==1||params.get('state')!==p.state)throw new AppError(400,'Sign-in expired or state did not match. Start again.');this.pending=undefined;this.guard(p);if(params.has('error')){this.lastMessage='ChatGPT sign-in was declined or cancelled.';throw new AppError(400,this.lastMessage);}const code=params.get('code'),client=params.get('client_id')??p.client;if(!code||params.getAll('code').length!==1||params.getAll('client_id').length>1||!client||!/^oaiapp_[A-Za-z0-9_-]+$/.test(client)||(p.client&&client!==p.client))throw new AppError(400,'Invalid ChatGPT registration callback.');
 const t=await this.exchange({grant_type:'authorization_code',client_id:client,code,code_verifier:p.verifier,redirect_uri:p.redirect,resource});this.guard(p);if(!t.id_token||!t.refresh_token||!t.scope)throw new AppError(502,'Incomplete ChatGPT sign-in response.');const identity=await this.verify(t.id_token,client,p.nonce);this.guard(p);if(!identity.sub||(p.subject&&identity.sub!==p.subject))throw new AppError(400,'The signed-in account differs from the selected account.');const d=this.data(),old=d.accounts.find(a=>a.client===client);if(old&&old.subject!==identity.sub)throw new AppError(400,'Account identity mismatch.');const a:Account={client,subject:identity.sub,email:typeof identity.email==='string'?identity.email:'',tokens:{access:t.access_token,refresh:t.refresh_token,identity:t.id_token,expires:Date.now()+t.expires_in*1000,scopes:t.scope.split(/\s+/)}};d.accounts=d.accounts.filter(x=>x.client!==client);d.accounts.push(a);d.active=client;this.save(d);this.lastMessage=a.tokens!.scopes.includes('chatgpt.tokens.use.direct')?'Signed in. Load models and select one in Model settings.':'Signed in, but ChatGPT plan usage was not granted. Reauthorize to enable it.';return this.status();}
 select(client:string){const d=this.data();if(d.active===client)return this.status();if(!d.accounts.some(a=>a.client===client))throw new AppError(404,'Account not found.');d.active=client;this.pending=undefined;this.save(d);return this.status();}
 async access(){
  const d=this.data(),a=d.accounts.find(x=>x.client===d.active);
  if(!a?.tokens)throw new AppError(401,'Continue with ChatGPT in Settings → Model first.');
  if(!a.tokens.scopes.includes('chatgpt.tokens.use.direct'))throw new AppError(403,'This account has not granted ChatGPT plan usage. Sign in again to grant it.');
  if(a.tokens.expires>Date.now()+60000)return a.tokens.access;
  const key=a.client+':'+a.tokens.refresh;let pending=this.refreshing.get(key);
  if(!pending){pending=this.refresh(a);this.refreshing.set(key,pending);}
  try{const token=await pending;if(this.data().active!==a.client)throw new AppError(409,'Selected account changed. Try again with the selected account.');return token;}
  finally{if(this.refreshing.get(key)===pending)this.refreshing.delete(key);}
 }
 private async refresh(a:Account){
  const vaultEpoch=this.store.vaultEpoch,refreshToken=a.tokens!.refresh;
  const current=()=>{
   if(!this.store.key||vaultEpoch!==this.store.vaultEpoch)throw new AppError(409,'Vault changed during token refresh. Sign in again if required.');
   const d=this.data(),saved=d.accounts.find(x=>x.client===a.client);
   if(!saved?.tokens||saved.tokens.refresh!==refreshToken)throw new AppError(409,'Account changed during token refresh.');
   return d;
  };
  try{
   const t=await this.exchange({grant_type:'refresh_token',client_id:a.client,refresh_token:refreshToken,resource});current();
   if(t.id_token){const identity=await this.verify(t.id_token,a.client);current();if(identity.sub!==a.subject)throw new AppError(401,'Refreshed identity differs. Sign in again.');}
   const d=current(),scopes=t.scope?.split(/\s+/)??a.tokens!.scopes;
   const next={...a,tokens:{access:t.access_token,refresh:t.refresh_token??refreshToken,identity:t.id_token??a.tokens!.identity,expires:Date.now()+t.expires_in*1000,scopes}};
   d.accounts=d.accounts.map(x=>x.client===a.client?next:x);this.save(d,true);
   if(!scopes.includes('chatgpt.tokens.use.direct')){this.invalidate();throw new AppError(403,'ChatGPT plan permission is no longer granted.');}
   this.lastMessage='Account session refreshed.';return t.access_token;
  }catch(e){
   // A network failure is not a sign-out.
   if(e instanceof AppError&&e.status===401){try{const d=current();d.accounts=d.accounts.map(x=>x.client===a.client?{...x,tokens:undefined}:x);this.save(d);this.lastMessage='ChatGPT requires sign-in again. Your registration is retained.';}catch{/* Vault or account already changed. */}}
   throw e;
  }
 }
 private invalidate(){const s=this.store.snapshot();this.store.credentialEpoch++;this.store.config(s.config,s.configRevision);}
 async models(){const epoch=this.store.credentialEpoch,revision=this.store.snapshot().configRevision;const token=await this.access();const raw=await boundedJSON(this.fetcher,new URL(resource+'/models'),{Authorization:'Bearer '+token});this.guard({epoch,revision});return z.object({models:z.array(z.object({slug:z.string(),display_name:z.string(),visibility:z.string()})).max(500)}).parse(raw).models.filter(m=>m.visibility==='list').map(m=>({id:m.slug,name:m.display_name}));}
 async disconnect(client:string){const d=this.data(),a=d.accounts.find(x=>x.client===client);if(!a)throw new AppError(404,'Account not found.');this.pending=undefined;const refresh=a.tokens?.refresh;a.tokens=undefined;this.save(d);const epoch=this.store.credentialEpoch;let revoked=!refresh;
 if(refresh)try{const discovery=z.object({revocation_endpoint:z.string().url()}).parse(await boundedJSON(this.fetcher,new URL(issuer+'/.well-known/openid-configuration'),{}));const endpoint=new URL(discovery.revocation_endpoint);if(endpoint.origin!==issuer)throw new Error();const r=await this.fetcher(endpoint,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:refresh,token_type_hint:'refresh_token',client_id:client}),signal:AbortSignal.timeout(15000)});revoked=r.status===200;await r.body?.cancel();}catch{/* Local sign-out is already complete. */}
 if(epoch===this.store.credentialEpoch)this.lastMessage=revoked?'Signed out. Registration retained for future sign-in.':'Signed out locally. Remote revocation was not confirmed; disconnect Support in ChatGPT Settings → Usage.';return this.status();}
}
export async function readLimited(r:Response,max:number){if(!r.body)throw new AppError(502,'Empty provider response.');const chunks:Uint8Array[]=[];let n=0;for await(const c of r.body as unknown as AsyncIterable<Uint8Array>){n+=c.length;if(n>max)throw new AppError(502,'Provider response too large.');chunks.push(c);}return Buffer.concat(chunks).toString();}
const instances=new WeakMap<Store,ChatGPT>();export function chatGPT(store:Store){let c=instances.get(store);if(!c){c=new ChatGPT(store,loggedFetch(store));instances.set(store,c)}return c;}

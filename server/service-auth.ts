import {z} from 'zod';
import type {Store} from './store.js';
import {connectionNames,kubernetesContextName,prometheusCredential} from '../src/model.js';

export const serviceAuthConnections=['Alertmanager','Prometheus','Grafana'] as const;
export type ServiceAuthConnection=typeof serviceAuthConnections[number];
export type ServiceAuthScheme='bearer'|'basic';

const noControl=(v:string)=>!/[\x00-\x1f\x7f]/.test(v);
export const basicCredentialSchema=z.object({
 username:z.string().min(1).max(256).refine(noControl,'Username must not contain control characters.').refine(v=>!v.includes(':'),'Username must not contain ":".'),
 password:z.string().min(1).max(1024).refine(noControl,'Password must not contain control characters.'),
}).strict();
const storedSchema=z.discriminatedUnion('scheme',[
 z.object({v:z.literal(1),scheme:z.literal('bearer'),token:z.string().min(1)}).strict(),
 z.object({v:z.literal(1),scheme:z.literal('basic'),username:z.string().min(1),password:z.string().min(1)}).strict(),
]);
export type ServiceAuth=z.infer<typeof storedSchema>;

export const isServiceAuthConnection=(name:string):name is ServiceAuthConnection=>(serviceAuthConnections as readonly string[]).includes(name);

/** Returns the stored value for a bearer token. */
export function bearerCredential(token:string){return JSON.stringify({v:1,scheme:'bearer',token});}
/** Returns the stored value for Basic auth. Throws a ZodError on invalid input. */
export function basicCredential(input:unknown){const {username,password}=basicCredentialSchema.parse(input);return JSON.stringify({v:1,scheme:'basic',username,password});}

/** Parses a stored credential. A non-JSON value is a legacy bearer token. */
export function parseServiceAuth(raw:string):ServiceAuth{
 if(raw.startsWith('{')){try{const parsed=storedSchema.safeParse(JSON.parse(raw));if(parsed.success)return parsed.data;}catch{}}
 return {v:1,scheme:'bearer',token:raw};
}

/** Returns the Authorization header for a credential. */
export function authorizationHeader(auth:ServiceAuth){
 return auth.scheme==='bearer'?'Bearer '+auth.token:'Basic '+Buffer.from(auth.username+':'+auth.password,'utf8').toString('base64');
}

/** Returns request headers for a connection. Throws if a credential is saved and the Vault is locked. */
export function serviceAuthHeaders(store:Store,name:ServiceAuthConnection):Record<string,string>{
 if(!store.vaultStatus().credentials.includes(name))return {};
 return {Authorization:authorizationHeader(parseServiceAuth(store.readCredential(name)))};
}

/** Returns request headers for a Prometheus server. Empty when no credential is saved for it. */
export function serverAuthHeaders(store:Store,id:string):Record<string,string>{
 const name=prometheusCredential(id);
 if(!store.vaultStatus().credentials.includes(name))return {};
 return {Authorization:authorizationHeader(parseServiceAuth(store.readCredential(name)))};
}
/** Vault name of a Prometheus server credential: Prometheus/<id>. */
export const serverCredentialName=z.string().regex(/^Prometheus\/[a-z0-9]{1,16}$/);
/** Returns the values to redact for a stored credential. */
export function serviceAuthSecrets(raw:string){
 const auth=parseServiceAuth(raw);
 if(auth.scheme==='bearer')return [auth.token];
 const pair=auth.username+':'+auth.password;
 return [auth.password,pair,Buffer.from(pair,'utf8').toString('base64')];
}

/** Vault value of a Kubernetes context: bearer token, optional CA certificates (PEM), optional TLS verification skip. */
export const kubernetesSecretSchema=z.object({
 token:z.string().trim().min(1).max(16384).regex(/^[\x21-\x7e]+$/,'The token must not contain spaces or control characters.'),
 ca:z.string().max(262144).refine(v=>!v.trim()||v.includes('-----BEGIN CERTIFICATE-----'),'Use PEM certificates (-----BEGIN CERTIFICATE-----).').optional(),
 insecure:z.boolean().optional(),
}).strict();
export type KubernetesSecret=z.infer<typeof kubernetesSecretSchema>;
/** Vault name of a Kubernetes context credential: Kubernetes/<context>. */
export const kubernetesCredentialName=z.string().max(220).refine(v=>v.startsWith('Kubernetes/')&&kubernetesContextName.safeParse(v.slice(11)).success,'Unknown Kubernetes context.');
const serviceName=z.enum(serviceAuthConnections);
/** Connections whose saved credential can be removed without saving a replacement. */
export const removableCredentials=[...serviceAuthConnections,'Outline'] as const;
/** Request body of POST /api/credential. */
export const credentialInput=z.union([
 z.object({name:z.enum(connectionNames).exclude(['Kubernetes']),value:z.string().min(1).max(16384)}).strict(),
 z.object({name:serviceName,basic:basicCredentialSchema}).strict(),
 z.object({name:z.enum(removableCredentials),remove:z.literal(true)}).strict(),
 z.object({name:serverCredentialName,value:z.string().min(1).max(16384)}).strict(),
 z.object({name:serverCredentialName,basic:basicCredentialSchema}).strict(),
 z.object({name:serverCredentialName,remove:z.literal(true)}).strict(),
 z.object({name:kubernetesCredentialName,kubernetes:kubernetesSecretSchema}).strict(),
]);
/** Returns the value to store for a save request. */
export function storedCredential(v:Exclude<z.infer<typeof credentialInput>,{remove:true}|{kubernetes:unknown}>){
 if('basic' in v)return basicCredential(v.basic);
 return isServiceAuthConnection(v.name)||v.name.startsWith('Prometheus/')?bearerCredential(v.value):v.value;
}

import type {LogTool} from '../src/diagnostics-model.js';
import {handling} from './intake.js';
import {recordDiagnostic} from './diagnostics.js';
import Database from 'better-sqlite3-multiple-ciphers';
import { mkdirSync,chmodSync,existsSync,readFileSync,writeFileSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID,randomBytes,createCipheriv,createDecipheriv,scryptSync,hkdfSync } from 'node:crypto';
import { defaults,configSchema,type Config,type Snapshot,type SourceIssue,type WorkSession,type ChangeSet,type AlertCase,type AnalysisRun } from '../src/model.js';
import {isServiceAuthConnection,parseServiceAuth,serviceAuthSecrets,type ServiceAuthConnection,type ServiceAuthScheme} from './service-auth.js';
/** Statement of the database. Rows are untyped: callers cast them to the shape of their query. */
type Statement={run(...params:unknown[]):{changes:number|bigint};get(...params:unknown[]):any;all(...params:unknown[]):any[];iterate(...params:unknown[]):IterableIterator<any>};
type Sql={prepare(sql:string):Statement;exec(sql:string):unknown;pragma(sql:string):unknown};
export class AppError extends Error{constructor(public status:number,message:string,public code?:string){super(message)}}
/** Log category of an agent tool. */
export function toolCategory(tool:string):LogTool{return tool==='run_command'?'Sandbox':tool.startsWith('gitlab')?'GitLab':tool.startsWith('prom')?'Prometheus':tool.startsWith('grafana')?'Grafana':tool.startsWith('kube')?'Kubernetes':tool.startsWith('youtrack')?'YouTrack':tool.startsWith('outline')?'Outline':tool.startsWith('alertmanager')?'Alertmanager':'Model';}
export class Store{
 private workActive=false;
 private analyses=new Map<string,string>();
 canAnalyze(){return !this.workActive&&this.analyses.size<this.snapshot().config.maxRuns;}
 claimAnalysis(scope:string,id:string){if(!this.canAnalyze()||[...this.analyses.values()].includes(scope))throw new AppError(409,'Another analysis or change operation is running for this request, or all investigation slots are busy.');this.analyses.set(id,scope);return ()=>{this.analyses.delete(id)};}

 activeRunId:string|null=null;
 claimWork(){if(this.workActive||this.analyses.size)throw new AppError(409,'Another analysis or change operation is running.');this.workActive=true;return ()=>{this.workActive=false;this.activeRunId=null};}
 trackRun(kind:'changes'|'diagnosis',connection:string,issueId:string,model?:string){
  const run:AnalysisRun={id:randomUUID(),kind,connection,issueId,model,startedAt:new Date().toISOString(),state:'running',events:[]};
  this.activeRunId=run.id;this.saveInvestigation(run);
  return {
   event:(text:string)=>{run.events.push({at:new Date().toISOString(),text});this.saveInvestigation(run)},
   finish:(error?:string)=>{run.state=error?'failed':'ready';run.error=error;run.finishedAt=new Date().toISOString();this.saveInvestigation(run)},
  };
 }
 saveChange(c:ChangeSet){c.updatedAt=new Date().toISOString();this.db.prepare('INSERT OR REPLACE INTO changes VALUES (?,?)').run(c.id,JSON.stringify(c));}
 change(id:string):ChangeSet{const row=this.db.prepare('SELECT value FROM changes WHERE id=?').get(id) as {value:string}|undefined;if(!row)throw new AppError(404,'Change set not found.');return JSON.parse(row.value);}
 changes(connection:string,issueId:string):ChangeSet[]{return (this.db.prepare('SELECT value FROM changes ORDER BY rowid DESC').all() as {value:string}[]).map(r=>JSON.parse(r.value) as ChangeSet).filter(c=>c.connection===connection&&c.issueId===issueId);}
 alertCases():AlertCase[]{return (this.db.prepare('SELECT value FROM alert_cases').all() as {value:string}[]).map(r=>JSON.parse(r.value));}
 saveAlert(c:AlertCase){this.db.prepare('INSERT OR REPLACE INTO alert_cases VALUES (?,?)').run(c.id,JSON.stringify(c));}
 alert(id:string){const row=this.db.prepare('SELECT value FROM alert_cases WHERE id=?').get(id) as {value:string}|undefined;const c=row?JSON.parse(row.value) as AlertCase:undefined;if(!c)throw new AppError(404,'Alert case unavailable. Refresh the queue.');return c;}
 key:Buffer|null=null;credentialEpoch=0;vaultEpoch=0;
 private handle:Database|null=null;
 /** Path of the database file. */
 readonly file:string;private readonly vaultFile:string;
 /** Database of the unlocked Vault. Throws a 423 AppError while the Vault is locked. */
 get db():Sql{if(!this.handle)throw new AppError(423,'Unlock the Vault first.');return this.handle as unknown as Sql;}
 /**
  * Opens the data directory. A directory without a Vault holds a plaintext database of defaults only. Creating the Vault
  * encrypts that database with a key derived from the passphrase. Once a Vault exists, the database file is encrypted
  * and opens only in `unlock`. The salt and the passphrase check are in vault.json, which holds no secret.
  */
 constructor(dir:string){
  mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
  this.file=join(dir,'support.sqlite');this.vaultFile=join(dir,'vault.json');
  if(!existsSync(this.vaultFile)){this.handle=new Database(this.file);chmodSync(this.file,0o600);this.prepareDatabase();}
 }
 private openers:(()=>void)[]=[];
 /** Calls `setup` each time the database opens, and now if it is open. Modules use it to create tables and recover state. */
 onOpen(setup:()=>void){this.openers.push(setup);if(this.handle)setup();}
 /** Creates the tables, fails interrupted change preparations and seeds the configuration. Runs each time the database opens. */
 private prepareDatabase(){
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS ai_dispositions (kind TEXT NOT NULL, id TEXT NOT NULL, signature TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS investigation_attempts (scope TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS work_sessions (connection TEXT NOT NULL, issue_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(connection,issue_id)); CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS alert_cases (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS investigations (id TEXT PRIMARY KEY, connection TEXT NOT NULL, issue_id TEXT NOT NULL, started TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS diagnostics (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, at TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS model_usage (id TEXT PRIMARY KEY, at TEXT NOT NULL, provider TEXT NOT NULL, auth TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER, cache_write INTEGER, web_searches INTEGER NOT NULL DEFAULT 0, limits TEXT NOT NULL DEFAULT \'[]\'); CREATE INDEX IF NOT EXISTS model_usage_at ON model_usage(at); CREATE INDEX IF NOT EXISTS diagnostic_time ON diagnostics(at); CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, value TEXT NOT NULL);');for(const row of this.db.prepare('SELECT value FROM changes').all() as {value:string}[]){const c=JSON.parse(row.value) as ChangeSet;if(c.state==='generating'){c.state='failed';c.message='Preparation interrupted before any branch write. Start again.';this.saveChange(c);}}if(!this.get('config')){this.put('config',defaults);this.put('configRevision',1);}
 }
 get<T=unknown>(id:string):T|undefined{const row=this.db.prepare('SELECT value FROM state WHERE id=?').get(id) as {value:string}|undefined;return row?JSON.parse(row.value):undefined}
 put(id:string,value:unknown){this.db.prepare('INSERT OR REPLACE INTO state VALUES (?,?)').run(id,JSON.stringify(value))}
 private configCache?:{raw:string;config:Config};
 /** Returns the saved configuration. The parsed value is reused until the stored JSON changes. */
 private currentConfig():Config{const raw=(this.db.prepare('SELECT value FROM state WHERE id=?').get('config') as {value:string}|undefined)?.value??'null';if(this.configCache?.raw!==raw)this.configCache={raw,config:configSchema.parse(JSON.parse(raw))};return structuredClone(this.configCache.config);}
 snapshot():Snapshot{return {config:this.currentConfig(),configRevision:this.get<number>('configRevision')!,vault:this.vaultStatus(),runtime:{mode:'Live workspace',platform:process.platform,liveExecution:false}}}
 transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result}catch(e){this.db.exec('ROLLBACK');throw e}}
 config(config:unknown,expected:number){const next=configSchema.parse(config);this.transaction(()=>{if(this.get('configRevision')!==expected)throw new AppError(409,'Settings changed in another window. Reload before saving.');this.put('config',next);this.put('configRevision',expected+1);
  // Credentials of removed Prometheus servers and Kubernetes contexts are deleted with them.
  const kept=new Set([...next.prometheusSources.map(s=>'Prometheus/'+s.id),...next.kubernetesContexts.map(c=>'Kubernetes/'+c.name)]);for(const {id} of this.db.prepare("SELECT id FROM secrets WHERE id LIKE 'Prometheus/%' OR id LIKE 'Kubernetes/%'").all() as {id:string}[])if(!kept.has(id)){this.db.prepare('DELETE FROM secrets WHERE id=?').run(id);this.credentialEpoch++;}
  for(const r of this.db.prepare('SELECT value FROM work_sessions').all() as {value:string}[]){const w=JSON.parse(r.value) as WorkSession;if(w.approval){w.approval=null;w.revision++;this.saveWorkSession(w);}}});return this.snapshot()}
 readCredential(id:string){if(!this.key)throw new AppError(423,'Unlock the credential vault in Settings → Vault first.');const row=this.db.prepare('SELECT value FROM secrets WHERE id=?').get(id) as {value:string}|undefined;if(!row)throw new AppError(400,`Save the ${id} credential in the Vault first.`);return this.decrypt(row.value,this.key);}
 private secretCache?:{epoch:string;values:string[]};
 /** Returns every saved credential value and its derived forms, for redaction. Recomputed when a credential changes or the Vault locks. */
 secretValues(){const epoch=this.vaultEpoch+':'+this.credentialEpoch;if(this.secretCache?.epoch===epoch)return [...this.secretCache.values];const values=this.computeSecretValues();this.secretCache={epoch,values};return [...values];}
 private computeSecretValues(){const values:string[]=[];for(const id of this.vaultStatus().credentials){const raw=this.readCredential(id);values.push(raw);if(isServiceAuthConnection(id)||id.startsWith('Prometheus/'))values.push(...serviceAuthSecrets(raw));if(id.startsWith('Kubernetes/'))values.push(String((JSON.parse(raw) as {token?:unknown}).token??''));if(id==='ChatGPT'){const d=JSON.parse(raw) as {accounts:{tokens?:{access:string;refresh:string;identity:string}}[]};for(const a of d.accounts)if(a.tokens)values.push(a.tokens.access,a.tokens.refresh,a.tokens.identity);}}return values.filter(Boolean);}
 workSession(issue:SourceIssue):WorkSession{const row=this.db.prepare('SELECT value FROM work_sessions WHERE connection=? AND issue_id=?').get(issue.connection,issue.id) as {value:string}|undefined;const w:WorkSession=row?JSON.parse(row.value):{connection:issue.connection,issueId:issue.id,revision:1,sourceUpdated:issue.updated,updatedAt:new Date().toISOString(),notes:[],draft:'',plans:[],approval:null};let migrated=false;if(w.sourceKey!==issue.key){w.sourceKey=issue.key;migrated=true;}if(w.sourceUpdated!==issue.updated||(w.sourceFingerprint&&w.sourceFingerprint!==issue.sourceFingerprint)){w.sourceUpdated=issue.updated;w.sourceFingerprint=issue.sourceFingerprint;w.sourceChangedAt=new Date().toISOString();w.approval=null;w.revision++;this.saveWorkSession(w);}else if(migrated&&row)this.saveWorkSession(w);w.sourceFingerprint=issue.sourceFingerprint;if(!row)this.saveWorkSession(w);w.handling=handling(this,issue);w.replyState=this.get<{state:'draft'|'pending'|'sent'}>('incomingReply:'+issue.connection+':'+issue.id)?.state;w.origin=this.get('origin:'+issue.connection+':'+issue.id)??w.origin;return w;}
 getWorkSession(connection:string,id:string):WorkSession|undefined{const row=this.db.prepare('SELECT value FROM work_sessions WHERE connection=? AND issue_id=?').get(connection,id) as {value:string}|undefined;return row?JSON.parse(row.value):undefined;}
 pruneInvestigations(){this.db.prepare('DELETE FROM investigations WHERE started < ?').run(new Date(Date.now()-this.snapshot().config.retentionDays*86400000).toISOString());}
 saveInvestigation(run:AnalysisRun){if(!this.key||!run.connection)return;if(run.state!=='running'){const label={ready:'plan ready',failed:'failed',cancelled:'stopped'}[run.state],calls=run.events.filter(e=>e.tool).length,ms=Math.max(0,Date.parse(run.finishedAt??run.startedAt)-Date.parse(run.startedAt));recordDiagnostic(this,{id:run.id+':result',at:run.finishedAt??new Date().toISOString(),tool:'Agent',operation:`${run.kind==='changes'?'Change preparation':run.kind==='diagnosis'?'Pipeline diagnosis':'Investigation'} ${label}: ${(run.title??run.issueId).split(' · ')[0]}`,status:run.state==='failed'?'error':run.state==='cancelled'?'cancelled':'ok',durationMs:ms,output:[...(run.error&&run.state!=='ready'?[run.error]:[]),`Ticket: ${run.title??run.issueId}`,`Model: ${run.model??'unknown'}`,`Tool calls: ${calls}`,`Duration: ${Math.round(ms/1000)} s`].join('\n'),runId:run.id,issueId:run.issueId});}for(const [index,e] of run.events.entries())if(e.tool&&e.status!=='running'&&(e.result||e.status==='failed')){recordDiagnostic(this,{id:run.id+':'+index,at:e.at,tool:toolCategory(e.tool),operation:e.tool,status:e.status==='failed'?'error':'ok',durationMs:0,request:e.input,output:e.result??e.conclusion??e.text,runId:run.id,issueId:run.issueId});}this.pruneInvestigations();this.db.prepare('INSERT OR REPLACE INTO investigations VALUES (?,?,?,?,?)').run(run.id,run.connection,run.issueId,run.startedAt,JSON.stringify(run));}
 investigation(id:string):AnalysisRun{if(!this.key)throw new AppError(423,'Unlock the Vault to read investigations.');this.pruneInvestigations();const row=this.db.prepare('SELECT value FROM investigations WHERE id=?').get(id) as {value:string}|undefined;if(!row)throw new AppError(404,'Investigation not found or expired.');return JSON.parse(row.value);}
 investigations(connection:string,id:string){if(!this.key)throw new AppError(423,'Unlock the Vault to read investigations.');this.pruneInvestigations();return (this.db.prepare('SELECT id FROM investigations WHERE connection=? AND issue_id=? ORDER BY started DESC LIMIT 100').all(connection,id) as {id:string}[]).map(r=>this.investigation(r.id));}
 saveWorkSession(w:WorkSession){this.db.prepare('INSERT OR REPLACE INTO work_sessions VALUES (?,?,?)').run(w.connection,w.issueId,JSON.stringify(w));}
 private schemeCache?:{epoch:string;schemes:Record<string,ServiceAuthScheme>};
 vaultStatus(){const credentials=this.handle&&this.key?(this.db.prepare('SELECT id FROM secrets').all() as {id:string}[]).map(r=>r.id):[];let authSchemes:Record<string,ServiceAuthScheme>={};
  if(this.key){const epoch=this.vaultEpoch+':'+this.credentialEpoch;if(this.schemeCache?.epoch!==epoch){const schemes:Record<string,ServiceAuthScheme>={};for(const id of credentials)if(isServiceAuthConnection(id)||id.startsWith('Prometheus/'))schemes[id]=parseServiceAuth(this.readCredential(id)).scheme;this.schemeCache={epoch,schemes};}authSchemes={...this.schemeCache.schemes};}
  return {initialized:this.vaultMeta()!==undefined,unlocked:!!this.key,credentials,authSchemes:authSchemes as Partial<Record<ServiceAuthConnection,ServiceAuthScheme>>&Record<string,ServiceAuthScheme>}}
 encrypt(value:string,key:Buffer){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({iv:iv.toString('base64'),tag:'',data:Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('base64')}).replace('"tag":""','"tag":"'+cipher.getAuthTag().toString('base64')+'"')}
 decrypt(value:string,key:Buffer){const v=JSON.parse(value);const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(v.iv,'base64'));cipher.setAuthTag(Buffer.from(v.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(v.data,'base64')),cipher.final()]).toString('utf8')}
 private vaultMeta(){try{return JSON.parse(readFileSync(this.vaultFile,'utf8')) as {salt:string;check:string};}catch{return undefined;}}
 /** Subkey that encrypts the database. The Vault key itself encrypts credentials. */
 private databaseKey(key:Buffer){return `x'${Buffer.from(hkdfSync('sha256',key,Buffer.alloc(0),'support-database-v1',32)).toString('hex')}'`;}
 private checkPassphrase(passphrase:string,v:{salt:string;check:string}){const key=scryptSync(passphrase,Buffer.from(v.salt,'base64'),32);try{if(this.decrypt(v.check,key)!=='support-vault-v1')throw new Error();return key;}catch{key.fill(0);throw new AppError(401,'Incorrect vault passphrase.');}}
 verifyPassphrase(passphrase:string){const v=this.vaultMeta();if(!v)throw new AppError(409,'Create the vault first.');this.checkPassphrase(passphrase,v).fill(0);}
 /**
  * Creates the Vault (`initialize`) or unlocks it. Creating encrypts the database. Unlocking opens the encrypted database
  * with a key derived from the passphrase. A wrong passphrase leaves the Vault locked.
  */
 unlock(passphrase:string,initialize=false){
  const v=this.vaultMeta();if(initialize&&v)throw new AppError(409,'Vault already exists.');if(!v&&!initialize)throw new AppError(409,'Create the vault first.');
  if(!v){
   const salt=randomBytes(32).toString('base64'),key=scryptSync(passphrase,Buffer.from(salt,'base64'),32);
   this.resetCaches();
   // SQLCipher cannot encrypt a database in WAL mode. Switch to the rollback journal while it rewrites the file.
   this.db.pragma('journal_mode=DELETE');this.db.pragma(`cipher='sqlcipher'`);this.db.pragma(`rekey="${this.databaseKey(key)}"`);this.db.pragma('journal_mode=WAL');
   const meta=this.vaultFile+'.tmp';writeFileSync(meta,JSON.stringify({salt,check:this.encrypt('support-vault-v1',key)}),{mode:0o600});renameSync(meta,this.vaultFile);
   this.key=key;return this.vaultStatus();
  }
  const key=this.checkPassphrase(passphrase,v);this.lock();
  try{const db=new Database(this.file);db.pragma(`cipher='sqlcipher'`);db.pragma(`key="${this.databaseKey(key)}"`);this.handle=db;this.prepareDatabase();for(const setup of this.openers)setup();}
  catch(e){this.handle?.close();this.handle=null;key.fill(0);throw e instanceof AppError?e:new AppError(500,'The database could not be opened. Check the data directory.');}
  this.key=key;return this.vaultStatus();
 }
 private resetCaches(){this.secretCache=undefined;this.schemeCache=undefined;this.vaultEpoch++;this.credentialEpoch++;}
 /** Clears the key from memory and closes the database. The file stays encrypted on disk. */
 lock(){this.resetCaches();this.key?.fill(0);this.key=null;this.handle?.close();this.handle=null}
 credential(id:string,value:string){this.credentialEpoch++;if(!this.key)throw new AppError(423,'Unlock the vault first.');this.db.prepare('INSERT OR REPLACE INTO secrets VALUES (?,?)').run(id,this.encrypt(value,this.key));if(id==='Model')this.put('modelCredentialProvider',this.snapshot().config.modelProvider);return this.vaultStatus()}
 /** Deletes a saved credential. */
 removeCredential(id:string){this.credentialEpoch++;if(!this.key)throw new AppError(423,'Unlock the vault first.');this.db.prepare('DELETE FROM secrets WHERE id=?').run(id);return this.vaultStatus()}
 /** Records token usage reported by the model provider. Kept for the retention period, independently of logs. */
 recordUsage(u:{id?:string;at?:string;provider:string;auth:string;model:string;input:number;output:number;cacheRead?:number;cacheWrite?:number;webSearches?:number;limits?:unknown[]}){
  this.db.prepare('INSERT OR IGNORE INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(u.id??randomUUID(),u.at??new Date().toISOString(),u.provider,u.auth,u.model,u.input,u.output,u.cacheRead??null,u.cacheWrite??null,u.webSearches??0,JSON.stringify(u.limits??[]));
  this.db.prepare('DELETE FROM model_usage WHERE at < ?').run(new Date(Date.now()-this.snapshot().config.retentionDays*86400000).toISOString());
 }
 close(){this.lock()}
}

import type {Handling,SourceOrigin} from './intake-model.js';
import { z } from 'zod';
export const connectionNames = ['YouTrack','GitLab','Toolbox','Outline','Alertmanager','Prometheus','Grafana','Slack','Model'] as const;
export type ConnectionName = typeof connectionNames[number];
const text=z.string().trim().max(2048);
const endpoint=text.refine(v=>{if(!v)return true;try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}},'Use an HTTP(S) URL without credentials, query or fragment.');
const path=text.refine(v=>!v||v.startsWith('/'),'Use an absolute path.');
export const connectionSchema=z.object({endpoint,scope:text,path,enabled:z.boolean()}).strict();
export const alertingDefaults={pollSeconds:60,groupBy:'',autoInvestigate:false,defaultHandling:'ignore' as const};
export const alertingSchema=z.object({pollSeconds:z.number().int().min(15).max(900),groupBy:z.string().max(500).refine(v=>!v.trim()||v.split(',').every(k=>/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k.trim())), 'Use comma-separated label names.'),autoInvestigate:z.boolean(),defaultHandling:z.enum(['ignore','ticket','investigate']).default('ignore')}).strict();
/** Kubernetes namespace name, or a pattern where "*" matches any characters, such as "kube-*" or "*gitlab*". */
export const namespacePattern=z.string().trim().min(1).max(63).regex(/^[a-z0-9*]([-a-z0-9*]*[a-z0-9*])?$/,'Use a namespace name or a pattern with *, such as kube-* or *gitlab*.');
/** Toolbox behaviour that Support writes into the generated Toolbox configuration. */
export const toolboxSettingsSchema=z.object({
 excludedNamespaces:z.array(namespacePattern).max(100),
 allowConfigMaps:z.boolean(),
 allowClusterScoped:z.boolean(),
 allowPortForward:z.boolean(),
 timeoutSeconds:z.number().int().min(1).max(120),
 maxOutputMiB:z.number().int().min(1).max(8),
 portForwardMaxSeconds:z.number().int().min(1).max(3600),
 redactionLiterals:z.array(z.string().min(1).max(500)).max(100),
 redactionPatterns:z.array(z.string().min(1).max(500)).max(100),
}).strict();
export const toolboxDefaults:z.infer<typeof toolboxSettingsSchema>={excludedNamespaces:['kube-*','*gitlab*','*linkerd*'],allowConfigMaps:false,allowClusterScoped:false,allowPortForward:false,timeoutSeconds:30,maxOutputMiB:1,portForwardMaxSeconds:300,redactionLiterals:[],redactionPatterns:[]};
const serverName=z.string().trim().min(1).max(60).regex(/^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/,'Use lower-case letters, digits, "-", "_" or ".".').refine(v=>!v.startsWith('grafana'),'Names starting with grafana are reserved.');
const serverId=z.string().regex(/^[a-z0-9]{1,16}$/);
/** Prometheus server exposed over HTTP(S), such as through an ingress. Its credential is saved in the Vault as Prometheus/<id>. */
export const prometheusUrlSchema=z.object({id:serverId,name:serverName,kind:z.literal('url'),endpoint:endpoint.refine(v=>!!v,'Enter the Prometheus URL.')}).strict();
/** Prometheus server reached through a Toolbox tunnel that Support opens on first use. */
export const prometheusTunnelSchema=z.object({
 id:serverId,name:serverName,kind:z.literal('tunnel'),
 context:z.string().trim().min(1).max(253),
 namespace:z.string().trim().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,'Use a namespace name.'),
 target:z.string().trim().max(253).regex(/^((pod|service|svc|deployment|statefulset)\/)?[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/,'Use service/NAME, statefulset/NAME, deployment/NAME or a pod name.'),
 port:z.number().int().min(1).max(65535),
 pathPrefix:z.string().trim().max(200).regex(/^(\/[A-Za-z0-9._~-]+)*\/?$/,'Use a path such as /prometheus, or leave empty.').default(''),
}).strict();
export const prometheusSourceSchema=z.discriminatedUnion('kind',[prometheusUrlSchema,prometheusTunnelSchema]);
export type PrometheusSource=z.infer<typeof prometheusSourceSchema>;
/** Vault credential name of a Prometheus server. */
export const prometheusCredential=(id:string)=>'Prometheus/'+id;
/** Returns a short ID for a new Prometheus server. */
export const newServerId=()=>Math.random().toString(36).slice(2,10).padEnd(8,'0');
const nameId=(name:string)=>{let h=5381;for(const c of name)h=((h*33)^c.charCodeAt(0))>>>0;return 'm'+h.toString(36);};
/** Default agent instructions shown in Settings → Model. The engineer can edit them. */
export const defaultAgentInstructions=[
 'Combine every useful source before concluding: Kubernetes resources, events and pod logs through Toolbox, metrics from every Prometheus source, alerts, GitLab pipelines and code, YouTrack tickets, Outline documents and vendor documentation on the web.',
 'Check findings with data instead of assuming them. Process data with run_command (git, curl, jq, yq, python, helm, kustomize, terraform and similar tools).',
 'For metrics, start with prometheus_sources. Compare a cluster Prometheus with the federation Prometheus when metrics are missing: check targets, scrape errors, rules and the series on both sides. Reuse PromQL from Grafana dashboards when available.',
 'For code and configuration, clone the repository with repo_checkout and use git log, git blame and git grep to find recent changes. When the fix is in a repository, edit the files, validate them (lint, template, dry-run), then submit them with propose_change.',
 'Search Outline for runbooks and architecture notes. Read vendor documentation with web search when available, otherwise with curl in run_command.',
 'When information only the engineer has would change the plan, ask with ask_engineer and continue with other checks. Follow engineer messages when they change the scope or direction.',
 'If a tool call fails, read the error and adapt: change the input, use another tool, or note the gap.',
 'Use the latest ticket priority, description and comments as the source of truth. Previous plans and notes may be outdated. Explain material changes to the previous plan.',
 'In the plan, state what was checked, what is uncertain, exact targets, proposed steps, validation and rollback. Cite the resources, queries, files and URLs actually read. Name unavailable integrations as unchecked.',
].join('\n');
const configObject=z.object({modelAuth:z.enum(['api_key','chatgpt','claude_cli']).default('api_key'),modelProvider:z.enum(['anthropic','openai']).default('anthropic'),alerting:alertingSchema.default(alertingDefaults),engineer:z.string().trim().min(1).max(80),timezone:z.string().refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Unknown timezone'),theme:z.enum(['auto','light','dark']),hoursStart:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),hoursEnd:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),connections:z.record(z.enum(connectionNames),connectionSchema),toolbox:toolboxSettingsSchema.default(toolboxDefaults),retentionDays:z.number().int().min(1).max(30),maxRuns:z.number().int().min(1).max(4).default(2),agentCommands:z.boolean().default(true),parallelReview:z.boolean().default(true),agentWebSearch:z.boolean().default(true),agentLimits:z.object({maxTurns:z.number().int().min(5).max(1000),maxToolCalls:z.number().int().min(10).max(500),runMinutes:z.number().int().min(5).max(240),commandSeconds:z.number().int().min(5).max(600)}).default({maxTurns:200,maxToolCalls:80,runMinutes:60,commandSeconds:120}),prometheusSources:z.array(prometheusSourceSchema).max(30).default([]).refine(v=>new Set(v.map(s=>s.name)).size===v.length,'Each Prometheus server needs a unique name.').refine(v=>new Set(v.map(s=>s.id)).size===v.length,'Duplicate Prometheus server ID.'),agentInstructions:z.string().max(16000).default(defaultAgentInstructions),autoInvestigate:z.boolean().default(true),notifications:z.object({reviews:z.boolean(),blocked:z.boolean(),reopened:z.boolean(),completion:z.boolean(),privatePreview:z.boolean()}).strict(),onboardingStep:z.number().int().min(0).max(6),onboardingComplete:z.boolean()}).strict();
/** Settings removed in earlier versions. Stored configurations and imports that still contain them load without them. */
const removedSettings=['repositoryRoot','repositories'];
/** Converts settings from earlier versions: drops removed settings, adds connections added later, and moves the comma-separated excludedNamespaces string into toolbox.excludedNamespaces. */
function migrateSettings(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 const {excludedNamespaces,...rest}=Object.fromEntries(Object.entries(value).filter(([key])=>!removedSettings.includes(key))) as Record<string,unknown>;
 if(rest.connections&&typeof rest.connections==='object'){const c={...rest.connections as Record<string,unknown>};for(const n of connectionNames)c[n]??={endpoint:'',scope:'',path:'',enabled:false};rest.connections=c;}
 // Prometheus servers: earlier tunnel sources had no kind and no ID; the single Prometheus URL becomes a server named "prometheus".
 if(Array.isArray(rest.prometheusSources))rest.prometheusSources=rest.prometheusSources.map(v=>v&&typeof v==='object'&&!('kind' in v)?{id:nameId(String((v as {name?:unknown}).name??'')),kind:'tunnel',...v}:v);
 const prom=(rest.connections as Record<string,{endpoint?:string}>|undefined)?.Prometheus;
 if(prom?.endpoint){const list=Array.isArray(rest.prometheusSources)?rest.prometheusSources as {id?:string;name?:string}[]:[];if(!list.some(v=>v.id==='legacy'))rest.prometheusSources=[{id:'legacy',name:list.some(v=>v.name==='prometheus')?'prometheus-main':'prometheus',kind:'url',endpoint:prom.endpoint},...list];rest.connections={...rest.connections as object,Prometheus:{...prom,endpoint:''}};}
 if(typeof excludedNamespaces==='string'&&rest.toolbox===undefined)rest.toolbox={...toolboxDefaults,excludedNamespaces:excludedNamespaces.split(',').map(v=>v.trim()).filter(Boolean).slice(0,100)};
 return rest;
}
export const configSchema=z.preprocess(migrateSettings,configObject);
export type Config=z.infer<typeof configSchema>;
export const defaults:Config={modelAuth:'api_key',modelProvider:'anthropic',alerting:alertingDefaults,engineer:'Support engineer',timezone:'Europe/Paris',theme:'auto',hoursStart:'09:00',hoursEnd:'18:00',connections:Object.fromEntries(connectionNames.map(n=>[n,{endpoint:'',scope:n==='Outline'?'DevOps':n==='Slack'?'support-infra':'',path:'',enabled:false}])) as Config['connections'],toolbox:toolboxDefaults,retentionDays:30,maxRuns:2,agentCommands:true,parallelReview:true,agentWebSearch:true,agentLimits:{maxTurns:200,maxToolCalls:80,runMinutes:60,commandSeconds:120},prometheusSources:[],agentInstructions:defaultAgentInstructions,autoInvestigate:true,notifications:{reviews:true,blocked:true,reopened:true,completion:false,privatePreview:true},onboardingStep:0,onboardingComplete:false};
export const stages=['Backlog','In progress','Review','Waiting','Done'] as const;
export type Status=typeof stages[number];
export type Step={id:string;title:string;body:string};
export type Plan={version:number;steps:Step[];scope:string;createdAt:string;change:string};
export type Ticket={id:string;title:string;source:string;severity:string;environment:string;target:string;status:Status;next:string;needsYou:boolean;reopened:boolean;sample:true;revision:number;plans:Plan[];notes:{text:string;stepId?:string;version:number;at:string}[];events:{at:string;title:string;detail:string}[];approval:null|{version:number;configRevision:number;hash:string;actor:string;actorId?:string;workspaceId?:string;at:string};draft:string;updatedAt:string};
export type Snapshot={config:Config;configRevision:number;tickets:Ticket[];vault:{initialized:boolean;unlocked:boolean;credentials:string[];authSchemes?:Record<string,'bearer'|'basic'>};runtime:{mode:string;platform:string;liveExecution:false}};
export type SourceIssue={comments?:{id:string;text:string;updated:number}[];sourceFingerprint?:string;id:string;key:string;title:string;description:string;updated:number;resolved:boolean;status:string;severity:string;assignee:string;project:string;fields:Record<string,string>;url:string;connection:string};
/** Code change proposed by the agent from a sandbox checkout. Becomes a branch only after plan approval. */
export type ChangeProposal={id:string;project:string;commit:string;title:string;summary:string;at:string;files:{path:string;before:string|null;after:string|null}[]};
export type AgentQuestion={id:string;text:string;at:string;answer?:{text:string;at:string;by:string}};
export type EngineerMessage={id:string;text:string;at:string;by:string;replyTo?:string;delivered?:string};
/**
 * What started a run: the first investigation, a continuation of a run's session (an answer or comment), a recheck of
 * the request, a restart from a plan version, a session started over, or the implementation of an approved plan.
 * `text` is the engineer's message as sent; `prompt`, when set, is the full message given to the agent. `runId` is the
 * run whose session was continued.
 */
export type RunBasis={kind:'start'|'continue'|'recheck'|'restart'|'over'|'implement';runId?:string;planVersion?:number;text?:string;prompt?:string;by?:string;at?:string};
export type AnalysisRun={basedOn?:RunBasis;engine?:'claude-code';outcome?:'diagnosis'|'plan'|'needs_input'|'inconclusive';report?:string;sessionId?:string;parentRunId?:string;kind?:'investigation'|'changes'|'diagnosis';title?:string;proposals?:ChangeProposal[];questions?:AgentQuestion[];messages?:EngineerMessage[];connection?:string;sourceUpdated?:number;sourceFingerprint?:string;model?:string;planVersion?:number;plan?:string;replyDraft?:string;id:string;issueId:string;state:"running"|"ready"|"failed"|"cancelled";events:{at:string;text:string;callId?:string;tool?:string;input?:string;result?:string;conclusion?:string;status?:'running'|'complete'|'failed'}[];startedAt:string;finishedAt?:string;error?:string};
export type PlanAnnotation={start?:number;end?:number;version:number;quote:string;markdown?:string;kind:'comment'|'recheck'|'remove'};
export type WorkSession={replyState?:'draft'|'pending'|'sent';handling?:Handling;origin?:SourceOrigin;sourceKey?:string;sourceChangedAt?:string;sourceFingerprint?:string;alertHandoffs?:AlertHandoff[];analysis?:{model:string;events:{at:string;text:string}[]};pendingRevision?:boolean;connection:string;issueId:string;revision:number;sourceUpdated:number;updatedAt:string;notes:{id?:string;at:string;text:string;annotation?:PlanAnnotation}[];draft:string;plans:{version:number;text:string;at:string;runId?:string}[];approval:null|{version:number;sourceUpdated:number;configRevision:number;actor:string;actorId?:string;workspaceId?:string;at:string}};
export type LiveDetail={issue:SourceIssue;session:WorkSession};

export type ChangeFile={path:string;before:string|null;after:string|null};
export type ChangeSet={resolution?:Resolution;tracking?:MergeTracking;fixes?:FixProposal[];id:string;connection:string;issueId:string;planVersion:number;planApproval:string;sessionRevision:number;configRevision:number;sourceUpdated:number;endpoint:string;repositoryPath?:string;project:string;target:string;base:string;branch:string;head?:string;files:ChangeFile[];diffs:{path:string;diff:string}[];title:string;description:string;state:'generating'|'failed'|'branch_pending'|'review'|'mr_pending'|'created'|'changed';reviewHash?:string;approval?:{hash:string;actor:string;actorId?:string;workspaceId?:string;at:string};mr?:{iid:number;url:string};message:string;createdAt:string;updatedAt:string};

export type MergeTracking={checkedAt:string;error?:string;state:string;mergeStatus:string;draft:boolean;head:string;targetHead:string|null;pipeline:null|{id:number;sha:string;status:string};jobs:{id:number;name:string;stage:string;status:string;allow_failure:boolean;failure_reason?:string|null}[];jobsLimited:boolean};
export type FixProposal={id:string;state:'proposed'|'diagnosed'|'pushing'|'pushed'|'changed'|'superseded';summary:string;feedback:string;head:string;targetHead:string;snapshotHash:string;hash:string;files:{path:string;before:string;after:string;lastCommit:string}[];configRevision:number;sessionRevision:number;sourceUpdated:number;createdAt:string;commit?:string;message:string;approval?:{hash:string;actor:string;actorId?:string;workspaceId?:string;at:string}};

export type ResolvedState={fieldId:string;fieldName:string;valueId:string;valueName:string};
export type ResolutionProof={mergeSha:string;sourceSha:string;mergedAt:string;pipelineId:number;pipelineSha:string;target:string};
export type Resolution={id:string;text:string;hash:string;revision:number;state:'draft'|'posting'|'posted'|'closing'|'closed'|'reopened';sourceUpdated:number;sessionRevision:number;configRevision:number;proof:ResolutionProof;commentId?:string;message:string;options?:ResolvedState[];postApproval?:{hash:string;actor:string;actorId?:string;workspaceId?:string;at:string};closeReview?:ResolvedState&{proof:ResolutionProof;hash:string;sourceUpdated:number;sessionRevision:number;configRevision:number};closeApproval?:{hash:string;actor:string;actorId?:string;workspaceId?:string;at:string};closedAt?:string};

export type AlertMember={fingerprint:string;labels:Record<string,string>;annotations:Record<string,string>;startsAt:string;state:'unprocessed'|'active'|'suppressed'};
export type AlertCase={ignored?:number;sourceKind?:'alert'|'slack';channel?:string;threadTs?:string;ticketCreation?:AlertTicketDraft;id:string;connection:string;title:string;severity:string;labels:Record<string,string>;members:AlertMember[];active:boolean;suppressed:boolean;episodes:number;firstSeen:string;lastSeen:string;updated:number;digest:string;autoAttempt?:number;run?:AnalysisRun;ticket?:{connection:string;id:string;key:string;url:string}};
export type AlertDetail=LiveDetail&{alert:AlertCase};
export type AlertQueue={cases:(AlertCase&{session:WorkSession})[];enabled:boolean;paused:boolean;pollSeconds:number;lastSuccess?:string;error?:string;polling:boolean};

export type YouTrackProject={id:string;name:string;shortName:string;archived:boolean};
export type AlertTicketDraft={state:'draft'|'pending'|'created';revision:number;hash:string;connection:string;endpoint:string;project:YouTrackProject;title:string;description:string;marker:string;sourceUpdated:number;sessionRevision:number;configRevision:number;message:string;remoteId?:string;approval?:{hash:string;actor:string;actorId?:string;workspaceId?:string;at:string}};

export type AlertHandoff={id:string;requestHash:string;alertId:string;alertConnection:string;alertTitle:string;alertUpdated:number;alertActive:boolean;occurrences:number;sourcePlanVersion:number;sourceRevision:number;targetPlanVersion:number;at:string;actor:string;actorId?:string;workspaceId?:string;notes:WorkSession['notes'];replyDraft:string;analysis?:WorkSession['analysis']};
export type HandoffReview={hash:string;source:{id:string;title:string;updated:number;active:boolean;occurrences:number;revision:number;planVersion:number};plan:string;notes:WorkSession['notes'];replyDraft:string;analysis?:WorkSession['analysis'];target:{id:string;key:string;title:string;connection:string;revision:number;sourceUpdated:number;planCount:number;hasReplyDraft:boolean;pendingRevision:boolean};alreadyImported?:number};
export type HandoffResult={detail:LiveDetail;handoff:AlertHandoff;alreadyImported:boolean};
/** GitLab project returned by /api/gitlab/projects. */
export type GitLabProject={project:string;name:string;defaultBranch:string|null};
export type ToolboxSettings=z.infer<typeof toolboxSettingsSchema>;

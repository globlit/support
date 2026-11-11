import type {ModelTelemetry} from './telemetry-model.js';
export const logTools=['YouTrack','GitLab','Alertmanager','Prometheus','Grafana','Kubernetes','Slack','Outline','Model','Sandbox','Agent','App'] as const;
export type LogTool=typeof logTools[number];
export type Diagnostic={telemetry?:ModelTelemetry;id:string;at:string;tool:LogTool;operation:string;status:'ok'|'error'|'cancelled';durationMs:number;code?:number;request?:string;output:string;runId?:string;issueId?:string;truncated?:boolean};
export type LogPage={entries:Diagnostic[];next?:number;total:number;limit:number};

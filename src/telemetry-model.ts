import type {ConnectionName} from './model.js';
export type TokenUsage={input:number;output:number;cacheRead?:number;cacheWrite?:number};
export type RateLimit={name:string;limit?:number;remaining?:number;reset?:string};
export type ModelTelemetry={usage?:TokenUsage;limits:RateLimit[];provider:string;auth:string;model:string};
export type UsageSummary={responses:number;input:number;output:number;cacheRead:number;cacheReadReported:number;cacheWrite:number;limits:RateLimit[];limitsAt?:string};
export type ToolHealth={name:ConnectionName;state:'green'|'yellow'|'red'|'off';label:string;detail:string;at?:string;failures?:number;durationMs?:number;intervalSeconds?:number;timeoutSeconds?:number};

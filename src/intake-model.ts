export type SourceKind='youtrack'|'alert'|'slack';
export type HandlingMode='pending'|'ticket'|'investigate'|'reply'|'human'|'refused'|'done';
export type HandlingEvent={mode:HandlingMode;reason:string;at:string;actor:string};
/** Handling decision of a request. `defaultIgnored` marks an alert without a decision that the default setting ignores. */
export type Handling={mode:HandlingMode;reason:string;revision:number;at:string;actor:string;actorId?:string;workspaceId?:string;history:HandlingEvent[];defaultIgnored?:boolean};
export type IgnoreRule={id:string;source:'alert'|'slack';endpoint:string;kind:string;labels:Record<string,string[]>;reason:string;expiresAt?:string;createdAt:string;actor:string};
export type SourceOrigin={kind:SourceKind;id:string;title:string;connection:string;url?:string};
export function sourceKind(connection:string):SourceKind{return connection.startsWith('alertmanager:')?'alert':connection.startsWith('slack:')?'slack':'youtrack'}
export function sourcePath(connection:string){return sourceKind(connection)==='alert'?'/alerts':sourceKind(connection)==='slack'?'/slack':'/youtrack/issues'}
export function sourcePage(connection:string){return sourceKind(connection)==='alert'?'alerts':sourceKind(connection)==='slack'?'slack':'youtrack'}
export function handlingLabel(mode:HandlingMode){return ({pending:'Choose next step',ticket:'Create a ticket',investigate:'Agent handling',reply:'Reply directly',human:'Engineer handling',refused:'Refused',done:'Resolved by engineer'})[mode]}
export function ruleMatches(rule:IgnoreRule,source:'alert'|'slack',endpoint:string,kind:string,labels:Record<string,string>,now=Date.now()){
 return rule.source===source&&rule.endpoint===endpoint&&rule.kind===kind&&(!rule.expiresAt||Date.parse(rule.expiresAt)>now)&&Object.entries(rule.labels).every(([k,values])=>values.includes(labels[k]));
}

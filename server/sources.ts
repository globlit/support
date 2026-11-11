import {sourceKind,type SourceKind} from '../src/intake-model.js';
import {AppError} from './store.js';
import type {AlertCase,LiveDetail,RunBasis,SourceIssue} from '../src/model.js';

/** Delivery of an approved reply to the system a request came from. */
export type ReplyChannel={
 /** Name of the destination, used in messages. */
 destination:string;
 /** Posts the reply once. `clientId` makes the post identifiable. Returns the remote ID of the message. */
 post(id:string,text:string,clientId:string):Promise<string>;
 /** Finds the posted reply after an interrupted post. Returns its remote ID. Throws 409 unless exactly one message matches. */
 confirm(id:string,text:string,clientId:string,remoteId?:string):string;
};

/** A system that requests come from: YouTrack tickets, Alertmanager alerts or Slack threads. */
export type RequestSource={
 kind:SourceKind;
 /** Reads the request from its system. */
 issue(id:string):Promise<SourceIssue>;
 /** Reads the request with its work session. */
 work(id:string):Promise<LiveDetail>;
 /** Starts an agent run. `expected` is the revision and source timestamp the engineer saw. */
 start(id:string,expected:{revision:number;sourceUpdated:number},basis?:RunBasis):Promise<unknown>;
 /** Stored case of an incoming request. Alert and Slack sources only. Throws 404 when the case is unknown. */
 case?(id:string):AlertCase;
 /** Channel that delivers approved replies. Without it, an approved reply is recorded locally only. */
 reply?:ReplyChannel;
 /** Called when the queue fails to start a run of this source. */
 onStartError?(id:string,error:unknown):void;
};

/** Reference prefixes of incoming requests in request URLs and change records. YouTrack tickets have none. */
const referencePrefix:Record<Exclude<SourceKind,'youtrack'>,string>={alert:'alert:',slack:'slack:'};

/** The request sources, by kind. Every dispatch on the origin of a request goes through this registry. */
export class Sources{
 private all=new Map<SourceKind,RequestSource>();
 register(source:RequestSource){this.all.set(source.kind,source);return this;}
 get(kind:SourceKind){const source=this.all.get(kind);if(!source)throw new Error(`No request source of kind ${kind}.`);return source;}
 /** Source of a request, from the connection name of its issue. */
 forConnection(connection:string){return this.get(sourceKind(connection));}
 /** Stored case of an incoming request. Throws 404 for a request without a case. */
 case(connection:string,id:string){const source=this.forConnection(connection);if(!source.case)throw new AppError(404,'This request has no stored case.');return source.case(id);}
 /** Reply channel of a request source, if it has one. */
 replyChannel(connection:string){return this.forConnection(connection).reply;}
 /** Request reference of an incoming request: `alert:<id>` or `slack:<id>`. */
 static reference(kind:Exclude<SourceKind,'youtrack'>,id:string){return referencePrefix[kind]+id;}
 /**
  * Reads a request from a reference or an ID. A reference carries its kind. A bare ID uses the kind of `connection`,
  * and is a YouTrack ticket when there is no connection.
  */
 issue(id:string,connection?:string){
  for(const [kind,prefix] of Object.entries(referencePrefix))if(id.startsWith(prefix))return this.get(kind as SourceKind).issue(id.slice(prefix.length));
  return (connection?this.forConnection(connection):this.get('youtrack')).issue(id);
 }
}

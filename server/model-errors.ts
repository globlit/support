import {redactDiagnostic} from './diagnostics.js';

export type ResponseFailure={httpStatus:number;event?:string;code?:string;param?:string;requestId?:string;reason?:string;message?:string;summary:string};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};

// Keep error fields only.
export function responseFailure(payload:unknown,response:Response,event?:string,secrets:string[]=[]):ResponseFailure{
 const root=object(payload),nested=object(root.response),error=object(nested.error??root.error);
 const clean=(v:unknown,max=160)=>typeof v==='string'?redactDiagnostic(v,secrets).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max):undefined;
 const code=clean(error.code??error.type??root.code),param=clean(error.param??root.param),reason=clean(object(nested.incomplete_details??root.incomplete_details).reason);
 const message=clean(error.message??root.message??root.detail,1000);
 const requestId=clean(response.headers.get('x-request-id')??response.headers.get('request-id')??root.request_id);
 let advice:string;
 if(code==='subscription_sharing_usage_limit_exceeded'||code==='insufficient_quota')advice='The usage allowance for this request has been reached. Check ChatGPT Settings → Usage if using your subscription. Signing in again will not reset it.';
 else if(['rate_limit_exceeded','rate_limit_error'].includes(code??'')||response.status===429)advice='The provider is rate-limiting requests. Wait before investigating again; your saved connection has been kept.';
 else if(['subscription_sharing_usage_unavailable','subscription_sharing_user_unavailable','server_error','service_unavailable','overloaded_error','api_error'].includes(code??'')||response.status>=500)advice='The provider could not process this request. Try again later; your saved connection has been kept.';
 else if(['subscription_sharing_unsupported_capability','invalid_function_parameters','invalid_json_schema','invalid_request_error'].includes(code??'')||response.status===400)advice='The provider rejected the model request or tool definition. Review the details below; signing in again will not fix the request.';
 else if(code==='subscription_sharing_user_not_eligible')advice='ChatGPT plan use is unavailable for this account or workspace. Check the account policy or choose another configured connection.';
 else if(['subscription_sharing_route_not_supported','chatpass_v2_scope_not_authorized','chatpass_v2_invalid_authorization_context'].includes(code??'')||response.status===403)advice='The provider refused this operation. Check the account permissions and integration settings.';
 else if(['subscription_sharing_invalid_user','invalid_api_key','authentication_error'].includes(code??'')||response.status===401)advice='The provider rejected the saved credential. Check the selected account in Settings → Model; sign in again if access was revoked.';
 else if(event==='response.incomplete')advice=reason==='max_output_tokens'?'The response reached its output limit before finishing. No partial plan was applied.':reason==='content_filter'?'The provider stopped this response because of its content policy. Review the request before retrying.':'The provider stopped before completing the response. No partial plan was applied.';
 else advice='The provider failed to complete this request. Review the details below before retrying; this does not by itself mean you are signed out.';
 const details=[code&&`Code: ${code}.`,param&&`Parameter: ${param}.`,reason&&`Reason: ${reason}.`,message&&`Provider: ${message}`,requestId&&`Request: ${requestId}.`].filter(Boolean).join(' ');
 return {httpStatus:response.status,event,code,param,requestId,reason,message,summary:[advice,details,'No result was applied.'].filter(Boolean).join(' ')};
}

export async function readFailureBody(response:Response):Promise<unknown>{
 if(!response.body)return {};
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();return {detail:'Error body exceeded the diagnostic limit.'};}chunks.push(value);}
  const text=Buffer.concat(chunks).toString('utf8');try{return JSON.parse(text)}catch{return {detail:response.headers.get('content-type')?.includes('text/plain')?text:'Provider returned a non-JSON error body.'};}
 }finally{reader.releaseLock();}
}

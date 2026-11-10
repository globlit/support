import type {TokenUsage,RateLimit} from '../src/telemetry-model.js';
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:undefined;
export function tokenUsage(value:unknown,provider:'openai'|'anthropic'):TokenUsage|undefined{
 if(!value||typeof value!=='object')return;
 const v=value as Record<string,unknown>,input=count(v.input_tokens),output=count(v.output_tokens);
 if(input===undefined||output===undefined)return;
 const read=provider==='openai'?count((v.input_tokens_details as Record<string,unknown>|undefined)?.cached_tokens):count(v.cache_read_input_tokens);
 const write=provider==='openai'?count((v.input_tokens_details as Record<string,unknown>|undefined)?.cache_write_tokens):count(v.cache_creation_input_tokens);
 const totalInput=provider==='anthropic'?input+(read??0)+(write??0):input;
 if(!Number.isSafeInteger(totalInput))return;
 const searches=provider==='anthropic'?count((v.server_tool_use as Record<string,unknown>|undefined)?.web_search_requests):undefined;
 return {input:totalInput,output,cacheRead:read,cacheWrite:write,...(searches?{webSearches:searches}:{})};
}
export function rateLimits(headers:Headers,provider:'openai'|'anthropic'):RateLimit[]{
 const names=provider==='openai'?['requests','tokens','project-tokens']:['requests','input-tokens','output-tokens'];
 return names.flatMap(name=>{
  const key=(part:string)=>provider==='openai'?`x-ratelimit-${part}-${name}`:`anthropic-ratelimit-${name}-${part}`;
  const number=(part:string)=>{const raw=headers.get(key(part));return raw&&/^\d+$/.test(raw)?count(Number(raw)):undefined};
  const limit=number('limit'),remaining=number('remaining'),raw=headers.get(key('reset'));
  const reset=raw&&raw.length<=64&&(/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(raw)||/^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/.test(raw))?raw:undefined;
  return limit===undefined&&remaining===undefined?[]:[{name,limit,remaining,reset}];
 });
}

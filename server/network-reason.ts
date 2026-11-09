/** Returns a short, safe description of why a fetch rejected. Never includes URLs, headers or raw messages. */
export function networkReason(e:unknown):string{
 const err=e as {name?:string;message?:string;cause?:{code?:string;name?:string}}|undefined;
 const name=err?.name??'',code=err?.cause?.code??(err as {code?:string}|undefined)?.code??'';
 if(name==='TimeoutError'||err?.cause?.name==='TimeoutError')return 'No response before the timeout; check proxy, VPN or firewall from the Support server.';
 if(name==='AbortError')return 'Request aborted.';
 switch(code){
  case 'ENOTFOUND':case 'EAI_AGAIN':return 'Host not found (DNS) from the Support server.';
  case 'ECONNREFUSED':return 'Connection refused.';
  case 'ECONNRESET':case 'UND_ERR_SOCKET':return 'Connection reset by the remote host or a proxy.';
  case 'EHOSTUNREACH':case 'ENETUNREACH':return 'Host unreachable from the Support server (route or VPN).';
  case 'ETIMEDOUT':case 'UND_ERR_CONNECT_TIMEOUT':return 'Connect timeout; check proxy (NODE_USE_ENV_PROXY=1 with HTTPS_PROXY), VPN or firewall.';
  case 'UND_ERR_HEADERS_TIMEOUT':case 'UND_ERR_BODY_TIMEOUT':return 'Remote host accepted the connection but did not respond in time.';
 }
 if(/^(CERT_|ERR_TLS_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|ERR_SSL_)/.test(code))return `TLS certificate not trusted (${code}); set NODE_EXTRA_CA_CERTS.`;
 return code?`Network error (${code}).`:'Network error.';
}

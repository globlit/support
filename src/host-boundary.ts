/** Set by host HTML, never by VM responses. */
export function hostBoundary(){return typeof document!=='undefined'&&!!document.querySelector('meta[name="support-host-boundary"][content="isolated"]');}
export function boundaryHref(href:string|undefined,protectedMode=hostBoundary()){
 if(!protectedMode)return href;
 // Navigate to app routes and host downloads only.
 if(href&&((href.startsWith('#/')&&href.length<=8192&&!/[\x00-\x1f\x7f]/.test(href))||/^\/downloads\/(support-companion\.zip|companion-guide\.html|mac-install\.html)$/.test(href)))return href;
 return undefined;
}

/** Marker is injected by the host's immutable HTML, never read from a VM API response. */
export function hostBoundary(){return typeof document!=='undefined'&&!!document.querySelector('meta[name="support-host-boundary"][content="isolated"]');}
export function boundaryHref(href:string|undefined,protectedMode=hostBoundary()){
 if(!protectedMode)return href;
 // No remote/guest-supplied navigation, even when the destination resembles a local tool.
 // Only app routes and known host-packaged downloads are navigable.
 if(href&&((href.startsWith('#/')&&href.length<=8192&&!/[\x00-\x1f\x7f]/.test(href))||/^\/downloads\/(support-companion\.zip|companion-guide\.html)$/.test(href)))return href;
 return undefined;
}

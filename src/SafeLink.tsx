import type {AnchorHTMLAttributes} from 'react';
/** True for http, https and mailto URLs, and for in-app routes starting with "#/". */
export function safeHref(href:string|undefined){if(!href)return false;if(href.startsWith('#/'))return true;try{return ['http:','https:','mailto:'].includes(new URL(href).protocol);}catch{return false;}}
/** Link that renders its children as plain text when the URL scheme is not allowed. */
export function SafeLink({href,children,...props}:AnchorHTMLAttributes<HTMLAnchorElement>){
 return safeHref(href)?<a {...props} href={href}>{children}</a>:<span>{children}</span>;
}

import type {AnchorHTMLAttributes} from 'react';
import {boundaryHref} from './host-boundary';
export function SafeLink({href,children,...props}:AnchorHTMLAttributes<HTMLAnchorElement>){
 const safe=boundaryHref(href);
 return safe?<a {...props} href={safe}>{children}</a>:<span className={props.className} title="External links are disabled in the isolated VM view. Open trusted service bookmarks separately.">{children}</span>;
}

import type {AnchorHTMLAttributes} from 'react';
export function SafeLink({href,children,...props}:AnchorHTMLAttributes<HTMLAnchorElement>){
 return <a {...props} href={href}>{children}</a>;
}

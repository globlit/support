import type {ReactNode} from 'react';
export function Field({label,hint,children}:{label:string;hint?:string;children:ReactNode}){return <label>{label}{children}{hint&&<small>{hint}</small>}</label>}

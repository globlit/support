import type {ReactNode} from 'react';
import {HelpTip} from './HelpTip';
/** Labelled form field. With `help`, a "?" button next to the field opens that explanation. */
export function Field({label,hint,help,children}:{label:string;hint?:string;help?:ReactNode;children:ReactNode}){
 const field=<label>{label}{children}{hint&&<small>{hint}</small>}</label>;
 // The help button stays outside the label, so it does not become the field's label.
 return help?<div className="field-with-help">{field}<HelpTip label={label}>{help}</HelpTip></div>:field;
}

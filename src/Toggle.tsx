import type {ReactNode} from 'react';

/** Bare on/off switch without visible text. `label` is its accessible name. */
export function Switch({label,checked,onChange,disabled}:{label:string;checked:boolean;onChange:(checked:boolean)=>void;disabled?:boolean}){
 return <label className="toggle toggle-bare"><input type="checkbox" role="switch" aria-label={label} aria-checked={checked} checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/><span className="toggle-track" aria-hidden="true"/></label>;
}

/** On/off switch with a label and an optional hint under it. */
export function Toggle({label,hint,checked,onChange,disabled}:{label:ReactNode;hint?:ReactNode;checked:boolean;onChange:(checked:boolean)=>void;disabled?:boolean}){
 return <label className="toggle"><input type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/><span className="toggle-track" aria-hidden="true"/><span className="toggle-text">{label}{hint&&<small>{hint}</small>}</span></label>;
}

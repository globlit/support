import {useEffect,useState} from 'react';
import {Field} from './Field';
import type {ReactNode} from 'react';

/** Returns the integer in `text` clamped to [min, max], or `fallback` when `text` is not a number. */
export function clampNumber(text:string,min:number,max:number,fallback:number){
 const n=Number(text.trim());
 if(!text.trim()||!Number.isFinite(n))return fallback;
 return Math.min(max,Math.max(min,Math.round(n)));
}

/**
 * Integer field with − and + buttons. The value can also be typed. A typed value is applied on blur or Enter,
 * clamped to [min, max]. ArrowUp and ArrowDown step by 1, or by 10 with Shift.
 */
export function NumberField({label,help,value,min,max,disabled,onChange}:{label:string;help?:ReactNode;value:number;min:number;max:number;disabled?:boolean;onChange:(value:number)=>void}){
 const [text,setText]=useState(String(value));
 useEffect(()=>setText(String(value)),[value]);
 const apply=(next:number)=>{const v=Math.min(max,Math.max(min,next));setText(String(v));if(v!==value)onChange(v);};
 const commit=()=>apply(clampNumber(text,min,max,value));
 return <Field label={label} help={help}><span className="number-field">
  <button type="button" aria-label={`Decrease ${label}`} disabled={disabled||value<=min} onClick={()=>apply(value-1)}>−</button>
  <input type="text" inputMode="numeric" value={text} disabled={disabled} onChange={e=>setText(e.target.value)} onBlur={commit}
   onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commit();}else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();const step=(e.shiftKey?10:1)*(e.key==='ArrowUp'?1:-1);apply(clampNumber(text,min,max,value)+step);}}}/>
  <button type="button" aria-label={`Increase ${label}`} disabled={disabled||value>=max} onClick={()=>apply(value+1)}>+</button>
 </span></Field>;
}

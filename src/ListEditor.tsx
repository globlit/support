import {useState,type ReactNode} from 'react';
import {Field} from './Field';

/**
 * Editable list of short text entries. Type an entry and press Enter or "+" to add it. Each entry has a remove button.
 * `validate` returns an error message for an invalid entry. Duplicates are ignored.
 */
export function ListEditor({label,help,values,onChange,placeholder,validate,max=100}:{label:string;help?:ReactNode;values:string[];onChange:(values:string[])=>void;placeholder?:string;validate?:(value:string)=>string|undefined;max?:number}){
 const [text,setText]=useState(''),[error,setError]=useState('');
 function add(){
  const value=text.trim();if(!value)return;
  const invalid=validate?.(value);if(invalid){setError(invalid);return;}
  if(!values.includes(value)){if(values.length>=max){setError(`Add at most ${max} entries.`);return;}onChange([...values,value]);}
  setText('');setError('');
 }
 return <div className="list-editor">
  <Field label={label} help={help}><span className="list-editor-add"><input value={text} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={e=>{setText(e.target.value);setError('');}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();add();}}}/><button type="button" aria-label={`Add to ${label}`} disabled={!text.trim()} onClick={add}>+</button></span></Field>
  {error&&<p className="small error" role="alert">{error}</p>}
  {values.length?<ul className="list-editor-items" aria-label={label}>{values.map(value=><li key={value}><code>{value}</code><button type="button" aria-label={`Remove ${value}`} onClick={()=>onChange(values.filter(v=>v!==value))}>×</button></li>)}</ul>:<p className="small muted">No entries.</p>}
 </div>;
}

import {useEffect,useId,useRef,useState,type ReactNode} from 'react';

/** "?" button that opens a short explanation. A second click, Escape, or a click outside closes it. */
export function HelpTip({label,children}:{label:string;children:ReactNode}){
 const [open,setOpen]=useState(false),id=useId(),root=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(!open)return;
  const click=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};
  document.addEventListener('mousedown',click);document.addEventListener('keydown',key);
  return ()=>{document.removeEventListener('mousedown',click);document.removeEventListener('keydown',key);};
 },[open]);
 return <div className="help-tip" ref={root}>
  <button type="button" className="help-tip-button" aria-label={`Help: ${label}`} aria-expanded={open} aria-controls={id} onClick={e=>{e.preventDefault();setOpen(v=>!v);}}>?</button>
  {open&&<div id={id} role="note" className="help-tip-panel">{children}</div>}
 </div>;
}

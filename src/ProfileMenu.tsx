import {useEffect,useId,useRef,useState} from 'react';
import type {Config} from './model';

type Theme=Config['theme'];
const themes:[Theme,string][]=[['light','Light'],['dark','Dark'],['auto','Auto']];

/** Returns up to two initials from a name, or "?" when the name is empty. */
export function initials(name:string){return name.trim().split(/\s+/).filter(Boolean).map(part=>part[0]).join('').slice(0,2).toUpperCase()||'?';}

/**
 * Round profile button at the bottom of the sidebar. Its menu shows the engineer name and Vault state, changes the theme,
 * opens Settings, and locks the Vault. Locking the Vault signs every browser out.
 * Escape or a click outside closes the menu.
 */
export function ProfileMenu({name,theme,vaultUnlocked,busy,onTheme,onSettings,onLock}:{name:string;theme:Theme;vaultUnlocked:boolean;busy:boolean;onTheme:(theme:Theme)=>void;onSettings:()=>void;onLock:()=>void}){
 const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null),menuId=useId();
 useEffect(()=>{
  if(!open)return;
  const click=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);button.current?.focus();}};
  document.addEventListener('mousedown',click);document.addEventListener('keydown',key);
  return ()=>{document.removeEventListener('mousedown',click);document.removeEventListener('keydown',key);};
 },[open]);
 const choose=(action:()=>void)=>{setOpen(false);action();};
 return <div className="profile-menu" ref={root}>
  {open&&<div id={menuId} className="profile-menu-panel" role="menu" aria-label="Profile">
   <div className="profile-menu-header"><strong>{name}</strong><small>Vault {vaultUnlocked?'unlocked':'locked'}</small></div>
   <div className="themes" role="group" aria-label="Theme">{themes.map(([value,label])=><button key={value} type="button" role="menuitemradio" aria-checked={theme===value} aria-pressed={theme===value} disabled={busy} onClick={()=>onTheme(value)}>{label}</button>)}</div>
   <button type="button" role="menuitem" className="profile-menu-item" onClick={()=>choose(onSettings)}>Settings</button>
   {vaultUnlocked&&<button type="button" role="menuitem" className="profile-menu-item" disabled={busy} onClick={()=>choose(onLock)}>Lock vault and sign out</button>}
  </div>}
  <button ref={button} type="button" data-tour="settings" className="profile-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open?menuId:undefined} title={`${name} · Vault ${vaultUnlocked?'unlocked':'locked'}`} onClick={()=>setOpen(v=>!v)}>
   <span className="profile-avatar" aria-hidden="true">{initials(name)}</span><span className="profile-name">{name}</span>
  </button>
 </div>;
}

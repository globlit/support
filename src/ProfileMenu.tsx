import {useEffect,useId,useRef,useState,type KeyboardEvent as ReactKeyboardEvent,type ReactNode} from 'react';
import type {Config} from './model';

type Theme=Config['theme'];
const Icon=({children}:{children:ReactNode})=><svg className="profile-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const icons={
 light:<Icon><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></Icon>,
 dark:<Icon><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z"/></Icon>,
 auto:<Icon><rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/></Icon>,
 settings:<Icon><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/></Icon>,
 lock:<Icon><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></Icon>,
};
const themes:[Theme,string][]=[['light','Light'],['dark','Dark'],['auto','System']];

/** Returns up to two initials from a name, or "?" when the name is empty. */
export function initials(name:string){return name.trim().split(/\s+/).filter(Boolean).map(part=>part[0]).join('').slice(0,2).toUpperCase()||'?';}

/**
 * Profile button at the bottom of the sidebar, with a dot that shows the Vault state. Its menu shows the engineer
 * name and Vault state, changes the theme, opens Settings, and locks the Vault. Locking the Vault signs every browser out.
 * Escape or a click outside closes the menu. Arrow keys, Home and End move between menu items.
 */
export function ProfileMenu({name,theme,vaultUnlocked,busy,onTheme,onSettings,onLock}:{name:string;theme:Theme;vaultUnlocked:boolean;busy:boolean;onTheme:(theme:Theme)=>void;onSettings:()=>void;onLock:()=>void}){
 const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),menuId=useId();
 const vault=vaultUnlocked?'Vault unlocked':'Vault locked';
 useEffect(()=>{
  if(!open)return;
  panel.current?.querySelector<HTMLButtonElement>('[role^=menuitem]:not(:disabled)')?.focus();
  const click=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);button.current?.focus();}};
  document.addEventListener('mousedown',click);document.addEventListener('keydown',key);
  return ()=>{document.removeEventListener('mousedown',click);document.removeEventListener('keydown',key);};
 },[open]);
 const move=(e:ReactKeyboardEvent)=>{
  const items=[...panel.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)')??[]];if(!items.length)return;
  const i=items.indexOf(document.activeElement as HTMLButtonElement);
  const next=e.key==='ArrowDown'||e.key==='ArrowRight'?(i+1)%items.length:e.key==='ArrowUp'||e.key==='ArrowLeft'?(i-1+items.length)%items.length:e.key==='Home'?0:e.key==='End'?items.length-1:-1;
  if(next>=0){e.preventDefault();items[next].focus();}
 };
 const choose=(action:()=>void)=>{setOpen(false);action();};
 return <div className="profile-menu" ref={root}>
  {open&&<div id={menuId} ref={panel} className="profile-menu-panel" role="menu" aria-label="Profile" onKeyDown={move}>
   <div className="profile-menu-header">
    <span className="profile-avatar large" aria-hidden="true">{initials(name)}</span>
    <span className="profile-menu-identity"><strong title={name}>{name}</strong><span className={'profile-vault '+(vaultUnlocked?'unlocked':'locked')}><i aria-hidden="true"/>{vault}</span></span>
   </div>
   <div className="profile-menu-section">
    <span className="profile-menu-label" id={menuId+'-theme'}>Theme</span>
    <div className="profile-themes" role="group" aria-labelledby={menuId+'-theme'}>{themes.map(([value,label])=><button key={value} type="button" role="menuitemradio" aria-checked={theme===value} disabled={busy} onClick={()=>onTheme(value)}>{icons[value]}<span>{label}</span></button>)}</div>
   </div>
   <div className="profile-menu-section">
    <button type="button" role="menuitem" className="profile-menu-item" onClick={()=>choose(onSettings)}>{icons.settings}<span>Settings</span></button>
    {vaultUnlocked&&<button type="button" role="menuitem" className="profile-menu-item danger" disabled={busy} onClick={()=>choose(onLock)}>{icons.lock}<span>Lock Vault and sign out</span></button>}
   </div>
  </div>}
  <button ref={button} type="button" data-tour="settings" className="profile-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open?menuId:undefined} title={`${name} · ${vault}`} onClick={()=>setOpen(v=>!v)}>
   <span className="profile-avatar-wrap"><span className="profile-avatar" aria-hidden="true">{initials(name)}</span><i className={'profile-status '+(vaultUnlocked?'unlocked':'locked')} aria-hidden="true"/></span>
   <span className="profile-text"><span className="profile-name">{name}</span><span className="profile-sub">{vault}</span></span>
   <svg className="profile-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 10 8 6.5l3.5 3.5"/></svg>
  </button>
 </div>;
}

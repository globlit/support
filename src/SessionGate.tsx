import {useEffect,useRef,useState,type ReactNode} from 'react';
import {api} from './api';
import {refreshSession,sessionEvent,type BrowserSession} from './session';
import {notifyVaultChange} from './workspace-sync';
/** Preserve the mounted workspace and drafts while reauthentication hides its contents. */
export function SessionGate({children}:{children:ReactNode}){
 const [session,setSession]=useState<BrowserSession|null>(null),[opened,setOpened]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [passphrase,setPassphrase]=useState(''),[confirmation,setConfirmation]=useState('');
 const pending=useRef(false);
 useEffect(()=>{
  let active=true;
  const apply=(e:Event)=>{if(!active)return;const next=(e as CustomEvent<BrowserSession>).detail;setSession(old=>({...old,...next}));if(next.authenticated){setOpened(true);setError('');}};
  const check=async()=>{if(pending.current)return;pending.current=true;try{await refreshSession()}catch{if(active)setError('Support is unavailable. Retry when the server is running.')}finally{pending.current=false}};
  const visible=()=>{if(document.visibilityState==='visible')void check()};
  window.addEventListener(sessionEvent,apply);window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  void check();const timer=setInterval(visible,5000);
  return()=>{active=false;clearInterval(timer);window.removeEventListener(sessionEvent,apply);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible)};
 },[]);
 async function unlock(){
  if(!session)return;if(!session.initialized&&passphrase!==confirmation){setError('The passphrases do not match.');return;}
  setBusy(true);setError('');try{await api('/vault','POST',{action:session.initialized?'unlock':'initialize',passphrase});setPassphrase('');setConfirmation('');await refreshSession();notifyVaultChange(true)}catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 return <>{opened&&<div hidden={!session?.authenticated}>{children}</div>}{!session?.authenticated&&<main className="session-gate"><div className="wordmark">▱ support</div><section className="session-card"><h1>{session?(session.initialized?'Unlock your Vault':'Create your Vault'):'Opening Support…'}</h1><p className="muted">{session?.initialized?'Use your Vault passphrase to sign in to this browser. Your current page will reopen.':session?'Choose a passphrase to protect this workspace and sign in.':''}</p>{session&&<form onSubmit={e=>{e.preventDefault();void unlock()}}><label>Vault passphrase<input autoFocus type="password" autoComplete={session.initialized?'current-password':'new-password'} minLength={12} maxLength={1024} value={passphrase} onChange={e=>setPassphrase(e.target.value)} required disabled={busy}/></label>{!session.initialized&&<label>Confirm passphrase<input type="password" autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} required disabled={busy}/></label>}<button className="primary" disabled={busy}>{busy?'Opening…':session.initialized?'Unlock':'Create Vault'}</button></form>}{error&&<p className="error" role="alert">{error}</p>}{!session&&error&&<button onClick={()=>void refreshSession().catch(()=>{})}>Retry connection</button>}</section></main>}</>;
}

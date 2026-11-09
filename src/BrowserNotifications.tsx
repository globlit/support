import {useState} from 'react';
import {api} from './api';
import {notificationsSupported} from './browser-notifications';

/** Settings section that requests the browser permission and sends a test notification. */
export function BrowserNotifications({unlocked,dirty}:{unlocked:boolean;dirty:boolean}){
 const supported=notificationsSupported();
 const [permission,setPermission]=useState<NotificationPermission>(supported?Notification.permission:'denied');
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const [error,setError]=useState('');
 async function allow(){setError('');setMessage('');setPermission(await Notification.requestPermission());}
 async function test(){
  setBusy(true);setError('');setMessage('');
  try{await api('/notifications/test','POST',{});setMessage('Test sent. It appears within 10 seconds.');}
  catch(e){setError(e instanceof Error?e.message:'Could not send the test notification.');}
  finally{setBusy(false);}
 }
 return <section className="browser-notifications" aria-label="Browser notifications">
  <div className="heading"><div><h3>Notify this browser</h3><p className="small muted">Support shows desktop notifications for reviews, blocked work and updates while a Support tab is open in this browser, including a background tab.</p></div></div>
  {!supported?<p className="small muted">This browser does not support notifications.</p>
   :permission==='granted'?<p className="small">Notifications are allowed in this browser.</p>
   :permission==='denied'?<p className="small">Notifications are blocked for this site. Allow them in the browser's site settings, then reload Support.</p>
   :<div className="actions"><button type="button" onClick={()=>void allow()}>Allow notifications</button></div>}
  {supported&&permission==='granted'&&<div className="actions"><button type="button" disabled={busy||!unlocked||dirty} onClick={()=>void test()}>Send test notification</button></div>}
  {dirty&&<p className="small muted">Save your notification preferences before testing.</p>}
  {error&&<p role="alert" className="error">{error}</p>}{message&&<p role="status" className="small">{message}</p>}
  <p className="small muted">Delivery pauses when the Vault is locked. Clicking a notification opens Support. Approvals stay in the app.</p>
 </section>;
}

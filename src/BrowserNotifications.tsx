import {useState} from 'react';
import {api} from './api';
import {notificationsSupported} from './browser-notifications';
import {useFeedback} from './Toasts';

/** Settings section that requests the browser permission and sends a test notification. */
export function BrowserNotifications({unlocked,dirty}:{unlocked:boolean;dirty:boolean}){
 const supported=notificationsSupported();
 const [permission,setPermission]=useState<NotificationPermission>(supported?Notification.permission:'denied');
 const [busy,setBusy]=useState(false);
 const feedback=useFeedback();
 async function allow(){setPermission(await Notification.requestPermission());}
 async function test(){
  setBusy(true);
  try{await api('/notifications/test','POST',{});feedback.success('Test sent. It appears within 10 seconds.');}
  catch(e){feedback.error(e instanceof Error?e:'Could not send the test notification.');}
  finally{setBusy(false);}
 }
 return <section className="browser-notifications" aria-label="Browser notifications">
  <div className="heading"><div><h3>Notify this browser</h3><p className="small muted">Support shows desktop notifications for reviews, blocked work and updates while a Support tab is open in this browser but not in front, for example in a background tab or behind another window.</p></div></div>
  {!supported?<p className="small muted">This browser does not support notifications.</p>
   :permission==='granted'?<p className="small">Notifications are allowed in this browser.</p>
   :permission==='denied'?<p className="small">Notifications are blocked for this site. Allow them in the browser's site settings, then reload Support.</p>
   :<div className="actions"><button type="button" onClick={()=>void allow()}>Allow notifications</button></div>}
  {supported&&permission==='granted'&&<div className="actions"><button type="button" disabled={busy||!unlocked||dirty} onClick={()=>void test()}>Send test notification</button></div>}
  {dirty&&<p className="small muted">Save your notification preferences before testing.</p>}
  <p className="small muted">Bursts are grouped into one summary, and Support notifies at most once a minute. Delivery pauses when the Vault is locked. Clicking a notification opens Support. Approvals stay in the app.</p>
 </section>;
}

import {useEffect} from 'react';
import {api} from './api';

type NotificationPage={seq:number;paused:boolean;reason?:string;events:{id:string;seq:number;at:number;title:string;body:string;route:string}[]};
const seqKey='support.notifications.seq';

/** True when this browser provides the Notification API. */
export function notificationsSupported(){return typeof window!=='undefined'&&'Notification' in window;}

function storedSeq(){
 try{const value=localStorage.getItem(seqKey);const seq=value===null?NaN:Number(value);return Number.isInteger(seq)&&seq>=0?seq:undefined;}catch{return undefined;}
}
function storeSeq(seq:number){try{localStorage.setItem(seqKey,String(seq));}catch{/* The next poll starts from the latest notification. */}}

/**
 * Polls Support every 10 seconds while `unlocked` is true and the browser permission is granted.
 * Shows each new notification once per browser. The first poll in a browser only records the latest
 * notification, so older work does not produce notifications. Clicking a notification opens its page.
 */
export function useBrowserNotifications(unlocked:boolean){
 useEffect(()=>{
  if(!unlocked||!notificationsSupported())return;
  let live=true,busy=false;
  const poll=async()=>{
   if(busy||Notification.permission!=='granted')return;
   busy=true;
   try{
    const after=storedSeq();
    const page=await api<NotificationPage>('/notifications'+(after===undefined?'':'?after='+after));
    if(!live)return;
    for(const event of page.events){
     // The tag stops other open Support tabs from showing the same notification twice.
     const shown=new Notification(event.title,{body:event.body,tag:event.id});
     shown.onclick=()=>{window.focus();location.hash=event.route;shown.close();};
    }
    storeSeq(page.seq);
   }catch{/* Retry on the next interval. */}finally{busy=false;}
  };
  void poll();
  const timer=setInterval(()=>void poll(),10000);
  return ()=>{live=false;clearInterval(timer);};
 },[unlocked]);
}

import {useEffect} from 'react';
import {api} from './api';
import {routeHash} from './navigation';

type NotificationEvent={id:string;seq:number;at:number;title:string;body:string;route:string};
type NotificationPage={seq:number;paused:boolean;reason?:string;events:NotificationEvent[]};
/** Desktop notification to show: its title, body, tag and the route a click opens. */
export type Delivery={title:string;body:string;tag:string;route:string};
const seqKey='support.notifications.seq',lastShownKey='support.notifications.lastShown';
/** Events per server page, pages fetched per poll (the server keeps 500 events), and summary settings. */
const pageSize=20,maxPages=25,maxBuffered=500,summaryThreshold=3,summaryLines=4;
/** Minimum time between two notifications, across all Support tabs in this browser. */
export const minimumGapMs=60_000;

/** True when this browser provides the Notification API. */
export function notificationsSupported(){return typeof window!=='undefined'&&'Notification' in window;}

function storedSeq(){
 try{const value=localStorage.getItem(seqKey);const seq=value===null?NaN:Number(value);return Number.isInteger(seq)&&seq>=0?seq:undefined;}catch{return undefined;}
}
function storeSeq(seq:number){try{localStorage.setItem(seqKey,String(seq));}catch{/* The next poll starts from the latest notification. */}}
const frontKey='support.notifications.front',frontMs=15000;
/** True when this tab is visible and focused. The tab in front records the time, so other Support tabs in this browser also skip notifications. */
function supportInFront(){
 if(document.visibilityState==='visible'&&document.hasFocus()){try{localStorage.setItem(frontKey,String(Date.now()));}catch{/* Only this tab skips. */}return true;}
 try{return Date.now()-Number(localStorage.getItem(frontKey))<frontMs;}catch{return false;}
}
function leaveFront(){if(document.visibilityState!=='visible'||!document.hasFocus()){try{localStorage.removeItem(frontKey);}catch{/* The record expires after 15 seconds. */}}}

/** True when no Support tab in this browser showed a notification during the last `minimumGapMs`. */
export function gapElapsed(now=Date.now()){
 try{const last=Number(localStorage.getItem(lastShownKey));return !Number.isFinite(last)||now-last>=minimumGapMs;}catch{return true;}
}
/** Records that a notification was shown at `now`, for every Support tab in this browser. */
export function markShown(now=Date.now()){try{localStorage.setItem(lastShownKey,String(now));}catch{/* This tab still waits for its next poll. */}}

/**
 * Returns the notifications for one batch of events.
 * Up to 3 events produce one notification each. More events produce one summary that counts events per title,
 * most frequent first, without ticket keys or titles. `incomplete` marks a batch that may be missing older events.
 */
export function deliveryPlan(events:NotificationEvent[],incomplete=false):Delivery[]{
 if(events.length<=summaryThreshold&&!incomplete)return events.map(e=>({title:e.title,body:e.body,tag:e.id,route:e.route}));
 const counts=new Map<string,number>();
 for(const e of events)counts.set(e.title,(counts.get(e.title)??0)+1);
 const groups=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 const lines=groups.slice(0,summaryLines).map(([title,count])=>`${count} · ${title}`);
 if(groups.length>summaryLines)lines.push(`and ${groups.length-summaryLines} more types`);
 // One tag for all summaries: a newer summary replaces the previous one instead of stacking.
 return [{title:`${events.length}${incomplete?'+':''} updates in Support`,body:lines.join('\n'),tag:'support-summary',route:routeHash({page:'ai',step:'waiting'})}];
}

/**
 * Polls Support every 10 seconds while `unlocked` is true and the browser permission is granted.
 * Each poll reads every new notification event. Events wait in a buffer until no Support tab in this browser has shown a
 * notification for `minimumGapMs`. Then up to 3 waiting events are shown one by one, and more are grouped into one summary.
 * While a Support tab in this browser is visible and focused, waiting events are dropped, not delayed.
 * The first poll in a browser only records the latest event, so older work does not produce notifications.
 * Clicking a notification opens its page.
 */
export function useBrowserNotifications(unlocked:boolean){
 useEffect(()=>{
  if(!unlocked||!notificationsSupported())return;
  let live=true,busy=false,buffer:NotificationEvent[]=[],incomplete=false;
  const poll=async()=>{
   if(busy||Notification.permission!=='granted')return;
   busy=true;
   try{
    let after=storedSeq();
    for(let pages=1;pages<=maxPages;pages++){
     const page=await api<NotificationPage>('/notifications'+(after===undefined?'':'?after='+after));
     if(!live)return;
     buffer.push(...page.events);storeSeq(page.seq);
     if(after===undefined||page.events.length<pageSize)break;
     if(pages===maxPages)incomplete=true;
     after=page.seq;
    }
    if(buffer.length>maxBuffered){buffer=buffer.slice(-maxBuffered);incomplete=true;}
    // The person is already looking at Support, so the workspace shows the change.
    if(supportInFront()){buffer=[];incomplete=false;return;}
    if(!buffer.length||!gapElapsed())return;
    for(const delivery of deliveryPlan(buffer,incomplete)){
     // The tag stops other open Support tabs from showing the same notification twice.
     const shown=new Notification(delivery.title,{body:delivery.body,tag:delivery.tag});
     shown.onclick=()=>{window.focus();location.hash=delivery.route;shown.close();};
    }
    markShown();buffer=[];incomplete=false;
   }catch{/* Retry on the next interval. */}finally{busy=false;}
  };
  void poll();
  const timer=setInterval(()=>void poll(),10000);
  const front=()=>void supportInFront();
  window.addEventListener('focus',front);window.addEventListener('blur',leaveFront);document.addEventListener('visibilitychange',leaveFront);
  return ()=>{live=false;clearInterval(timer);window.removeEventListener('focus',front);window.removeEventListener('blur',leaveFront);document.removeEventListener('visibilitychange',leaveFront);};
 },[unlocked]);
}

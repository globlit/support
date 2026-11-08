import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api';
import type {Snapshot} from './model';
import {WorkspaceSync,vaultEvent} from './workspace-sync';

export function useWorkspace(){
 const [data,setData]=useState<Snapshot|null>(null),[loadError,setLoadError]=useState('');
 const sync=useRef<WorkspaceSync|null>(null);
 useEffect(()=>{
  const controller=new WorkspaceSync(()=>api<Snapshot>('/state'),next=>{setData(previous=>previous&&previous.configRevision===next.configRevision&&JSON.stringify(previous.vault)===JSON.stringify(next.vault)?previous:next);setLoadError('');},()=>setData(previous=>previous?{...previous,vault:{...previous.vault,unlocked:false}}:previous));
  sync.current=controller;
  let active=true,polling=false;
  async function refresh(){if(polling)return;polling=true;try{await controller.refresh()}catch(e){if(active)setLoadError((e as Error).message)}finally{polling=false}}
  const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('support-vault'):null;
  const changed=(unlocked:boolean)=>{if(!unlocked)controller.locked();void refresh()};
  const local=(event:Event)=>{const unlocked=(event as CustomEvent).detail?.unlocked;if(typeof unlocked!=='boolean')return;changed(unlocked);channel?.postMessage({unlocked});};
  if(channel)channel.onmessage=event=>{if(typeof event.data?.unlocked==='boolean')changed(event.data.unlocked)};
  const visible=()=>{if(document.visibilityState==='visible')void refresh()};
  window.addEventListener(vaultEvent,local);window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  void refresh();const timer=setInterval(visible,3000);
  return()=>{active=false;controller.close();channel?.close();clearInterval(timer);window.removeEventListener(vaultEvent,local);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);if(sync.current===controller)sync.current=null;};
 },[]);
 const reload=useCallback(async()=>{if(!sync.current)throw new Error('Workspace is still opening. Try again.');return sync.current.refresh()},[]);
 return {data,setData,reload,loadError};
}

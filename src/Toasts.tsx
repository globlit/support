import {createContext,useCallback,useContext,useMemo,useRef,useState,type ReactNode} from 'react';

export type ToastTone='success'|'info'|'error';
export type ToastInput={tone?:ToastTone;message:string;action?:ReactNode};
type Toast=ToastInput&{id:number;tone:ToastTone;round:number};
/** Visible toasts at most. The oldest is removed first. */
export const toastLimit=4;
const durations:Record<ToastTone,number>={success:5000,info:5000,error:10000};
const ToastContext=createContext<(toast:ToastInput)=>void>(()=>{});

/** Adds a toast. A toast with the same message and tone restarts its timer instead of stacking. Keeps the last `toastLimit`. */
export function addToast(list:Toast[],input:ToastInput,id:number):Toast[]{
 const tone=input.tone??'info',same=list.find(t=>t.message===input.message&&t.tone===tone);
 if(same)return list.map(t=>t===same?{...t,action:input.action,round:t.round+1}:t);
 return [...list,{...input,tone,id,round:0}].slice(-toastLimit);
}

/** Shows short-lived feedback at the top right. The time bar pauses while the pointer is over a toast or it has focus. */
export function ToastProvider({children}:{children:ReactNode}){
 const [toasts,setToasts]=useState<Toast[]>([]),next=useRef(0);
 const toast=useCallback((input:ToastInput)=>{if(input.message)setToasts(list=>addToast(list,input,++next.current));},[]);
 const dismiss=(id:number)=>setToasts(list=>list.filter(t=>t.id!==id));
 return <ToastContext.Provider value={toast}>{children}
  <div className="toasts" aria-live="polite">{toasts.map(t=><div key={t.id} className={'toast '+t.tone} role={t.tone==='error'?'alert':'status'}>
   <div className="toast-body"><span className="toast-message">{t.message}</span>{t.action&&<span className="toast-action">{t.action}</span>}</div>
   <button type="button" className="toast-close" aria-label="Dismiss" onClick={()=>dismiss(t.id)}>×</button>
   <i key={t.round} className="toast-timer" style={{animationDuration:durations[t.tone]+'ms'}} onAnimationEnd={()=>dismiss(t.id)}/>
  </div>)}</div>
 </ToastContext.Provider>;
}
/** Returns the function that shows a toast. */
export function useToast(){return useContext(ToastContext);}
/** Returns helpers for the common cases: a success message and an error from a caught value. */
export function useFeedback(){
 const toast=useToast();
 return useMemo(()=>({success:(message:string)=>toast({tone:'success',message}),error:(e:unknown,action?:ReactNode)=>toast({tone:'error',message:e instanceof Error?e.message:String(e),action}),info:(message:string)=>toast({tone:'info',message})}),[toast]);
}

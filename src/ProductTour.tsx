import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';
import {navigate} from './navigation';
import {tourSteps as steps,ticketStart,type TourScene} from './tour-journey';
import {tourLayout,placeTourCard,tourHighlight,tourScrollDelta,type TourRect} from './tour-layout';
const preference='support.tour.offered.v1';
export function shouldOfferTour(){try{return localStorage.getItem(preference)!=='yes'}catch{return true}}
export function rememberTour(){try{localStorage.setItem(preference,'yes')}catch{/* Browsers without storage can still use the tour. */}}
export function ProductTour({welcome,onClose,onScene}:{welcome:boolean;onClose:()=>void;onScene:(scene:TourScene|null)=>void}){
 const [index,setIndex]=useState(welcome?-1:0),[rect,setRect]=useState<TourRect|null>(null);
 const [size,setSize]=useState({w:window.innerWidth,h:window.innerHeight}),[scroll,setScroll]=useState({up:false,down:false});
 const dialog=useRef<HTMLDivElement>(null),next=useRef<HTMLButtonElement>(null),copy=useRef<HTMLDivElement>(null);
 const touch=useRef<{x:number;y:number}|null>(null),step=index>=0?steps[index]:null;
 const [fallbackKey,setFallbackKey]=useState(''),[contentHeight,setContentHeight]=useState(260);
 const layoutKey=`${index}:${size.w}:${size.h}`;
 const layout=tourLayout(size.w,size.h,fallbackKey===layoutKey,contentHeight);
 const floatingCard=rect&&layout.mode==='floating'?placeTourCard(rect,size.w,size.h,layout.card.width,layout.card.height):null;
 const card=layout.mode==='floating'?(floatingCard??layout.card):{...layout.card,top:layout.mode==='side'&&rect?Math.max(12,Math.min(rect.top,size.h-layout.card.height-12)):layout.card.top};
 useEffect(()=>{rememberTour();const previous=document.activeElement as HTMLElement|null;return()=>{if(previous?.isConnected)previous.focus();else document.querySelector<HTMLButtonElement>('[data-tour="settings"]')?.focus()}},[]);
 useEffect(()=>{const resize=()=>setSize({w:window.innerWidth,h:window.innerHeight});window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);return()=>{window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize)}},[]);
 // Reserve space only for small screens or targets with no adjacent room.
 useLayoutEffect(()=>{
  if(!step)return;const root=document.documentElement,old=root.dataset.tourLayout;
  root.dataset.tourLayout=layout.mode;
  root.style.setProperty('--tour-page-width',layout.context.width+'px');root.style.setProperty('--tour-page-height',layout.context.height+'px');
  return()=>{if(old===undefined)delete root.dataset.tourLayout;else root.dataset.tourLayout=old;root.style.removeProperty('--tour-page-width');root.style.removeProperty('--tour-page-height')};
 },[!!step,layout.mode,layout.context.width,layout.context.height]);
 useLayoutEffect(()=>{if(step&&(layout.mode!=='floating'||floatingCard))next.current?.focus({preventScroll:true})},[index,layout.mode,!!floatingCard]);
 useLayoutEffect(()=>{onScene(step?.scene??null);if(step)navigate(step.route);setRect(null);copy.current?.scrollTo(0,0);next.current?.focus({preventScroll:true});},[index]);
 useEffect(()=>{
  if(!step)return;let frame=0,positioned:Element|null=null,observed:Element|null=null;
  const page=document.querySelector<HTMLElement>('.app');
  const measure=()=>{
   const target=document.querySelector(step.target); // Wait for this screen, never highlight an unrelated sidebar fallback.
   if(target!==observed){if(observed)observer.unobserve(observed);if(target)observer.observe(target);observed=target;}
   let r=target?.getBoundingClientRect();
   if(target&&r&&r.width&&r.height&&positioned!==target){
    positioned=target;
    // Reveal horizontally overflowing board cards as well as vertically long sections.
    target.scrollIntoView({block:r.height>layout.context.height-80?'start':'nearest',inline:'nearest',behavior:'instant'});
    r=target.getBoundingClientRect();page?.scrollBy({top:tourScrollDelta(r,layout.context),behavior:'instant'});r=target.getBoundingClientRect();
   }
   const highlight=r?tourHighlight(r,layout.context):null;
   const panel=dialog.current,body=copy.current;
   if(panel&&body){
    const css=getComputedStyle(panel),top=panel.querySelector('.tour-top')!.getBoundingClientRect().height,controls=panel.querySelector('.tour-controls')!.getBoundingClientRect().height;
    const last=body.lastElementChild as HTMLElement|null;
    const copyHeight=last?last.getBoundingClientRect().bottom-body.getBoundingClientRect().top+body.scrollTop+parseFloat(getComputedStyle(last).marginBottom):0;
    const naturalHeight=Math.ceil(top+copyHeight+controls+parseFloat(css.paddingTop)+parseFloat(css.paddingBottom)+2*parseFloat(css.rowGap)+2);
    setContentHeight(previous=>Math.abs(previous-naturalHeight)>1?naturalHeight:previous);
    const measured=tourLayout(size.w,size.h,false,naturalHeight);
    if(layout.mode==='floating'&&highlight&&!placeTourCard(highlight,size.w,size.h,measured.card.width,measured.card.height))setFallbackKey(layoutKey);
   }
   setRect(previous=>JSON.stringify(previous)===JSON.stringify(highlight)?previous:highlight);
   if(page){const up=page.scrollTop>2,down=page.scrollTop+page.clientHeight<page.scrollHeight-2;setScroll(previous=>previous.up===up&&previous.down===down?previous:{up,down});}
  };
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure)};
  const observer=new ResizeObserver(schedule);if(page)observer.observe(page);if(dialog.current)observer.observe(dialog.current);observer.observe(document.querySelector('.main')??document.body);
  const mutations=new MutationObserver(schedule);mutations.observe(document.querySelector('.main')??document.body,{childList:true,subtree:true});
  window.addEventListener('scroll',schedule,true);schedule();
  return()=>{cancelAnimationFrame(frame);observer.disconnect();mutations.disconnect();window.removeEventListener('scroll',schedule,true)};
 },[index,layout.context.width,layout.context.height,layout.mode,size.w,size.h]);
 function close(){rememberTour();onScene(null);onClose()}
 function scrollPage(y:number,x=0){document.querySelector('.app')?.scrollBy({top:y,left:x,behavior:'instant'})}
 function keyboard(e:KeyboardEvent){
  if(e.key==='Escape'){e.preventDefault();close()}
  if(['PageUp','PageDown'].includes(e.key)&&e.target!==copy.current){e.preventDefault();scrollPage(layout.context.height*.7*(e.key==='PageUp'?-1:1))}
  if(e.key==='Tab'){
   const items=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]'));
   const first=items[0],last=items.at(-1)!;
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  }
 }
 return <div className={'product-tour '+(step?'guided tour-'+layout.mode:'welcome')}>
  {step&&<div className="tour-context-input" style={layout.context} aria-hidden="true" onWheel={e=>scrollPage(e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?layout.context.height:1),e.deltaX)} onTouchStart={e=>{const t=e.touches[0];touch.current={x:t.clientX,y:t.clientY}}} onTouchMove={e=>{const t=e.touches[0];if(touch.current)scrollPage(touch.current.y-t.clientY,touch.current.x-t.clientX);touch.current={x:t.clientX,y:t.clientY}}} onTouchEnd={()=>{touch.current=null}}/>}
  {step&&rect?<div className="tour-spotlight" style={rect} aria-hidden="true"/>:<div className="tour-backdrop" style={step?layout.context:undefined}/>}
  <div ref={dialog} className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-copy" style={step?{...card,visibility:layout.mode==='floating'&&!floatingCard?'hidden':undefined}:undefined} onKeyDown={keyboard}>
   <div className="tour-top"><span>{step?`${step.phase.toUpperCase()} · ${index+1} / ${steps.length}`:'WELCOME TO SUPPORT'}</span><div className="tour-page-controls">{step&&<><button disabled={!scroll.up} aria-label="Scroll page up" title="Scroll page up · Page Up" onClick={()=>scrollPage(-layout.context.height*.7)}>↑</button><button disabled={!scroll.down} aria-label="Scroll page down" title="Scroll page down · Page Down" onClick={()=>scrollPage(layout.context.height*.7)}>↓</button></>}<button className="tour-close" aria-label="Close tour" onClick={close}>×</button></div></div>
   <div className="tour-copy" ref={copy} tabIndex={step?0:undefined} aria-label="Tour explanation">
    <h2 id="tour-title">{step?.title??'A quick look around?'}</h2><p id="tour-copy">{step?.text??'Follow a ticket from setup to resolution: investigate, refine a plan, review changes and send the final reply. The example stays inside this tour.'}</p>
    {index===0&&<button className="text-button tour-skip-setup" onClick={()=>setIndex(ticketStart)}>Already configured? Start with a ticket →</button>}
   </div>
   <div className="tour-controls">{step?<><button className="text-button" onClick={close}>End tour</button><div className="actions"><button disabled={index===0} aria-label="Previous tour step" onClick={()=>setIndex(n=>n-1)}>←</button><button ref={next} className="primary" aria-label={index===steps.length-1?'Finish tour':'Next tour step'} onClick={()=>index===steps.length-1?close():setIndex(n=>n+1)}>{index===steps.length-1?'Finish':'→'}</button></div></>:<><button onClick={close}>Not now</button><button ref={next} className="primary" onClick={()=>setIndex(0)}>Show me around →</button></>}</div>
  </div>
 </div>;
}

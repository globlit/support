export type TourRect={left:number;top:number;width:number;height:number};
export type TourLayout={mode:'floating'|'side'|'bottom';context:TourRect;card:TourRect};
/** Small screens reserve a compact dock; desktop keeps its full page whenever possible. */
export function tourLayout(width:number,height:number,sideFallback=false,contentHeight=260):TourLayout{
 const w=Math.max(1,width),h=Math.max(1,height),margin=Math.min(12,w/20,h/20);
 const small=w<1000||h<550;
 const cardHeight=Math.min(contentHeight,small?Math.min(250,h*.42)-2*margin:Math.min(360,h-2*margin));
 if(small){
  const dock=cardHeight+2*margin;
  return {mode:'bottom',context:{left:0,top:0,width:w,height:h-dock},card:{left:margin,top:h-dock+margin,width:w-2*margin,height:cardHeight}};
 }
 const rail=384;
 return {mode:sideFallback?'side':'floating',context:{left:0,top:0,width:sideFallback?w-rail:w,height:h},card:{left:w-rail+margin,top:margin,width:rail-2*margin,height:cardHeight}};
}
/** Try adjacent spaces without ever clamping a card across the highlighted element. */
export function placeTourCard(target:TourRect,width:number,height:number,cardWidth:number,cardHeight:number):TourRect|null{
 const margin=12,gap=18,clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(n,max));
 const y=clamp(target.top,margin,height-cardHeight-margin),x=clamp(target.left,margin,width-cardWidth-margin);
 const candidates=[
  {left:target.left+target.width+gap,top:y},
  {left:target.left-cardWidth-gap,top:y},
  {left:x,top:target.top+target.height+gap},
  {left:x,top:target.top-cardHeight-gap},
 ];
 const fit=candidates.find(c=>c.left>=margin&&c.top>=margin&&c.left+cardWidth<=width-margin&&c.top+cardHeight<=height-margin);
 return fit?{...fit,width:cardWidth,height:cardHeight}:null;
}
export function tourHighlight(target:TourRect,context:TourRect,padding=5):TourRect|null{
 const left=Math.max(context.left+4,target.left-padding),top=Math.max(context.top+4,target.top-padding);
 const right=Math.min(context.left+context.width-4,target.left+target.width+padding),bottom=Math.min(context.top+context.height-4,target.top+target.height+padding);
 return right>left&&bottom>top?{left,top,width:right-left,height:bottom-top}:null;
}
/** Keep a little preceding context; tall sections start at the top instead of halfway through. */
export function tourScrollDelta(target:TourRect,context:TourRect){
 const inset=Math.min(48,context.height*.12),visible=context.height-2*inset;
 if(target.top<context.top+inset||target.top+target.height>context.top+context.height-inset)
  return target.top-context.top-(target.height>visible?inset:Math.max(inset,(context.height-target.height)/2));
 return 0;
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tourLayout,placeTourCard,tourHighlight,tourScrollDelta,type TourRect} from '../src/tour-layout';
const intersects=(a:TourRect,b:TourRect)=>a.left<b.left+b.width&&a.left+a.width>b.left&&a.top<b.top+b.height&&a.top+a.height>b.top;
test('small screens reserve a compact bottom dock; desktop retains the full page',()=>{
 for(const [w,h] of [[1920,1080],[1280,720],[1024,768],[768,1024],[390,844],[320,568],[844,390],[320,240]]){
  const {mode,context,card}=tourLayout(w,h);
  if(w>=1000&&h>=550){assert.equal(mode,'floating');assert.equal(context.width,w);assert.equal(context.height,h);assert.ok(card.height<=360);}
  else {assert.equal(mode,'bottom');assert.equal(intersects(context,card),false);assert.ok(card.height<=226);assert.ok(context.height>=h*.57);}
  for(const r of [context,card]){assert.ok(r.left>=0&&r.top>=0&&r.width>0&&r.height>0);assert.ok(r.left+r.width<=w&&r.top+r.height<=h);}
 }
 assert.ok(tourLayout(390,844,false,180).card.height<tourLayout(390,844,false,260).card.height);
});
test('desktop placement finds adjacent space on all four sides without obscuring the target',()=>{
 const targets=[{left:100,top:100,width:200,height:600},{left:900,top:100,width:200,height:600},{left:10,top:30,width:1260,height:100},{left:10,top:600,width:1260,height:100}];
 for(const t of targets){const c=placeTourCard(t,1280,720,360,250);assert.ok(c);assert.equal(intersects(t,c),false);assert.ok(c.left>=12&&c.top>=12&&c.left+c.width<=1268&&c.top+c.height<=708);}
 assert.equal(placeTourCard({left:10,top:10,width:1260,height:700},1280,720,360,250),null);
});
test('large desktop targets use a compact side fallback, never a full-height guide',()=>{
 const {mode,context,card}=tourLayout(1280,720,true,220);
 assert.equal(mode,'side');assert.equal(intersects(context,card),false);assert.equal(card.height,220);assert.ok(context.width>=896);
});
test('spotlight stays inside the page for bottom and side layouts',()=>{
 for(const [w,h] of [[1920,1080],[1280,720],[390,844],[844,390]]){
  const {context,card}=tourLayout(w,h,true);
  for(const target of [{left:0,top:0,width:w,height:3000},{left:200,top:250,width:600,height:500},{left:-100,top:-100,width:500,height:300}]){
   const highlight=tourHighlight(target,context);if(highlight){assert.equal(intersects(highlight,card),false);assert.ok(highlight.top>=context.top);assert.ok(highlight.top+highlight.height<=context.height);assert.ok(highlight.left+highlight.width<=context.width);}
  }
 }
});
test('long sections start near their heading while short visible controls retain their context',()=>{
 const context=tourLayout(390,844).context;
 assert.equal(tourScrollDelta({left:0,top:80,width:200,height:40},context),0);
 const large={left:0,top:800,width:300,height:1300};const delta=tourScrollDelta(large,context);assert.ok(large.top-delta>=32&&large.top-delta<=48);
 const bottom={left:0,top:context.height-20,width:200,height:60};const d=tourScrollDelta(bottom,context);assert.ok(bottom.top-d+bottom.height<context.height-40);
});

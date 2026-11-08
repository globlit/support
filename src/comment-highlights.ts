import type {PlanAnnotation} from './model';
type Tree={type:string;value?:string;tagName?:string;properties?:Record<string,unknown>;children?:Tree[]};
export function commentRanges(text:string,annotations:PlanAnnotation[]){
 let normalized='',positions:number[]=[];
 for(let i=0;i<text.length;i++){const ch=/\s/.test(text[i])?' ':text[i];if(ch===' '&&normalized.endsWith(' '))continue;normalized+=ch;positions.push(i)}
 const normalize=(value:string)=>value.replace(/\s+/g,' ').trim();
 const ranges:{start:number;end:number}[]=[];
 for(const annotation of annotations){
  const quote=normalize(annotation.quote);if(!quote)continue;
  const {start,end}=annotation;
  if(start!==undefined&&end!==undefined&&start>=0&&end>start&&end<=text.length&&normalize(text.slice(start,end))===quote){ranges.push({start,end});continue}
  const at=normalized.indexOf(quote);if(at>=0)ranges.push({start:positions[at],end:positions[at+quote.length-1]+1});
 }
 const merged:{start:number;end:number}[]=[];
 for(const range of ranges.sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range})}
 return merged;
}
export function highlightComments(annotations:PlanAnnotation[]){return ()=> (tree:Tree)=>{
 const nodes:Tree[]=[];
 function collect(node:Tree){if(node.type==='text')nodes.push(node);else node.children?.forEach(collect)}collect(tree);
 const ranges=commentRanges(nodes.map(n=>n.value??'').join(''),annotations);let offset=0;
 function visit(parent:Tree){if(!parent.children)return;parent.children=parent.children.flatMap(node=>{
  if(node.type!=='text'){visit(node);return [node]}
  const text=node.value??'',start=offset;offset+=text.length;let cursor=0;const parts:Tree[]=[];
  for(const range of ranges){const from=Math.max(range.start,start)-start,to=Math.min(range.end,offset)-start;if(to<=from)continue;if(from>cursor)parts.push({type:'text',value:text.slice(cursor,from)});parts.push({type:'element',tagName:'mark',properties:{className:['comment-highlight'],title:'This passage has plan comments'},children:[{type:'text',value:text.slice(from,to)}]});cursor=to}
  if(cursor===0)return [node];if(cursor<text.length)parts.push({type:'text',value:text.slice(cursor)});return parts;
 })}visit(tree);
}}

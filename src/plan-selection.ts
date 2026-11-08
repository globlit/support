// Preserve formatting from the app's already-sanitized Markdown DOM. No HTML is
// saved or rendered, and arbitrary attributes / URLs are never copied.
export function selectionMarkdown(selection:Selection):string{
 const range=selection.getRangeAt(0),fragment=range.cloneContents();
 const escape=(text:string)=>text.replace(/([\\`*_{}\[\]<>])/g,'\\$1');
 const plain=(node:Node)=>node.textContent??'';
 function render(node:Node):string{
  if(node.nodeType===Node.TEXT_NODE)return escape(plain(node));
  if(!(node instanceof Element))return Array.from(node.childNodes).map(render).join('');
  const tag=node.tagName.toLowerCase(),inner=Array.from(node.childNodes).map(render).join('');
  if(tag==='strong'||tag==='b')return '**'+inner+'**';
  if(tag==='em'||tag==='i')return '*'+inner+'*';
  if(tag==='del')return '~~'+inner+'~~';
  if(tag==='pre'){const content=plain(node);const fence='`'.repeat(Math.max(3,...(content.match(/`+/g)??[]).map(v=>v.length+1)));return '\n\n'+fence+'\n'+content+'\n'+fence+'\n\n'}
  if(tag==='code'){const content=plain(node),fence='`'.repeat(Math.max(1,...(content.match(/`+/g)??[]).map(v=>v.length+1)));return fence+' '+content+' '+fence}
  if(tag==='br')return '\n';
  if(tag==='input'&&node.getAttribute('type')==='checkbox')return node.hasAttribute('checked')?'[x] ':'[ ] ';
  if(tag==='li')return '\n'+(node.parentElement?.tagName==='OL'?'1. ':'- ')+inner.trim()+'\n';
  if(['ul','ol','p','div'].includes(tag))return '\n'+inner+'\n';
  if(/^h[1-6]$/.test(tag))return '\n'+ '#'.repeat(Number(tag[1]))+' '+inner+'\n';
  return inner;
 }
 let result=render(fragment).trim();
 // A range within one text node does not clone its formatting ancestors.
 let ancestor=range.commonAncestorContainer instanceof Element?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;
 while(ancestor&&!ancestor.classList.contains('markdown')){
  const tag=ancestor.tagName.toLowerCase();
  if(tag==='strong'||tag==='b')result='**'+result+'**';
  if(tag==='em'||tag==='i')result='*'+result+'*';
  if(tag==='code'){const raw=selection.toString(),fence='`'.repeat(Math.max(1,...(raw.match(/`+/g)??[]).map(v=>v.length+1)));result=fence+' '+raw+' '+fence;break}
  ancestor=ancestor.parentElement;
 }
 return result.length<=12000?result:escape(selection.toString().slice(0,3000));
}

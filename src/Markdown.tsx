import {SafeLink} from './SafeLink';
import {highlightComments} from './comment-highlights';
import type {PlanAnnotation} from './model';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Render untrusted source text without HTML, embedded resources or app-relative links.
export function safeMarkdownURL(value:string){
 try {const url=new URL(value);return ['https:','http:','mailto:'].includes(url.protocol)?value:'';}catch{return '';}
}
export function Markdown({children,className='',annotations=[]}:{children:string;className?:string;annotations?:PlanAnnotation[]}){
 return <div className={`markdown ${className}`}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={annotations.length?[highlightComments(annotations)]:[]} skipHtml urlTransform={safeMarkdownURL} components={{
  a:({href,children})=>href?<SafeLink href={href} target="_blank" rel="noopener noreferrer">{children}</SafeLink>:<span>{children}</span>,
  img:({alt})=><span className="muted">[Image: {alt||'attachment'}]</span>,
  input:({checked})=><input type="checkbox" checked={!!checked} disabled aria-label={checked?'Completed task':'Incomplete task'}/>,
  table:({children})=><div className="markdown-table"><table>{children}</table></div>,
 }}>{children}</ReactMarkdown></div>;
}
export function MarkdownPreview({text}:{text:string}){return <details className="markdown-preview"><summary>Preview formatting</summary>{text.trim()?<Markdown>{text}</Markdown>:<p className="small muted">Write some Markdown to preview it here.</p>}</details>}

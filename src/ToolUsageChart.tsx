import {useState} from 'react';
import type {ToolCount} from './tool-usage';

/**
 * Horizontal bar chart of tool calls by tool: shell commands by program, Support tools by integration. Shows the 10
 * most used tools and folds the rest into "other". Each bar shows its count; hover or focus shows the failed calls
 * and the share. An exact-count table is available below the chart.
 */
export function ToolUsageChart({counts,title='Tool calls',compact=false}:{counts:ToolCount[];title?:string;compact?:boolean}){
 const [hover,setHover]=useState<string|null>(null);
 const total=counts.reduce((n,c)=>n+c.total,0);
 if(!total)return <section className={'chart-panel tool-chart'+(compact?' compact':'')}><header><h2>{title}</h2></header><p className="small muted">No tool calls recorded.</p></section>;
 const top=counts.slice(0,10),rest=counts.slice(10);
 const rows=rest.length?[...top,{label:`other (${rest.length})`,total:rest.reduce((n,c)=>n+c.total,0),failed:rest.reduce((n,c)=>n+c.failed,0)}]:top;
 const max=Math.max(...rows.map(r=>r.total));
 const failed=counts.reduce((n,c)=>n+c.failed,0);
 return <section className={'chart-panel tool-chart'+(compact?' compact':'')}>
  <header><h2>{title}</h2><span className="small muted">{total.toLocaleString()} calls{failed?` · ${failed} failed`:''}</span></header>
  <ul className="tool-bars" aria-label={`${title}, by tool`}>
   {rows.map(r=>{const share=Math.round(r.total/total*100),detail=`${r.label}: ${r.total} call${r.total===1?'':'s'}${r.failed?`, ${r.failed} failed`:''}, ${share}% of calls`;
    return <li key={r.label} tabIndex={0} aria-label={detail} onMouseEnter={()=>setHover(r.label)} onMouseLeave={()=>setHover(h=>h===r.label?null:h)} onFocus={()=>setHover(r.label)} onBlur={()=>setHover(h=>h===r.label?null:h)}>
     <span className="tool-bar-label" title={r.label}>{r.label}</span>
     <span className="tool-bar-track"><span className="tool-bar" style={{width:`${Math.max(2,r.total/max*100)}%`}}/></span>
     <span className="tool-bar-value">{r.total}</span>
     {hover===r.label&&<span className="tool-bar-tip" role="tooltip"><strong>{r.label}</strong>{r.total} call{r.total===1?'':'s'} · {share}%{r.failed?` · ${r.failed} failed`:''}</span>}
    </li>;})}
  </ul>
  <details className="chart-data"><summary>Exact counts</summary><div className="table-wrap"><table><thead><tr><th>Tool</th><th>Calls</th><th>Failed</th></tr></thead><tbody>{counts.map(c=><tr key={c.label}><td><code>{c.label}</code></td><td>{c.total}</td><td>{c.failed||'–'}</td></tr>)}</tbody></table></div></details>
 </section>;
}

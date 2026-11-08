export function RefreshButton({label,disabled,refreshing,onClick}:{label:string;disabled?:boolean;refreshing?:boolean;onClick:()=>void}){
 return <button type="button" className="refresh-button" aria-label={label} title={label} disabled={disabled||refreshing} aria-busy={refreshing} onClick={onClick}>
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M19.3 12a7.5 7.5 0 1 0-1.9 5.1M20 12l-2.7-5"/></svg>
 </button>;
}

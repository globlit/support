import {WorkBoard} from './WorkBoard';
import {alertPlacement} from './board-model';
import {cachedList,rememberList} from './list-cache';
import {SafeLink} from './SafeLink';
import {RecoveryState,vaultRecovery} from './RecoveryState';
import {IncomingWorkspace} from './IncomingWorkspace';
import {handlingLabel} from './intake-model';
import {ErrorNotice} from './ErrorNotice';
import {RefreshButton} from './RefreshButton';
import {useSavedFilter} from './saved-filters';
import {useRouteChoice} from './navigation-hooks';
import {IgnoreRules} from './IgnoreRules';
import {ColumnFilter,filterOptions} from './ColumnFilter';
import {useWorkspaceNavigation} from './WorkspaceRuntime';
import {Select} from './Select';
import {useEffect,useRef,useState} from 'react';
import {useWorkspaceApi} from './WorkspaceRuntime';
import type {AlertDetail,AlertQueue,Snapshot,AlertCase} from './model';

function stage(c:AlertQueue['cases'][number]){
 if(c.ignored&&c.ignored>=c.members.length)return 'Ignored';
 if(c.session.handling&&c.session.handling.mode!=='investigate')return handlingLabel(c.session.handling.mode);
 if(c.ticketCreation?.state==='pending')return 'Needs attention';
 if(!c.active)return 'Not firing';
 if(c.run?.state==='running')return 'Investigating';
 if(c.run?.state==='failed'||c.run?.state==='cancelled')return 'Needs attention';
 if(c.ticketCreation?.state==='draft')return 'Review';
 if(c.session.approval)return 'Approved';
 if(c.session.pendingRevision)return 'Revision requested';
 if(c.session.plans.length)return 'Review';
 return 'Backlog';
}
export function Alerts({data,openTicket,initialAlert}:{initialAlert?:string;data:Snapshot;openTicket:(ticket:NonNullable<AlertCase['ticket']>)=>void}){const {navigate,readRoute}=useWorkspaceNavigation();const api=useWorkspaceApi();
 const filterScope='alerts:'+data.config.connections.Alertmanager.endpoint+':'+data.config.alerting.groupBy;
 const [titleFilter,setTitleFilter]=useSavedFilter<string>(filterScope+'.title',''),[instances,setInstances]=useSavedFilter<string[]>(filterScope+'.instances',[]),[links,setLinks]=useSavedFilter<string[]>(filterScope+'.links',[]);
 const ticketLabel=(c:AlertQueue['cases'][number])=>c.ticket?.key??(c.ticketCreation?.state==='pending'?'Checking creation':c.ticketCreation?.state==='draft'?'Draft to review':'Not linked');
 const [queue,setQueue]=useState<AlertQueue|null>(()=>data.vault.unlocked?cachedList<AlertQueue>('alerts:'+data.configRevision)??null:null),[detail,setDetail]=useState<AlertDetail|null>(null);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[search,setSearch]=useSavedFilter<string>(filterScope+'.search',''),[severity,setSeverity]=useSavedFilter<string>(filterScope+'.severity','all'),[state,setState]=useSavedFilter<string>(filterScope+'.state','all'),[view,setView]=useRouteChoice('section',['list','board','rules'],'list');
 useEffect(()=>{const sync=()=>{if(!readRoute().issue)setDetail(null)};window.addEventListener('support:navigate',sync);window.addEventListener('popstate',sync);return()=>{window.removeEventListener('support:navigate',sync);window.removeEventListener('popstate',sync)}},[]);
 const seq=useRef(0);
 async function refreshQueue(){const q=await api<AlertQueue>('/alerts');rememberList('alerts:'+data.configRevision,q);setQueue(q);}
 useEffect(()=>{setError('');setDetail(null);if(!data.vault.unlocked){setQueue(null);return;}let stopped=false;setQueue(q=>q??cachedList<AlertQueue>('alerts:'+data.configRevision)??null);async function read(){try{const q=await api<AlertQueue>('/alerts');rememberList('alerts:'+data.configRevision,q);if(!stopped){setQueue(q);setError('');}}catch(e){if(!stopped)setError((e as Error).message);}}void read();const timer=setInterval(()=>void read(),5000);setDetail(null);return()=>{stopped=true;clearInterval(timer);seq.current++;};},[data.configRevision,data.vault.unlocked]);
 async function run(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();await refreshQueue();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function open(id:string){const n=++seq.current;const d=await api<AlertDetail>('/alerts/'+id);if(n===seq.current){setDetail(d);const route=readRoute();if(route.issue!==id)navigate({page:'alerts',issue:id});}}

 useEffect(()=>{if(initialAlert&&initialAlert!==detail?.issue.id&&data.vault.unlocked)void run(()=>open(initialAlert));},[initialAlert,data.vault.unlocked,data.configRevision]);
 const rows=(queue?.cases??[]).filter(c=>c.title.toLowerCase().includes(titleFilter.toLowerCase())&&(!instances.length||instances.includes(String(c.members.length)))&&(!links.length||links.includes(ticketLabel(c)))&&(severity==='all'||c.severity===severity)&&(state==='all'||stage(c)===state)&&JSON.stringify([c.title,c.labels]).toLowerCase().includes(search.toLowerCase()));
 const choose=(id:string)=>{void run(()=>open(id));};
 const pollingLabel=!queue?'Checking polling':queue.paused?'Polling paused · Vault locked':!queue.enabled?'Polling off':queue.error?'Polling failed':queue.polling?'Polling now':`Polling every ${queue.pollSeconds}s`;
 const pollingState=queue?.error?'error':queue?.enabled&&!queue.paused&&queue.lastSuccess?'active':'paused';
 const refresh=<RefreshButton label={detail?'Refresh alert case':'Refresh alerts'} refreshing={busy||(!detail&&queue?.polling)} disabled={detail?!data.vault.unlocked:!queue?.enabled||queue.paused} onClick={()=>void run(async()=>{if(detail)await open(detail.issue.id);else setQueue(await api<AlertQueue>('/alerts/poll','POST',{}));})}/>;
 if(!data.vault.unlocked)return <div className="page"><div className="heading"><h1>Alerts</h1></div><RecoveryState recovery={vaultRecovery(data.vault,'resume alert polling and review cases')}/></div>;
 if(!data.config.connections.Alertmanager.enabled||!data.config.connections.Alertmanager.endpoint.trim())return <div className="page"><div className="heading"><h1>Alerts</h1></div><RecoveryState recovery={{title:'Set up Alertmanager',message:'Add the base URL and turn on polling in Alertmanager settings. A token is only needed if your endpoint requires one.',action:'Open Alertmanager settings',route:{page:'settings',section:'Connections',tool:'Alertmanager'}}}/></div>;
 return <div className="page"><div className="heading"><div><div className="alert-title"><h1>{detail?detail.issue.title:'Alerts'}</h1><span className="polling-indicator" tabIndex={0} aria-label={pollingLabel} aria-describedby="polling-status"><i className={'polling-dot '+pollingState}/><span role="tooltip" id="polling-status"><strong>{pollingLabel}</strong>{queue?.enabled&&(queue.paused||queue.error||queue.polling)&&<span>Interval · {queue.pollSeconds}s</span>}<span>{queue?.lastSuccess?`Last checked ${new Date(queue.lastSuccess).toLocaleString()}`:'No successful check yet'}</span></span></span></div>{detail&&<p className="subtitle">{detail.issue.key}</p>}</div>{detail&&refresh}</div>
 {(error||queue?.error)&&<ErrorNotice message={error||queue?.error||''} context="Alertmanager" detail="Previously seen alerts are kept; their current state may be stale."/>}
 {busy&&<p role="status" className="muted">Reading sources and saving local work…</p>}
 {!detail&&<><div className="queue-toolbar"><div className="queue-search">{view!=='rules'&&<input type="search" aria-label="Search alerts" placeholder="Filter alerts…" value={search} onChange={e=>setSearch(e.target.value)}/>}</div><div className="actions"><div className="segmented"><button aria-pressed={view==='list'} onClick={()=>setView('list')}>List</button><button aria-pressed={view==='board'} onClick={()=>setView('board')}>Board</button><button aria-pressed={view==='rules'} onClick={()=>setView('rules')}>Ignore rules</button></div>{refresh}</div></div>
 {view==='board'&&<div className="alert-board-filters"><Select aria-label="Alert severity" value={severity} onChange={e=>setSeverity(e.target.value)}><option value="all">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option></Select><Select aria-label="Alert work state" value={state} onChange={e=>setState(e.target.value)}><option value="all">All states</option>{['Choose next step','Create a ticket','Backlog','Investigating','Review','Revision requested','Approved','Needs attention','Engineer handling','Refused','Resolved by engineer','Ignored','Not firing'].map(v=><option key={v}>{v}</option>)}</Select></div>}
 {view!=='rules'&&(titleFilter||instances.length>0||links.length>0||severity!=='all'||state!=='all')&&<div className="list-filter-summary"><span>{rows.length} matching alerts</span><button className="text-button" onClick={()=>{setTitleFilter('');setInstances([]);setLinks([]);setSeverity('all');setState('all')}}>Clear column filters</button></div>}
 {view==='rules'?<IgnoreRules source="alert"/>:view==='list'?<div className="table-wrap compact-queue alert-queue"><table><thead><tr><th><ColumnFilter label="Alert" text={titleFilter} onText={setTitleFilter}/></th><th><ColumnFilter label="Next step" selected={state==='all'?[]:[state]} single onSelect={v=>setState(v[0]??'all')} options={filterOptions((queue?.cases??[]).map(stage))}/></th><th><ColumnFilter label="Severity" selected={severity==='all'?[]:[severity]} single onSelect={v=>setSeverity(v[0]??'all')} options={filterOptions((queue?.cases??[]).map(c=>c.severity))}/></th><th><ColumnFilter label="Instances" selected={instances} onSelect={setInstances} options={filterOptions((queue?.cases??[]).map(c=>String(c.members.length)))}/></th><th><ColumnFilter label="YouTrack" selected={links} onSelect={setLinks} options={filterOptions((queue?.cases??[]).map(ticketLabel))}/></th></tr></thead><tbody>{rows.map(c=><tr key={c.id}><td><button className="ticket-link" title={c.title} onClick={()=>choose(c.id)}>{c.title}</button><p className="small muted alert-labels" title={Object.entries(c.labels).map(([k,v])=>`${k}=${v}`).join(' · ')}>{Object.entries(c.labels).filter(([k])=>k!=='alertname').map(([k,v])=>`${k}=${v}`).join(' · ')}</p>{c.episodes>1&&<span className="amber small">Returned · {c.episodes} occurrences</span>}</td><td>{stage(c)}{c.suppressed&&c.active&&<p className="small muted">Suppressed in Alertmanager</p>}</td><td className={c.severity==='critical'?'red':'amber'}>{c.severity}</td><td>{c.members.length}</td><td>{c.ticket?<SafeLink href={c.ticket.url} target="_blank" rel="noreferrer">{c.ticket.key} ↗</SafeLink>:c.ticketCreation?.state==='pending'?'Checking creation':c.ticketCreation?.state==='draft'?'Draft to review':'Not linked'}</td></tr>)}</tbody></table></div>:<WorkBoard open={choose} emptyText="No alert." cards={rows.map(c=>({...alertPlacement(stage(c),c),id:c.id,key:'ALERT-'+c.id.slice(0,8),title:c.title,severity:c.severity,since:c.session.updatedAt||c.lastSeen,meta:[c.labels.cluster??c.labels.instance,`${c.members.length} instance${c.members.length===1?'':'s'}`,c.episodes>1?`returned ${c.episodes}×`:''].filter(Boolean).join(' · ')}))}/>}
 {view!=='rules'&&!rows.length&&<div className="empty-state"><h2>No matching alerts</h2><p>Warning and critical alerts appear after a successful poll. Try another filter if alerts are hidden.</p></div>}</>}
 {detail&&<IncomingWorkspace key={detail.issue.id} detail={detail} changed={setDetail} data={data} openTicket={openTicket}/>}
 </div>;
}

import {useWorkspace} from './use-workspace';
import {ProfileMenu} from './ProfileMenu';
import {useBrowserNotifications} from './browser-notifications';
import {RecoveryState,vaultRecovery} from './RecoveryState';
import {SlackRequests} from './SlackRequests';
import {ErrorNotice} from './ErrorNotice';
import {TourTicket} from './TourTicket';
import type {TourScene} from './tour-journey';
import {ProductTour,shouldOfferTour} from './ProductTour';
import {Dashboard} from './Dashboard';
import {Logs} from './Logs';
import {AuthResult} from './AuthResult';
import {parseRoute,navigate,resumeAfterVaultUnlock,type AppPage} from './navigation';
import {mergeSettings} from './settings-state';
import {useEffect,useState} from 'react';
import {api} from './api';
import {connectionNames,type Snapshot,type Config} from './model';
import {Settings} from './Settings';
import {Onboarding} from './Onboarding';
import {AIOverview} from './AIOverview';
import {Alerts} from './Alerts';
import {YouTrackTickets} from './YouTrackTickets';
export default function App(){
 const [route,setRoute]=useState(()=>parseRoute(location.hash));const page=route.page;const setPage=(page:string)=>navigate({page:page as AppPage});
 const alertTarget=route.page==='alerts'?route.issue:undefined;const youtrackTarget=route.page==='youtrack'&&route.issue?{id:route.issue,connection:route.connection??''}:undefined;
 const setAlertTarget=(issue?:string,step?:string)=>navigate({page:'alerts',issue,step});const setYoutrackTarget=(target?:{id:string;connection:string;step?:string})=>navigate({page:'youtrack',issue:target?.id,connection:target?.connection,step:target?.step});
 useEffect(()=>{const changed=()=>setRoute(parseRoute(location.hash));window.addEventListener('hashchange',changed);window.addEventListener('popstate',changed);window.addEventListener('support:navigate',changed);return()=>{window.removeEventListener('hashchange',changed);window.removeEventListener('popstate',changed);window.removeEventListener('support:navigate',changed)}},[]);
 const [tourScene,setTourScene]=useState<TourScene|null>(null);
 const [tour,setTour]=useState<'welcome'|'guide'|null>(()=>parseRoute(location.hash).page!=='auth'&&shouldOfferTour()?'welcome':null);
 const {data,setData,reload,loadError}=useWorkspace();
 useBrowserNotifications(!!data?.vault.unlocked);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{if(data?.vault.unlocked)resumeAfterVaultUnlock();else if(data){setError('');setMessage('');}},[data?.vault.unlocked,route.page,route.section]);
 useEffect(()=>{document.documentElement.dataset.theme=data?.config.theme??'auto'},[data?.config.theme]);
 async function run(fn:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function save(config:Config){if(!data)return;const latest=await api<Snapshot>('/state');const merged=mergeSettings(data.config,config,latest.config);if(merged.conflicts.length){setData(latest);throw new Error('Settings changed elsewhere: '+merged.conflicts.join(', ')+'. Review the highlighted conflicts; your edits are kept.');}try{const next=await api<Snapshot>('/config','PUT',{config:merged.config,revision:latest.configRevision});setData(next);setMessage('Settings saved.');}catch(e){await reload();throw e;}}
 const go=(p:string)=>{setPage(p);setError('');setMessage('');};
 if(!data)return <main className="login"><div className="wordmark">▱ support</div><h1>{error||loadError?'Workspace unavailable':'Opening your workspace…'}</h1>{(error||loadError)&&<><ErrorNotice message={error||loadError}/><button disabled={busy} onClick={()=>void run(async()=>{await reload();})}>Retry connection</button></>}<p className="small muted">Local workspace · No cloud hosting</p></main>;
 if(page==='auth')return <AuthResult success={route.result==='success'} back={()=>navigate({page:'settings',section:'Model'})}/>;
 const vaultBlocked=!data.vault.unlocked&&['dashboard','logs','ai','alerts','slack','youtrack'].includes(page);
 const title=({dashboard:'Dashboard',logs:'Logs',ai:'AI',alerts:'Alerts',slack:'Slack',youtrack:'YouTrack',settings:'Settings',onboarding:'Setup',workflows:'Workflows'} as Record<string,string>)[page];
 return <><div className="app" inert={tour!==null}><aside className="sidebar"><div className="wordmark">▱ support</div><nav aria-label="Main navigation">{[['dashboard','Dashboard'],['youtrack','YouTrack'],['alerts','Alerts'],['slack','Slack'],['ai','AI'],['logs','Logs'],['workflows','Workflows']].map(([id,label])=><button key={id} data-tour={id} className={page===id?'nav active':'nav'} onClick={()=>go(id)}>{label}</button>)}</nav><div className="sidebar-bottom"><ProfileMenu name={data.config.engineer} theme={data.config.theme} vaultUnlocked={data.vault.unlocked} busy={busy} onTheme={theme=>void run(()=>save({...data.config,theme}))} onSettings={()=>go('settings')} onLock={()=>void run(async()=>{await api('/vault','POST',{action:'lock'});await reload();})}/></div></aside><div className="main"><header className="topbar">Infrastructure / {title}<span className="badge">Engineer review required</span></header><div className="messages" aria-live="polite">{error&&!vaultBlocked&&<ErrorNotice message={error} context={route.section==='Model'?'Model':connectionNames.find(n=>n===route.tool)} retry={()=>void run(async()=>{await reload()})}/>}{message&&<div className="success">{message}<button onClick={()=>setMessage('')}>Dismiss</button></div>}</div>
 {tour&&tourScene?<TourTicket scene={tourScene}/>:vaultBlocked?<div className="page"><div className="heading"><h1>{title==='YouTrack'?'YouTrack tickets':title==='Slack'?'Slack requests':title}</h1></div><RecoveryState recovery={vaultRecovery(data.vault,({dashboard:'view recorded activity',logs:'view logs',ai:'view saved conversations and current activity',alerts:'resume alert polling and review cases',slack:'read your support channel',youtrack:'load tickets'} as Record<string,string>)[page])}/></div>:page==='dashboard'?<Dashboard data={data}/>:page==='logs'?<Logs data={data}/>:page==='ai'?<AIOverview data={data} openTicket={target=>{setYoutrackTarget(target)}} openAlert={(id,step)=>{setAlertTarget(id,step)}}/>:page==='alerts'?<Alerts initialAlert={alertTarget} data={data} openTicket={ticket=>{setYoutrackTarget({id:ticket.id,connection:ticket.connection});}}/>:page==='slack'?<SlackRequests data={data} id={route.issue} openTicket={setYoutrackTarget}/>:page==='youtrack'?<YouTrackTickets initialIssue={youtrackTarget} data={data}/>:page==='settings'?<Settings data={data} save={save} run={run} busy={busy} reload={reload} onStartTour={()=>setTour('guide')} setup={<Onboarding data={data} save={save} run={run} busy={busy} reload={reload} onDone={()=>go('youtrack')} onTour={()=>go('youtrack')}/>}/>:<div className="page"><h1>Workflows</h1><p>No published workflows yet.</p></div>}
 </div></div>{tour&&<ProductTour onScene={setTourScene} welcome={tour==='welcome'} onClose={()=>setTour(null)}/>}</>;
}

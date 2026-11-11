import {clearListCache} from './list-cache';
import {useWorkspace} from './use-workspace';
import {ProfileMenu} from './ProfileMenu';
import {AgentConsole} from './AgentConsole';
import {useToast} from './Toasts';
import {recoveryMessage} from './error-recovery';
import {useBrowserNotifications} from './browser-notifications';
import {RecoveryState,vaultRecovery} from './RecoveryState';
import {SlackRequests} from './SlackRequests';
import {ErrorNotice,ErrorRecoveryAction} from './ErrorNotice';
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
 const [navHidden,setNavHidden]=useState(()=>{try{return localStorage.getItem('support.navHidden')==='1';}catch{return false;}});
 const toggleNav=()=>setNavHidden(v=>{try{localStorage.setItem('support.navHidden',v?'0':'1');}catch{/* storage unavailable */}return !v;});
 const [tourScene,setTourScene]=useState<TourScene|null>(null);
 const [tour,setTour]=useState<'welcome'|'guide'|null>(()=>parseRoute(location.hash).page!=='auth'&&shouldOfferTour()?'welcome':null);
 const {data,setData,reload,loadError}=useWorkspace();
 useBrowserNotifications(!!data?.vault.unlocked);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{if(data?.vault.unlocked)resumeAfterVaultUnlock();else if(data){clearListCache();setError('');setMessage('');}},[data?.vault.unlocked,route.page,route.section]);
 const toast=useToast();
 // Action results appear as toasts. The page-level error stays in state for the startup screen only.
 useEffect(()=>{if(message){toast({tone:'success',message});setMessage('');}},[message,toast]);
 useEffect(()=>{if(error&&data){toast({tone:'error',message:recoveryMessage(error),action:<ErrorRecoveryAction message={error} context={route.section==='Model'?'Model':connectionNames.find(n=>n===route.tool)}/>});setError('');}},[error,data,toast]);
 useEffect(()=>{document.documentElement.dataset.theme=data?.config.theme??'auto'},[data?.config.theme]);
 async function run(fn:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function save(config:Config){if(!data)return;const latest=await api<Snapshot>('/state');const merged=mergeSettings(data.config,config,latest.config);if(merged.conflicts.length){setData(latest);throw new Error('Settings changed elsewhere: '+merged.conflicts.join(', ')+'. Review the highlighted conflicts; your edits are kept.');}try{const next=await api<Snapshot>('/config','PUT',{config:merged.config,revision:latest.configRevision});setData(next);setMessage('Settings saved.');}catch(e){await reload();throw e;}}
 const go=(p:string)=>{setPage(p);setError('');setMessage('');};
 if(!data)return <main className="login"><div className="wordmark">▱ support</div><h1>{error||loadError?'Workspace unavailable':'Opening your workspace…'}</h1>{(error||loadError)&&<><ErrorNotice message={error||loadError}/><button disabled={busy} onClick={()=>void run(async()=>{await reload();})}>Retry connection</button></>}<p className="small muted">Local workspace · No cloud hosting</p></main>;
 if(page==='auth')return <AuthResult success={route.result==='success'} back={()=>navigate({page:'settings',section:'Model'})}/>;
 const vaultBlocked=!data.vault.unlocked&&['dashboard','logs','ai','alerts','slack','youtrack'].includes(page);
 const title=({dashboard:'Dashboard',logs:'Logs',ai:'Agent work',alerts:'Alerts',slack:'Slack',youtrack:'YouTrack',settings:'Settings',onboarding:'Setup',workflows:'Workflows'} as Record<string,string>)[page];
 return <><div className={'app'+(navHidden&&tour===null?' nav-hidden':'')} inert={tour!==null}><aside className="sidebar" id="main-sidebar"><div className="wordmark">▱ support</div><nav aria-label="Main navigation">{[['dashboard','Dashboard'],['youtrack','YouTrack'],['alerts','Alerts'],['slack','Slack'],['ai','Agent work'],['logs','Logs'],['workflows','Workflows']].map(([id,label])=><button key={id} data-tour={id} className={page===id?'nav active':'nav'} onClick={()=>go(id)}>{label}</button>)}</nav><div className="sidebar-bottom"><ProfileMenu name={data.config.engineer} theme={data.config.theme} vaultUnlocked={data.vault.unlocked} busy={busy} onTheme={theme=>void run(()=>save({...data.config,theme}))} onSettings={()=>go('settings')} onLock={()=>void run(async()=>{await api('/vault','POST',{action:'lock'});await reload();})}/></div></aside><div className="main"><header className="topbar"><span className="topbar-title"><button type="button" className="nav-toggle" aria-controls="main-sidebar" aria-expanded={!navHidden} aria-label={navHidden?'Show navigation':'Hide navigation'} title={navHidden?'Show navigation':'Hide navigation'} onClick={toggleNav}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12M2 8h12M2 12.5h12"/></svg></button>Infrastructure / {title}</span><span className="badge">Engineer review required</span></header><div className="messages" aria-live="polite"></div>
 {tour&&tourScene?<TourTicket scene={tourScene}/>:vaultBlocked?<div className="page"><div className="heading"><h1>{title==='YouTrack'?'YouTrack tickets':title==='Slack'?'Slack requests':title}</h1></div><RecoveryState recovery={vaultRecovery(data.vault,({dashboard:'view recorded activity',logs:'view logs',ai:'view saved conversations and current activity',alerts:'resume alert polling and review cases',slack:'read your support channel',youtrack:'load tickets'} as Record<string,string>)[page])}/></div>:page==='dashboard'?<Dashboard data={data}/>:page==='logs'?<Logs data={data}/>:page==='ai'?<AIOverview data={data} openTicket={target=>{setYoutrackTarget(target)}} openAlert={(id,step)=>{setAlertTarget(id,step)}}/>:page==='alerts'?<Alerts initialAlert={alertTarget} data={data} openTicket={ticket=>{setYoutrackTarget({id:ticket.id,connection:ticket.connection});}}/>:page==='slack'?<SlackRequests data={data} id={route.issue} openTicket={setYoutrackTarget}/>:page==='youtrack'?<YouTrackTickets initialIssue={youtrackTarget} data={data}/>:page==='settings'?<Settings data={data} save={save} run={run} busy={busy} reload={reload} onStartTour={()=>setTour('guide')} setup={<Onboarding data={data} save={save} run={run} busy={busy} reload={reload} onDone={()=>go('youtrack')} onTour={()=>go('youtrack')}/>}/>:<div className="page"><h1>Workflows</h1><p>No published workflows yet.</p></div>}
 </div></div>{data.vault.unlocked&&!tour&&<AgentConsole/>}{tour&&<ProductTour onScene={setTourScene} welcome={tour==='welcome'} onClose={()=>setTour(null)}/>}</>;
}

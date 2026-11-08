import type {Config,ConnectionName} from './model';
const behavior:Record<ConnectionName,{label:string;on:string;off:string}>={
 YouTrack:{label:'Read YouTrack tickets',on:'The queue reads tickets and comments from your configured query.',off:'Ticket reads are unavailable. Saved work sessions and credentials are kept.'},
 GitLab:{label:'Use GitLab for support work',on:'Read repositories and pipelines. Branch changes and merge requests still require engineer approval.',off:'New GitLab requests are blocked. Existing branches and merge requests stay in GitLab.'},
 Toolbox:{label:'Allow Toolbox reads',on:'The agent can read allowed resources in the contexts and namespaces configured here.',off:'The agent cannot call Toolbox. Its configuration and kubeconfig files are unchanged.'},
 Prometheus:{label:'Allow metric queries',on:'The agent can query this Prometheus endpoint during an investigation.',off:'Metric queries through this connection are unavailable.'},
 Alertmanager:{label:'Poll Alertmanager',on:'Refresh alerts automatically while the server runs and the Vault is unlocked.',off:'Automatic polling is paused. Existing alert cases and their history are kept.'},
 Model:{label:'Allow model requests',on:'Allow investigations and approved change preparation. This switch does not start a run.',off:'New model requests are blocked. Plans, conversations and account credentials are kept.'},
 Outline:{label:'Outline adapter',on:'This adapter is not available yet.',off:'This adapter is not available yet.'},
 Slack:{label:'Read Slack requests',on:'Poll the configured support channel. Choose how to handle each thread; replies require approval.',off:'Slack reads and replies are paused. Saved cases and credentials are kept.'},
};
export function ConnectionAvailability({name,config,onChange}:{name:ConnectionName;config:Config;onChange:(enabled:boolean)=>void}){
 const enabled=config.connections[name].enabled,b=behavior[name];
 if(name==='Outline')return <p className="connection-availability small muted">{b.label} · Not available yet. You can save its settings for later.</p>;
 return <div className="connection-availability"><label className="check"><input type="checkbox" checked={enabled} onChange={e=>onChange(e.target.checked)}/><span>{b.label}<small>{enabled?b.on:b.off}</small></span></label><p className="small muted">{name==='Alertmanager'&&enabled?`Polls every ${config.alerting.pollSeconds} seconds. `:''}{name==='Model'&&enabled?'Automatic alert investigations are configured under Connections → Alertmanager. ':''}Changes take effect when you save settings. Turning this off keeps the saved credentials.</p></div>;
}

import {AIOverview} from './AIOverview';
import {Dashboard} from './Dashboard';
import {useMemo} from 'react';
import {WorkspacePreviewProvider} from './WorkspaceRuntime';
import {YouTrackTickets} from './YouTrackTickets';
import {Alerts} from './Alerts';
import {SlackRequests} from './SlackRequests';
import {createTourFixture} from './tour-fixtures';
import type {TourScene} from './tour-journey';

// No duplicate ticket markup: the tour mounts the same screens as the workspace.
export function TourTicket({scene}:{scene:TourScene}){
 const fixture=useMemo(()=>createTourFixture(scene),[scene]);
 const {snapshot,preview}=fixture;
 return <WorkspacePreviewProvider value={preview}><div className="tour-preview" key={scene}>
  <p className="tour-example-label">Tour example · Not saved</p>
  {scene==='ai'?<AIOverview data={snapshot} openTicket={()=>{}} openAlert={()=>{}}/>:scene==='dashboard'?<Dashboard data={snapshot}/>:preview.route.page==='alerts'?<Alerts data={snapshot} initialAlert={preview.route.issue} openTicket={()=>{}}/>:preview.route.page==='slack'?<SlackRequests data={snapshot} id={preview.route.issue} openTicket={()=>{}}/>:<YouTrackTickets data={snapshot} initialIssue={preview.route.issue?{id:preview.route.issue,connection:preview.route.connection??''}:undefined}/>}
 </div></WorkspacePreviewProvider>;
}

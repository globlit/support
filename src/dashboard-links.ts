import type {DashboardData} from './dashboard-model.js';
import type {Route} from './navigation.js';
// Daily bounds use the same calendar timezone as the chart; hourly bounds are UTC instants.
export function runLink(data:DashboardData,state='all',bucket?:string):Route {
 const first=bucket??data.daily[0]?.date,last=bucket??data.daily.at(-1)?.date;
 return {page:'ai',section:'runs',step:state==='failed'?'blocked':state,tool:'all',focus:'dashboard',from:first,to:last?(data.interval==='hour'?new Date(Date.parse(last)+3600000).toISOString():last):undefined,zone:data.timezone};
}
export function inRunWindow(startedAt:string,route:Route){
 if(!route.from||!route.to)return true;
 const time=Date.parse(startedAt);if(!Number.isFinite(time))return false;
 if(/^\d{4}-\d{2}-\d{2}$/.test(route.from)&&/^\d{4}-\d{2}-\d{2}$/.test(route.to)){
  try{const day=new Intl.DateTimeFormat('en-CA',{timeZone:route.zone??'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(time);return day>=route.from&&day<=route.to;}catch{return false;}
 }
 const from=Date.parse(route.from),to=Date.parse(route.to);return time>=from&&time<to;
}
export function windowLabel(route:Route){
 if(!route.from||!route.to)return '';
 if(route.from.length===10)return (route.from===route.to?route.from:`${route.from} – ${route.to}`)+` · ${route.zone??'UTC'}`;
 try{const format=(s:string)=>new Date(s).toLocaleString(undefined,{timeZone:route.zone??'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'shortOffset'});return `${format(route.from)} – ${format(route.to)}`;}catch{return 'Selected time window';}
}

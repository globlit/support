import type {AIRunSummary} from './ai-model';
export function ActivitySparkline({run}:{run?:AIRunSummary}){
 const activity=run?.activity,counts=activity?.counts??Array(40).fill(0),max=Math.max(1,...counts);
 const label=activity?`${counts.reduce((a,b)=>a+b,0)} recorded events · ${new Date(activity.start).toLocaleTimeString()}–${new Date(activity.end).toLocaleTimeString()}`:'No recorded activity';
 return <div className={'activity-sparkline '+(run?.state??'empty')} title={label}><svg viewBox="0 0 400 18" preserveAspectRatio="none" role="img" aria-label={label}><line x1="0" y1="17" x2="400" y2="17" className="activity-baseline"/>{counts.map((n,i)=>n>0?<rect key={i} x={i*10+2} y={17-(2+n/max*14)} width="5" height={2+n/max*14} rx="1"/>:null)}</svg></div>;
}

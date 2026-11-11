import type {AnalysisRun,WorkSession} from './model';

export type Branch={leaf:string;runs:AnalysisRun[];label:string;latestAt:string};

/**
 * Returns the run that `run` builds on: the run named by its basis, or for a restart the run that produced the plan
 * version.
 */
export function parentOf(run:AnalysisRun,plans:WorkSession['plans']):string|undefined{
 const b=run.basedOn;
 if(!b)return undefined;
 if(b.kind==='start'||b.kind==='over')return undefined;
 if(b.kind==='restart')return plans.find(p=>p.version===b.planVersion)?.runId;
 return b.runId;
}

/**
 * Splits the runs of a request into branches. A branch is the path from a first run to a run that nothing builds on.
 * Branches are ordered by their newest run, newest first. Each is labelled by where it starts: the beginning, a plan
 * version or a fresh start.
 */
export function branches(runs:AnalysisRun[],plans:WorkSession['plans']):Branch[]{
 const sorted=[...runs].sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
 const byId=new Map(sorted.map(r=>[r.id,r]));
 const parent=new Map(sorted.map(r=>[r.id,parentOf(r,plans)]));
 const hasChild=new Set([...parent.values()].filter((p):p is string=>!!p&&byId.has(p)));
 const out:Branch[]=[];
 for(const leaf of sorted.filter(r=>!hasChild.has(r.id))){
  const path:AnalysisRun[]=[];const seen=new Set<string>();let cur:AnalysisRun|undefined=leaf;
  while(cur&&!seen.has(cur.id)){seen.add(cur.id);path.unshift(cur);const p=parent.get(cur.id);cur=p?byId.get(p):undefined;}
  out.push({leaf:leaf.id,runs:path,label:branchLabel(path),latestAt:leaf.startedAt});
 }
 return out.sort((a,b)=>b.latestAt.localeCompare(a.latestAt));
}

const time=(at:string)=>new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
/** Names a branch by its most recent restart or fresh start, or "From the start". */
export function branchLabel(path:AnalysisRun[]){
 const turn=[...path].reverse().find(r=>r.basedOn?.kind==='restart'||r.basedOn?.kind==='over');
 if(turn?.basedOn?.kind==='restart')return `From plan v${turn.basedOn.planVersion} (${time(turn.startedAt)})`;
 if(turn?.basedOn?.kind==='over')return `Started over (${time(turn.startedAt)})`;
 return 'From the start';
}

/** Text of the engineer turn that started a run. */
export function turnText(run:AnalysisRun){
 const b=run.basedOn;
 if(!b)return 'Investigation started';
 switch(b.kind){
  case 'start':return b.text?`Investigate: ${b.text}`:'Investigation started';
  case 'over':return b.text?`Start over: ${b.text}`:'Start over without earlier memory';
  case 'recheck':return b.text&&b.text!=='Recheck the request with its current data.'?`Recheck: ${b.text}`:'Recheck the request with its current data';
  case 'restart':return `Restart from plan v${b.planVersion}${b.text?`: ${b.text}`:''}`;
  case 'implement':return `Implement plan v${b.planVersion}`;
  default:return b.text??'';
 }
}

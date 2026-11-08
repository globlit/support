import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardSummary} from '../server/dashboard.js';
import {runLink,inRunWindow} from '../src/dashboard-links.js';
import {parseRoute,routeHash} from '../src/navigation.js';
import type {AIOverview,AIRunSummary} from '../src/ai-model.js';
const run=(startedAt:string,state:AIRunSummary['state']='blocked'):AIRunSummary=>({id:startedAt,startedAt,updatedAt:startedAt,state,connection:'lab',issueId:'1',kind:'investigation',step:'Done',checks:1,repeating:false,quiet:false});
const overview=(runs:AIRunSummary[]):AIOverview=>({runs,workflows:[],loadedAt:'',historyLimit:200,agent:{active:false,step:'',model:'test'}});
test('daily click-through includes precisely the chart day in the configured timezone',()=>{
 const runs=[run('2026-11-07T22:59:59Z'),run('2026-11-07T23:00:00Z'),run('2026-11-08T12:00:00Z'),run('2026-11-08T23:00:00Z')];
 const chart=dashboardSummary(overview(runs),7,'Europe/Paris',30,Date.parse('2026-11-09T12:00:00Z'));
 const link=runLink(chart,'failed','2026-11-08');
 assert.equal(link.step,'blocked');assert.equal(link.section,'runs');assert.equal(link.tool,'all');
 assert.deepEqual(runs.filter(r=>inRunWindow(r.startedAt,link)).map(r=>r.id),runs.slice(1,3).map(r=>r.id));
 assert.equal(runs.filter(r=>inRunWindow(r.startedAt,link)).length,chart.daily.find(d=>d.date==='2026-11-08')!.failed);
 assert.deepEqual(parseRoute(routeHash(link)),link);
});
test('hourly click-through distinguishes repeated hours at daylight-saving fallback',()=>{
 const runs=[run('2026-10-25T00:15:00Z'),run('2026-10-25T01:15:00Z'),run('2026-10-25T02:00:00Z')];
 const chart=dashboardSummary(overview(runs),7,'Europe/Paris',30,Date.parse('2026-10-25T03:00:00Z'),'hour');
 for(const [i,bucket] of ['2026-10-25T00:00:00.000Z','2026-10-25T01:00:00.000Z'].entries()){
  const link=runLink(chart,'failed',bucket);assert.deepEqual(runs.filter(r=>inRunWindow(r.startedAt,link)).map(r=>r.id),[runs[i].id]);
 }
});
test('whole-period link matches chart window and rejects invalid times',()=>{
 const chart=dashboardSummary(overview([]),7,'UTC',30,Date.parse('2026-11-08T12:00:00Z'),'hour');const link=runLink(chart);
 assert.equal(inRunWindow('2026-11-07T13:00:00Z',link),true);
 assert.equal(inRunWindow('2026-11-07T12:59:59Z',link),false);
 assert.equal(inRunWindow('2026-11-08T13:00:00Z',link),false);
 assert.equal(inRunWindow('bad',link),false);
 assert.equal(inRunWindow('2026-11-08T00:00:00Z',{page:'ai',from:'2026-11-08',to:'2026-11-08',zone:'invalid'}),false);
});
test('legacy setup route opens Settings and filter bounds survive refresh',()=>{
 assert.deepEqual(parseRoute('#/onboarding'),{page:'settings',section:'Setup & tour'});
 const route=parseRoute('#/ai?section=runs&step=blocked&from=2026-11-08&to=2026-11-08&zone=Europe%2FParis');
 assert.deepEqual(parseRoute(routeHash(route)),route);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {usageSeries} from '../server/dashboard.js';
import {inRunWindow} from '../src/dashboard-links.js';
const bucket=(date:string)=>({date,label:date,completed:0,failed:0,running:0,stopped:0});
test('token totals align with calendar days and include cached input only once',()=>{
 const t=usageSeries([bucket('2026-10-25')],'day','Europe/Paris');
 assert.equal(t.add('2026-10-24T22:05:00Z',{input:100,output:20,cacheRead:40}),true);
 assert.equal(t.add('2026-10-25T22:59:59Z',{input:10,output:5}),true);
 assert.equal(t.add('2026-10-25T23:00:00Z',{input:200,output:2}),false);
 assert.equal(t.add('invalid',{input:1,output:1}),false);assert.equal(t.add('2026-10-25T10:00:00Z',undefined),false);
 assert.deepEqual(t.series[0],{date:'2026-10-25',label:'2026-10-25',input:110,output:25,responses:2});
});
test('repeated DST hours remain distinct and match log drilldown bounds',()=>{
 const t=usageSeries([bucket('2026-10-25T00:00:00.000Z'),bucket('2026-10-25T01:00:00.000Z')],'hour','Europe/Paris');
 t.add('2026-10-25T00:30:00Z',{input:2,output:1});t.add('2026-10-25T01:30:00Z',{input:7,output:3});
 assert.deepEqual(t.series.map(b=>b.input),[2,7]);assert.equal(inRunWindow('2026-10-25T01:30:00Z',{page:'logs',from:t.series[0].date,to:t.series[1].date}),false);
});

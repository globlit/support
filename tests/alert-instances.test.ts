import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {AlertInstances,orderedLabels} from '../src/AlertInstances.js';
import type {AlertMember} from '../src/model.js';

const member=(patch:Partial<AlertMember>={}):AlertMember=>({fingerprint:'abcdef1234567890',labels:{zone:'a',severity:'critical',alertname:'HighErrorRate',instance:'api-1:9090',namespace:'payments'},annotations:{summary:'Error rate above 5%',description:'**5xx** responses increased.',runbook_url:'https://runbooks.example.com/errors',dashboard:'Grafana'},startsAt:'2026-11-09T10:00:00Z',state:'active',...patch});

test('labels are ordered with the most useful ones first',()=>{
 assert.deepEqual(orderedLabels(member().labels).map(([k])=>k),['alertname','severity','namespace','instance','zone']);
});

test('an alert instance card leads with the summary, description and runbook, then labels as chips',()=>{
 const html=renderToStaticMarkup(createElement(AlertInstances,{members:[member()]}));
 assert.match(html,/<details class="alert-instance" open="">/);
 assert.match(html,/<span class="alert-instance-title">api-1:9090<\/span><span class="alert-state active">Firing<\/span>/);
 assert.ok(html.indexOf('Error rate above 5%')<html.indexOf('alert-labels'));
 assert.match(html,/href="https:\/\/runbooks\.example\.com\/errors"[^>]*>Open runbook ↗/);
 assert.match(html,/<h4>dashboard<\/h4>/);assert.doesNotMatch(html,/<h4>(summary|description|runbook_url)<\/h4>/);
 assert.match(html,/<li class="severity-critical"><span>severity<\/span>critical<\/li>/);
});

test('several instances start closed, and a runbook that is not an HTTP URL is not linked',()=>{
 const html=renderToStaticMarkup(createElement(AlertInstances,{members:[member({fingerprint:'one',annotations:{runbook_url:'javascript:alert(1)'}}),member({fingerprint:'two',state:'suppressed',labels:{alertname:'X'}})]}));
 assert.doesNotMatch(html,/open=""/);assert.doesNotMatch(html,/javascript:/);
 assert.match(html,/<span class="alert-instance-title">two<\/span><span class="alert-state suppressed">Silenced<\/span>/);
});

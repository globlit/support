import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workflowStep} from '../src/workflow-step.js';

test('failed and stopped investigations open the investigation step, and other stages open their own step',()=>{
 assert.equal(workflowStep('Investigation'),'investigation');assert.equal(workflowStep('Investigation stopped'),'investigation');
 assert.equal(workflowStep('Plan approval'),'plan');assert.equal(workflowStep('Pipeline failed'),'implementation');
 assert.equal(workflowStep('Reply approval'),'message');assert.equal(workflowStep('Intake decision'),'request');assert.equal(workflowStep('Ticket approval'),'ticket');
 assert.equal(workflowStep('Unknown stage'),undefined);assert.equal(workflowStep('toString'),undefined);
});

test('every stage reported by the AI overview has a timeline step',()=>{
 const source=readFileSync('server/ai-activity.ts','utf8');
 const stages=new Set([...source.matchAll(/state\('[a-z]+','([^']+)'/g),...source.matchAll(/stage:'([^']+)'/g)].map(m=>m[1]));
 for(const stage of stages)assert.ok(workflowStep(stage),stage);
});

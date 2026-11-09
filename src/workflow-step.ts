import type {ReviewStage} from './IssueFlow';

/** Ticket timeline step for each AI workflow stage reported by server/ai-activity.ts. */
const steps:Record<string,ReviewStage>={
 'Intake decision':'request','Not handled':'request','Ignored':'request','Alert not firing':'request','Request review':'request',
 'Ticket approval':'ticket','Confirm ticket creation':'ticket','Linked ticket':'ticket',
 'Investigation':'investigation','Investigation stopped':'investigation',
 'Plan approval':'plan','Plan revision':'plan',
 'Preparing changes':'implementation','Change preparation':'implementation','Interrupted preparation':'implementation','Implementation':'implementation',
 'Diff approval':'implementation','Merge request':'implementation','Merge request closed':'implementation','Merged pipeline':'implementation',
 'Pipeline':'implementation','Pipeline action':'implementation','Pipeline failed':'implementation','Pipeline incomplete':'implementation','Pipeline diagnosis':'implementation',
 'Diagnosis review':'implementation','Fix approval':'implementation','Confirm fix':'implementation','GitLab status unavailable':'implementation',
 'Resolution summary':'message','Summary approval':'message','Closure approval':'message','Confirm YouTrack action':'message','Ticket reopened':'message','Resolved':'message',
 'Direct reply':'message','Reply approval':'message','Confirm reply':'message','Reply sent':'message','Resolution recorded':'message',
};

/**
 * Returns the ticket timeline step for an AI workflow stage, or undefined for an unknown stage.
 * Investigation stages, including failed and stopped runs, return the investigation step.
 */
export function workflowStep(stage:string):ReviewStage|undefined{return Object.hasOwn(steps,stage)?steps[stage]:undefined;}

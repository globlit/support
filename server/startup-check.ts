import {ZodError} from 'zod';
import type {Store} from './store.js';

const shown=10;
/**
 * Reads the saved configuration. Returns undefined when it loads. Otherwise returns a message that names the data
 * directory and the rejected settings, at most ten, and says that Support changed nothing.
 */
export function storedConfigProblem(store:Store,dir:string):string|undefined{
 try{store.snapshot();return undefined;}
 catch(e){
  const issues=e instanceof ZodError?e.issues:undefined;
  const lines=issues?issues.slice(0,shown).map(i=>`- ${i.path.join('.')||'settings'}: ${i.message}`):[`- ${e instanceof Error?e.message:'The stored value is unreadable.'}`];
  if(issues&&issues.length>shown)lines.push(`- ${issues.length-shown} more`);
  return [
   `The saved configuration in ${dir} cannot be read by this version of Support.`,
   ...lines,
   'This version does not convert settings saved by an earlier version. Support changed nothing and did not start.',
   'Back up the data directory. Then run the version that saved it, or reset the data directory.',
  ].join('\n');
 }
}

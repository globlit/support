import {z} from 'zod';
import {AppError} from './store.js';
import {agentHome,cleanupSandboxRun,runSandboxCommand} from './sandbox.js';

/** Runs a shell command in the sandbox and returns its combined output and exit code. */
export type LoginRunner=(command:string,signal?:AbortSignal)=>Promise<{output:string;code:number|null}>;
const quote=(value:string)=>`'${value.replace(/'/g,`'\\''`)}'`;
/** Configuration folder of Claude Code sessions in the sandbox, inside the agent volume. */
export const claudeConfigFolder=(home=agentHome())=>`${home.replace(/\/+$/,'')}/.claude`;
/** Shell command that prints the Claude Code login status as JSON. Settings, hooks and plugins of the folder are not loaded. */
export const loginStatusCommand=(folder:string)=>`CLAUDE_CONFIG_DIR=${quote(folder)} claude --safe-mode --restricted --setting-sources '' --settings '{"disableAllHooks":true}' auth status`;
const sandboxRunner:LoginRunner=async(command,signal)=>{
 try{const r=await runSandboxCommand({runId:'login-check',command,timeoutSeconds:30,signal:signal??AbortSignal.timeout(35000)});return {output:r.output,code:r.exitCode};}
 finally{await cleanupSandboxRun('login-check');}
};
const status=z.object({loggedIn:z.boolean(),authMethod:z.string().optional(),subscriptionType:z.string().nullable().optional()});
/**
 * Reads the Claude Code login status inside the sandbox. `connected` is true when the sandbox is signed in with a Claude account.
 * Throws when the sandbox is unreachable, `claude` is missing there, or its output is not a login status.
 */
export async function claudeLoginStatus(runner:LoginRunner=sandboxRunner,signal?:AbortSignal,folder=claudeConfigFolder()){
 const result=await runner(loginStatusCommand(folder),signal);
 // Combined output can carry warnings around the JSON object.
 const start=result.output.indexOf('{'),end=result.output.lastIndexOf('}');
 let data:unknown;try{data=JSON.parse(result.output.slice(start,end+1))}catch{throw new AppError(502,'Claude Code in the sandbox did not report a login status. Check that the sandbox image contains Claude Code.');}
 const parsed=status.safeParse(data);
 if(!parsed.success)throw new AppError(502,'Claude Code in the sandbox returned an unexpected login status.');
 const s=parsed.data;
 return {connected:s.loggedIn&&s.authMethod==='claude.ai',method:s.authMethod??'none',plan:s.subscriptionType??undefined};
}

import {SafeLink} from './SafeLink';
export function ClaudeLocalConnection({path,onPath}:{path:string;onPath:(path:string)=>void}){
 return <div className="model-local-connection">
  <p>Use your Claude subscription through the official Claude Code CLI installed where Support runs.</p>
  <label>Claude executable path<input value={path} onChange={e=>onPath(e.target.value)} placeholder="/home/you/.local/bin/claude"/><small>Run <code>command -v claude</code> where Support runs to find it.</small></label>
  <ol><li>In a terminal where Support runs, run <code>claude auth login</code> and choose your Claude subscription.</li><li>Enter the executable path above and choose a model.</li><li>Click <strong>Test Model</strong>, next to <strong>Save settings</strong> below to verify the CLI login.</li></ol>
  <p className="small muted">Claude handles sign-in and stores its own credentials where Support runs. Support does not copy subscription tokens into the Vault. Each request starts in an empty temporary folder, without native file, shell or MCP tools. Support handles the proposed actions through its existing review flow.</p>
  <SafeLink className="small" href="https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use" target="_blank" rel="noreferrer">About local Claude authentication ↗</SafeLink>
 </div>;
}

import {SafeLink} from './SafeLink';
export function ClaudeSandboxLogin(){
 return <div className="model-local-connection">
  <p>Use your Claude subscription through Claude Code in the command sandbox. Agent sessions need <strong>Let the agent run commands</strong> on.</p>
  <ol><li>Run <code>docker compose exec -u admin sandbox claude auth login</code> and choose your Claude subscription.</li><li>Choose a model.</li><li>Click <strong>Test Model</strong>, next to <strong>Save settings</strong> below, to check the login.</li></ol>
  <p className="small muted">Claude Code stores the login in its configuration folder in the sandbox and sends model requests to Anthropic directly. The agent can read that folder, and the sandbox can reach public hosts. Use a dedicated Claude account for Support. Support does not store the login in the Vault.</p>
  <SafeLink className="small" href="https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use" target="_blank" rel="noreferrer">About Claude authentication ↗</SafeLink>
 </div>;
}

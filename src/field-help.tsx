import type {ReactNode} from 'react';
import {SafeLink} from './SafeLink';
import type {ConnectionName} from './model';

const Doc=({href,children}:{href:string;children:ReactNode})=><SafeLink href={href} target="_blank" rel="noreferrer">{children} ↗</SafeLink>;

/** Help for the service URL field of a connection. */
export function endpointHelp(name:ConnectionName):ReactNode{
 switch(name){
  case 'YouTrack':return <>Base URL of YouTrack, without <code>/api</code>. Example: <code>https://youtrack.example.com</code></>;
  case 'GitLab':return <>Base URL of GitLab, without <code>/api/v4</code>. Example: <code>https://gitlab.example.com</code></>;
  case 'Outline':return <>Base URL of the Outline workspace. Example: <code>https://outline.example.com</code></>;
  case 'Alertmanager':return <>Base URL of Alertmanager, without <code>/api/v2</code>. Example: <code>https://alertmanager.example.com</code></>;
  case 'Prometheus':return <>Base URL of Prometheus, without <code>/api/v1</code>. Example: <code>https://prometheus.example.com</code></>;
  case 'Grafana':return <>Base URL of Grafana. Example: <code>https://grafana.example.com</code></>;
  case 'Slack':return <>Use <code>https://slack.com/api</code>.</>;
  default:return undefined;
 }
}

/** Help for the scope field of a connection (query, collection, channel or matchers). */
export function scopeHelp(name:ConnectionName):ReactNode{
 switch(name){
  case 'YouTrack':return <>YouTrack search syntax. Support handles the tickets this query returns. Example: <code>project: INFRA #Unresolved</code></>;
  case 'Outline':return <>Collection name from Outline's sidebar. A collection URL or ID also works. Example: <code>DevOps</code></>;
  case 'Slack':return <>In Slack, click the channel name and copy the <strong>Channel ID</strong> at the bottom. Example: <code>C0123456789</code></>;
  case 'Alertmanager':return <>One matcher per line. An alert must match every line. Leave empty for all alerts. Example: <code>severity="critical"</code></>;
  default:return undefined;
 }
}

/** Help that explains how to create the credential of a connection. */
export function credentialHelp(name:ConnectionName):ReactNode{
 switch(name){
  case 'YouTrack':return <>Avatar → <strong>Profile → Account Security → New token…</strong>, scope <strong>YouTrack</strong>. The token starts with <code>perm:</code>. <Doc href="https://www.jetbrains.com/help/youtrack/cloud/manage-permanent-token.html">Docs</Doc></>;
  case 'GitLab':return <>Fine-grained token (GitLab 18.10+), two parts:<ul><li><strong>User</strong>: Project, Group, Personal access token: Read · Global search: Use</li><li><strong>Support's groups/projects</strong>: Project, Repository, Pipeline, Job: Read · Global search: Use · Merge request, Branch: Read, Create · Commit: Create</li></ul>User lets the agent list and search projects. Legacy token: <code>api</code>. <Doc href="https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/">Docs</Doc></>;
  case 'Slack':return <>Bot scopes: <code>channels:history</code> (or <code>groups:history</code> if private) and <code>chat:write</code>. Copy the <strong>Bot User OAuth Token</strong> (<code>xoxb-…</code>). Invite the app to the support channel only: it reads no other. <Doc href="https://api.slack.com/apps">Slack apps</Doc></>;
  case 'Outline':return <>Outline <strong>Settings → API → New API key</strong>, with the scopes:<ul><li><code>documents:read</code></li><li><code>collections:read</code>: not needed if the collection is set by ID</li></ul><Doc href="https://www.getoutline.com/developers">Docs</Doc></>;
  case 'Alertmanager':case 'Prometheus':return <>Only needed when a reverse proxy protects {name}. Use a username and password, or a bearer token.</>;
  case 'Grafana':return <>A user with the Viewer role and query access to the Prometheus datasources. Use its username and password, or a service account token.</>;
  case 'Kubernetes':return <>A ServiceAccount token bound to a read-only role, such as the <code>view</code> ClusterRole. Support refuses writes, exec and port-forward; RBAC decides which reads succeed. See <code>docs/kubernetes-access.md</code>.</>;
  default:return undefined;
 }
}

/** Help that explains how to create a model API key. */
export function modelKeyHelp():ReactNode{
 return <>Create a key in the <Doc href="https://platform.claude.com/settings/keys">Claude Console</Doc> or the <Doc href="https://platform.openai.com/api-keys">OpenAI dashboard</Doc>. Do not include <code>/v1</code> in the base URL.</>;
}

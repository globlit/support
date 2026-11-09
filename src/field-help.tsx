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
  case 'GitLab':return <>Project or group access token, role <strong>Developer</strong>, scope <code>api</code> (<code>read_api</code> for read-only). Support reaches only the projects this token can access. <Doc href="https://docs.gitlab.com/user/project/settings/project_access_tokens/">Docs</Doc></>;
  case 'Slack':return <>Slack app with bot scopes <code>channels:history</code> and <code>chat:write</code>. Copy the <strong>Bot User OAuth Token</strong> (<code>xoxb-…</code>) and invite the app to the channel. <Doc href="https://api.slack.com/apps">Slack apps</Doc></>;
  case 'Outline':return <>Outline <strong>Settings → API</strong>, then create a key. The key's user needs read access to the collection. <Doc href="https://www.getoutline.com/developers">Docs</Doc></>;
  case 'Alertmanager':case 'Prometheus':return <>Only needed when a reverse proxy protects {name}. Use a username and password, or a bearer token.</>;
  case 'Toolbox':return <>Prefer a read-only service account, with certificates embedded in the <code>*-data</code> fields. Export one context with <code>kubectl config view --minify --flatten --context NAME</code></>;
  default:return undefined;
 }
}

/** Help that explains how to create a model API key. */
export function modelKeyHelp():ReactNode{
 return <>Create a key in the <Doc href="https://platform.claude.com/settings/keys">Claude Console</Doc> or the <Doc href="https://platform.openai.com/api-keys">OpenAI dashboard</Doc>. Do not include <code>/v1</code> in the base URL.</>;
}

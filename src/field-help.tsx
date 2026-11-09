import type {ReactNode} from 'react';
import {SafeLink} from './SafeLink';
import type {ConnectionName} from './model';

const Doc=({href,children}:{href:string;children:ReactNode})=><SafeLink href={href} target="_blank" rel="noreferrer">{children} ↗</SafeLink>;

/** Help for the service URL field of a connection. */
export function endpointHelp(name:ConnectionName):ReactNode{
 switch(name){
  case 'YouTrack':return <>Base URL of your YouTrack instance, as shown in the browser, for example <code>https://youtrack.example.com</code> or <code>https://example.youtrack.cloud</code>. Do not add <code>/api</code>.</>;
  case 'GitLab':return <>URL of your GitLab instance, for example <code>https://gitlab.example.com</code> or <code>https://gitlab.com</code>. Do not add <code>/api/v4</code>.</>;
  case 'Outline':return <>URL of your Outline workspace, for example <code>https://outline.example.com</code> or <code>https://example.getoutline.com</code>.</>;
  case 'Alertmanager':return <>Alertmanager base URL, for example <code>https://alertmanager.example.com</code>. Do not add <code>/api/v2</code>. Support reads alerts and never creates silences.</>;
  case 'Prometheus':return <>Prometheus base URL, for example <code>https://prometheus.example.com</code>. Do not add <code>/api/v1</code>. Support runs instant queries only.</>;
  case 'Slack':return <>Use <code>https://slack.com/api</code>.</>;
  default:return undefined;
 }
}

/** Help for the scope field of a connection (query, collection, channel, matchers or contexts). */
export function scopeHelp(name:ConnectionName):ReactNode{
 switch(name){
  case 'YouTrack':return <>Same syntax as the YouTrack search bar. Support handles the tickets that this query returns, for example <code>project: INFRA #Unresolved</code>. Try the query in YouTrack first.</>;
  case 'Outline':return <>The collection name shown in Outline's left sidebar, for example <code>DevOps</code>. Case does not matter. You can also paste the collection URL, such as <code>https://outline.example.com/collection/devops-AbC123xyz9</code>, or its ID. <strong>Test</strong> checks that the saved token can read documents in it.</>;
  case 'Slack':return <>Open the channel in Slack, click its name at the top, and copy the <strong>Channel ID</strong> at the bottom of the window. It starts with <code>C</code>. Invite the Support app to this channel.</>;
  case 'Alertmanager':return <>One matcher per line, in Alertmanager syntax, for example <code>severity="critical"</code> or <code>namespace=~"prod-.*"</code>. Each line is sent as an Alertmanager filter, and an alert must match every line. Leave empty to read all alerts.</>;
  default:return undefined;
 }
}

/** Help that explains how to create the credential of a connection. */
export function credentialHelp(name:ConnectionName):ReactNode{
 switch(name){
  case 'YouTrack':return <>In YouTrack, click your avatar, open <strong>Profile → Account Security</strong>, then <strong>New token…</strong>. Select the <strong>YouTrack</strong> scope and copy the token: it starts with <code>perm:</code> and is shown only once. The token acts as your user. Support writes to tickets only after you approve each write. <Doc href="https://www.jetbrains.com/help/youtrack/cloud/manage-permanent-token.html">YouTrack documentation</Doc></>;
  case 'GitLab':return <>Prefer a project or group access token, so that Support only reaches those projects: <strong>Settings → Access tokens → Add new token</strong> in the project or group, role <strong>Developer</strong>, scope <code>api</code>. Use <code>read_api</code> if Support should only investigate. A personal access token also works: avatar → <strong>Edit profile → Access tokens</strong>. <Doc href="https://docs.gitlab.com/user/project/settings/project_access_tokens/">GitLab documentation</Doc></>;
  case 'Slack':return <>Create a Slack app, add the bot token scopes <code>channels:history</code> (<code>groups:history</code> for a private channel) and <code>chat:write</code>, then install the app in your workspace. Copy the <strong>Bot User OAuth Token</strong> from <strong>OAuth &amp; Permissions</strong>: it starts with <code>xoxb-</code>. Invite the app to the support channel. <Doc href="https://api.slack.com/apps">Slack apps</Doc></>;
  case 'Outline':return <>In Outline, open <strong>Settings</strong>, then the API section (named <strong>API</strong> or <strong>API &amp; Apps</strong> depending on the version), and create an API key. The key acts as your user, so that user needs read access to the collection. <Doc href="https://www.getoutline.com/developers">Outline API documentation</Doc></>;
  case 'Alertmanager':case 'Prometheus':return <>Needed only when a reverse proxy protects {name}, for example nginx <code>auth_basic</code>, Envoy or oauth2-proxy. Ask the team that runs it for the username and password, or for a bearer token.</>;
  case 'Toolbox':return <>Export a single context with <code>kubectl config view --minify --flatten --context NAME</code>, or load several files with <strong>Load kubeconfig files…</strong>. Prefer a read-only service account. Certificates must be embedded with the <code>*-data</code> fields.</>;
  default:return undefined;
 }
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {errorRecovery,recoveryMessage} from '../src/error-recovery.js';
import {ErrorNotice} from '../src/ErrorNotice.js';
import {routeHash} from '../src/navigation.js';
import type {ConnectionName} from '../src/model.js';
const route=(message:string,context?:ConnectionName)=>{const action=errorRecovery(message,context);return action?routeHash(action.route):null};
test('Vault access errors from every page lead to Vault without depending on the tool context',()=>{
 for(const context of [undefined,'Model','GitLab','YouTrack','Alertmanager','Toolbox'] as const)for(const message of ['Unlock the credential vault in Settings → Vault first.','Unlock the Vault to read investigations.','Unlock Settings → Vault to view logs.','Polling paused · Vault locked','Incorrect vault passphrase.','Create the vault first.'])assert.equal(route(message,context),'#/settings?section=Vault',message);
});
test('service credentials route to their connection settings; model API keys and subscription accounts route to Model',()=>{
 for(const name of ['YouTrack','GitLab','Alertmanager','Prometheus','Outline','Slack'])assert.equal(route(`Save the ${name} credential in the Vault first.`),`#/settings?section=Connections&tool=${name}`);
 for(const message of ['Save the Model credential in the Vault first.','Save the ChatGPT credential in the Vault first.','Continue with ChatGPT in Settings → Model first.','ChatGPT authentication expired or was revoked. Sign in again.','Sign in to Claude Code in the VM with your Claude subscription, then check the connection in Settings → Model.','Save an API key for the selected model provider first.'])assert.equal(route(message),'#/settings?section=Model',message);
 assert.equal(route('YouTrack rejected the token.','Model'),'#/settings?section=Connections&tool=YouTrack');
 assert.equal(route('Service returned HTTP 401. Check access and configuration.','GitLab'),'#/settings?section=Connections&tool=GitLab');
 assert.equal(route('Connection returned HTTP 403. Check access and endpoint settings.','Model'),'#/logs?step=error&tool=Model');
});
test('configuration failures select the actual tool; Toolbox never asks for a service token',()=>{
 for(const name of ['YouTrack','GitLab','Alertmanager','Prometheus','Outline','Slack','Toolbox'] as ConnectionName[])assert.equal(route(`Configure and enable ${name} in Connections.`),`#/settings?section=Connections&tool=${name}`);
 for(const message of ['Enable Model in Connections and set its API base URL, model ID and vault API key.','Set the absolute path to the Claude executable in Settings → Model.','Could not start Claude CLI. Check its executable path and installation.'])assert.equal(route(message),'#/settings?section=Model');
 assert.equal(route('Toolbox read failed. Check its binary, configuration, context access and response size inside the VM.'),'#/settings?section=Connections&tool=Toolbox');
 assert.equal(route('Map a repository to its full GitLab project path in Settings first.'),'#/settings?section=Repositories');
});
test('usage, outages and generated-request failures do not send users to sign in again',()=>{
 for(const message of ['The provider is rate-limiting requests. Wait before investigating again; your saved connection has been kept.','The usage allowance for this request has been reached. Check ChatGPT Settings → Usage if using your subscription. Signing in again will not reset it.','The provider rejected the model request or tool definition. Review the details below; signing in again will not fix the request.','ChatGPT authentication is temporarily unavailable. Your saved account has been kept.','Conclusion references an unknown tool call.'])assert.equal(route(message,'Model'),'#/logs?step=error&tool=Model',message);
});
test('stale approvals, ambiguous writes, policy blocks and unknown errors never invent a settings fix',()=>{
 for(const message of ['Ticket or plan changed. Review again.','Settings or credentials changed. Review again.','Connection interrupted. Check remote status before retrying any write.','Namespace excluded by Settings.','The current approval is required.','Cross-origin API access is not allowed.','Unexpected failure'])assert.equal(route(message,'GitLab'),null,message);
});
test('error banners retain details, render safe actions and never submit forms or retry writes',()=>{
 const html=renderToStaticMarkup(createElement(ErrorNotice,{message:'Save the Model credential in the Vault first.',context:'Model'}));
 assert.match(html,/Add the model API key in Settings/);assert.match(html,/Open Model settings/);assert.match(html,/type="button"/);assert.doesNotMatch(html,/type="submit"|>Refresh</);
 assert.equal(recoveryMessage('YouTrack rejected the token.'),'YouTrack rejected the token.');
 const unsafe=renderToStaticMarkup(createElement(ErrorNotice,{message:'<script>bad()</script> https://evil.example',context:'GitLab'}));assert.doesNotMatch(unsafe,/<script>|href=/);
});

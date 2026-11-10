# Connections

Unlock the Vault, then open **Settings → Connections → `<connection>`**. The **?** next to each field explains how to create its credential. Support sends credentials over HTTPS only, except to loopback endpoints.

| Connection | Credential |
| --- | --- |
| YouTrack | Permanent token. |
| GitLab | Fine-grained or legacy access token. |
| Slack | Bot token (`xoxb-`). |
| Outline | API key. |
| Alertmanager, Prometheus | None, Basic auth or bearer token. |
| Grafana | Username and password, or service account token. Viewer role with query access to the Prometheus datasources. |
| Toolbox | kubeconfig. |
| Model | API key, Claude Code login or ChatGPT sign-in, in **Settings → Model**. |

## GitLab permissions

The token decides which projects Support can reach. Fine-grained token permissions ([GitLab documentation](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/)):

| Resource | Permission | Needed for |
| --- | --- | --- |
| Project, Pipeline, Job, Repository | Read | Investigations. |
| Merge request | Read, Create | Draft merge requests. |
| Branch | Read, Create | Change branches. |
| Commit | Create | Prepared changes. |

With a legacy token, use the `api` scope. `read_api` allows investigations only. Clones with history (`repo_checkout`) also need `read_repository`.

## Outline scopes

| Scope | Needed for |
| --- | --- |
| `documents:read` | Searching and reading documents. |
| `collections:read` | Listing collections, and finding the collection by name or URL. Not needed when **Allowed collection** is the collection ID. |

Leave **Allowed collection** empty to let the agent search every collection the API key can read.

## Toolbox

Support generates the Toolbox configuration. The configuration is the only access policy for the agent.

1. In **Toolbox behaviour**, set the excluded namespaces and the allowed features, then click **Save settings**.
2. Add the kubeconfig, click **Detect contexts**, and select contexts.
3. Click **Generate configuration**, then **Save settings**.

Generation lists each cluster's namespaces and allows every namespace that matches no exclusion. It needs:

- the `list` permission on `namespaces`
- a reachable cluster for each selected context
- at most 100 allowed namespaces per context

Generate again after namespaces are created.

## Prometheus sources

The agent can query several Prometheus servers. Each one is a source:

| Source | Configured in |
| --- | --- |
| `prometheus` | The Service URL of the Prometheus connection. |
| `grafana/<datasource>` | Each Prometheus datasource of the Grafana connection. Requests go through the Grafana datasource proxy. |
| `<name>` | **Sources through Kubernetes** in the Prometheus connection. Support opens a Toolbox tunnel to the service or StatefulSet on first use. Requires Toolbox port forwarding. |

Example for a federation Prometheus deployed by kube-prometheus-stack: context `monitoring`, namespace `monitoring-federation`, target `service/prometheus-operated`, port `9090`. Click **Test** to open a tunnel and read the Prometheus build information.

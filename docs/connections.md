# Connections

Unlock the Vault, then open **Settings → Connections → `<connection>`**. The **?** next to each field explains how to create its credential. Support sends credentials over HTTPS only, except to loopback endpoints.

| Connection | Credential |
| --- | --- |
| YouTrack | Permanent token. |
| GitLab | Fine-grained or legacy access token. |
| Slack | Bot token (`xoxb-`). |
| Outline | API key. |
| Alertmanager | None, Basic auth or bearer token. |
| Prometheus | Per server: none, Basic auth or bearer token. See [Prometheus servers](#prometheus-servers). |
| Grafana | Username and password, or service account token. Viewer role with query access to the Prometheus datasources. |
| Toolbox | kubeconfig. |
| Model | API key, Claude Code login or ChatGPT sign-in, in **Settings → Model**. |

## GitLab permissions

The token decides which projects Support can reach. A fine-grained token has two parts ([GitLab REST permissions](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/)).

**User:**

| Resource | Permission | Needed for |
| --- | --- | --- |
| Project | Read | Listing the projects the token can reach (`GET /projects`). Without it, the agent finds projects through search or exact paths only. |
| Group | Read | Listing groups (`GET /groups`). |
| Personal access token | Read | The health check: token name and expiry. |
| Global search | Use | Searching code across all projects (`GET /search`). |

**Support's groups or projects:**

| Resource | Permission | Needed for |
| --- | --- | --- |
| Project, Repository, Pipeline, Job | Read | Investigations: files, trees, pipelines, job logs, clones. |
| Global search | Use | Searching code in a group or project. |
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

## Prometheus servers

**Settings → Connections → Prometheus** lists the Prometheus servers the agent can query. **Allow metric queries** enables or disables all of them.

| Kind | Use for | Credential |
| --- | --- | --- |
| URL | A server exposed through an ingress. | None, Basic auth or bearer token, per server. |
| Through Kubernetes | A server that is not exposed. Support opens a Toolbox tunnel to its service or StatefulSet on first use. Requires Toolbox port forwarding. | The Toolbox kubeconfig. |

Each Prometheus datasource of the Grafana connection is also available, as `grafana/<datasource>`.

Example for a federation Prometheus deployed by kube-prometheus-stack, through Kubernetes: context `monitoring`, namespace `monitoring-federation`, target `service/prometheus-operated`, port `9090`. Save the settings, then click **Test** to read the Prometheus build information.

The Prometheus URL of earlier versions becomes a URL server named `prometheus`, with its saved credential.

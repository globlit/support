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
| Kubernetes | Per context: ServiceAccount token, optional CA certificates. See [Kubernetes access](kubernetes-access.md). |
| Model | API key, Claude subscription (Claude Code signed in inside the sandbox) or ChatGPT sign-in, in **Settings → Model**. See [Claude subscription](container.md#claude-subscription-login). |

## YouTrack tickets

**Settings → Connections → YouTrack → New tickets** sets the default project for tickets created from alerts and Slack requests, and default values for its required fields. Each ticket can choose another project. Project lists are cached for 30 minutes; **Refresh the list** reads them again.

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
| `collections:read` | Listing collections, and finding the collection by name or URL. |

Leave **Allowed collection** empty to let the agent search every collection the API key can read.

## Kubernetes

**Settings → Connections → Kubernetes** lists the contexts the agent can read. Import kubeconfig files or add a context by hand, then enable each context the agent may read. Use a ServiceAccount token bound to a read-only role. [Kubernetes access](kubernetes-access.md) gives the RBAC manifest and what works in the sandbox.

## Prometheus servers

**Settings → Connections → Prometheus** lists the Prometheus servers the agent can query. **Allow metric queries** enables or disables all of them.

| Kind | Use for | Credential |
| --- | --- | --- |
| URL | A server exposed through an ingress. | None, Basic auth or bearer token, per server. |
| Through Kubernetes | A server that is not exposed. Support reads it through the API server proxy of a Kubernetes context: `service/NAME` (service port) or a pod name (container port). | The context token, with `get` on `services/proxy` or `pods/proxy` in the namespace. |

Each Prometheus datasource of the Grafana connection is also available, as `grafana/<datasource>`.

Example for a federation Prometheus deployed by kube-prometheus-stack, through Kubernetes: context `monitoring`, namespace `monitoring-federation`, target `service/prometheus-operated`, port `9090`. Save the settings, then click **Test** to read the Prometheus build information.

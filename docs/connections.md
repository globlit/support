# Connections

Unlock the Vault, then add credentials in **Settings → Connections → `<connection>` → Credentials**. The Vault encrypts every credential. Click **Test `<connection>`** to check a connection before you save it.

| Connection | Credential |
| --- | --- |
| YouTrack | API token |
| GitLab | Personal or project access token |
| Slack | Slack token |
| Outline | Optional API key. **Test** reads the allowed collection with it. |
| Alertmanager, Prometheus | None, Basic auth, or bearer token |
| Toolbox | kubeconfig. Support generates the Toolbox configuration. |

Support sends credentials over HTTPS only, except to loopback endpoints.

Use Basic auth when a proxy such as nginx `auth_basic` protects Alertmanager or Prometheus. Each connection uses one authentication mode.

## GitLab

Support uses the projects that the saved GitLab token can access. No project list is configured in Support.

- Give the token access only to the projects that Support may change.
- Prefer a [fine-grained personal access token](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/) (GitLab 18.10 beta, generally available in 19.2), with these permissions:

| Resource | Permission | Used for |
| --- | --- | --- |
| Project | Read | Listing the projects the token can access. |
| Pipeline | Read | Pipeline status and pipeline jobs. |
| Job | Read | Job logs of failed jobs. |
| Repository | Read | Reading files and comparing commits. |
| Merge request | Read, Create | Finding and opening draft merge requests. |
| Branch | Read, Create | Checking and creating the Support branch. |
| Commit | Create | Committing prepared changes. |

  Investigations only need the first four rows. Permission names come from the [REST permission reference](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/).
- With a legacy token, use the `api` scope to create branches and draft merge requests. `read_api` is enough for investigations only.
- When you prepare changes, choose the project. The target branch defaults to the project's default branch.

## Outline

When Outline is enabled, investigations get two read-only tools: `outline_search` searches the allowed collection, and `outline_read` reads one of its documents as Markdown (at most 16,000 characters). Documents outside the allowed collection are refused.

Set **Allowed collection** to the collection name shown in Outline's left sidebar, for example `DevOps`. The collection URL (`https://outline.example.com/collection/devops-AbC123xyz9`) or the collection ID also work. With an API key saved, **Test** finds the collection and lists one of its documents. Without a key, it only checks that Outline responds.

If the Outline API key has scopes, it needs:

| Scope | Used for |
| --- | --- |
| `documents:read` | Listing and reading documents (`documents.list`, `documents.info`, `documents.search`). |
| `collections:read` | Finding the collection by name or URL (`collections.list`). Not needed when **Allowed collection** is the collection ID (UUID). |

Outline matches each scope against the API method namespace, so `documents:read` does not allow `collections.list` ([source](https://github.com/outline/outline/blob/main/shared/helpers/AuthenticationHelper.ts)).

## Model

Configure the model in **Settings → Model**.

| `modelAuth` | Credential |
| --- | --- |
| `api_key` | Anthropic or OpenAI API key. |
| `claude_cli` | Claude Code signed in on the server machine. |
| `chatgpt` | ChatGPT account sign-in. |

## Toolbox

Toolbox requires Linux. Support generates the Toolbox configuration from the settings in **Settings → Connections → Toolbox**. A custom configuration cannot be pasted. The Toolbox configuration is the only policy: Support's agent can do what it allows, and Support adds no restriction on top. See the Toolbox [setup guide](https://github.com/globlit/toolbox/blob/master/docs/setup.md).

### 1. Toolbox behaviour

These settings are saved with **Save settings**:

| Setting | Effect in the Toolbox configuration |
| --- | --- |
| Excluded namespaces | Namespace names or `*` patterns, such as `kube-*` or `*gitlab*`. Every other namespace of each context is allowed. |
| Read ConfigMaps | `disable_configmaps: false`. The agent may read ConfigMaps in allowed namespaces. |
| Read cluster-wide resources | `allow_cluster_scoped: true`. The agent may read nodes, namespaces, persistent volumes, storage classes and the other cluster-scoped resources of the Toolbox catalog. |
| Allow port forwarding | `allow_port_forward: true`. The agent may open temporary tunnels. A tunnel listens on `127.0.0.1` inside Support only. |
| Request timeout, maximum output, tunnel lifetime | `timeout_seconds` (1–120), `max_output_bytes` (1–8 MiB), `port_forward_max_seconds` (1–3,600). |
| Redacted words, redaction patterns | `redaction.literals` and `redaction.patterns` (Go RE2 regular expressions). |

The Kubernetes permissions (RBAC) of the kubeconfig user still apply on top of the configuration.

### 2. Kubeconfig and configuration

1. Paste the kubeconfig, or click **Load kubeconfig files…** and select one or more files. Support merges several files with `kubectl config view --flatten`. It rejects the files when a cluster, user or context name is defined differently in two files, because the merge would keep only the first entry.
2. Click **Detect contexts**, then select the contexts to include. Toolbox accepts at most 100.
3. Click **Generate configuration**. For each selected context, Support lists the cluster's namespaces with kubectl, removes the excluded ones, and allows the rest. Toolbox validates the result. A preview shows the allowed and excluded namespace counts.
4. Click **Save settings**. Support generates the configuration again with the saved behaviour and stores it with the kubeconfig in the Vault.

Requirements and limits:

- The kubeconfig user needs the `list` permission on `namespaces`, and every selected cluster must be reachable when you generate.
- Toolbox accepts at most 100 allowed namespaces per context. Exclude more namespaces when a context has more.
- Namespaces created later are not readable until you generate again.
- Toolbox rejects kubeconfigs that use `exec`, `auth-provider`, `tokenFile`, `insecure-skip-tls-verify` or `proxy-url`. Embed certificates and keys with the `*-data` fields.

When you change the behaviour after generating, the Toolbox page reports it. Click **Apply current settings** to generate again from the saved kubeconfig.

A configuration pasted or set by path before generation existed keeps working until you add a kubeconfig.

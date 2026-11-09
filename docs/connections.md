# Connections

Unlock the Vault, then add credentials in **Settings → Connections → `<connection>` → Credentials**. The Vault encrypts every credential. Click **Test `<connection>`** to check a connection before you save it.

| Connection | Credential |
| --- | --- |
| YouTrack | API token |
| GitLab | Personal or project access token |
| Slack | Slack token |
| Outline | Optional API key. **Test** reads the allowed collection with it. |
| Alertmanager, Prometheus | None, Basic auth, or bearer token |
| Toolbox | Toolbox JSON and kubeconfig, or a configuration path |

Support sends credentials over HTTPS only, except to loopback endpoints.

Use Basic auth when a proxy such as nginx `auth_basic` protects Alertmanager or Prometheus. Each connection uses one authentication mode.

## GitLab

Support uses the projects that the saved GitLab token can access. No project list is configured in Support.

- Give the token access only to the projects that Support may change. A project or group access token limits that access in GitLab.
- The token needs the `api` scope to create branches and draft merge requests. `read_api` is enough for investigations only.
- When you prepare changes, choose the project. The target branch defaults to the project's default branch.

## Outline

Set **Allowed collection** to the collection name shown in Outline's left sidebar, for example `DevOps`. The collection URL (`https://outline.example.com/collection/devops-AbC123xyz9`) or the collection ID also work. With an API key saved, **Test** finds the collection and lists one of its documents. Without a key, it only checks that Outline responds.

## Model

Configure the model in **Settings → Model**.

| `modelAuth` | Credential |
| --- | --- |
| `api_key` | Anthropic or OpenAI API key. |
| `claude_cli` | Claude Code signed in on the server machine. |
| `chatgpt` | ChatGPT account sign-in. |

## Toolbox

Toolbox requires Linux. In **Settings → Connections → Toolbox**, paste the kubeconfig and the Toolbox JSON, or set a path to a Toolbox JSON file. A pasted configuration takes priority. See the Toolbox [setup guide](https://github.com/globlit/toolbox/blob/master/docs/setup.md).

To generate the Toolbox JSON from the kubeconfig:

1. Paste the kubeconfig, or click **Load kubeconfig files…** and select one or more files. Support merges several files into one kubeconfig with `kubectl config view --flatten`. It rejects the files when a cluster, user or context name is defined differently in two files, because the merge would keep only the first entry.
2. Click **Generate configuration from kubeconfig**. Support runs `toolbox config generate --detect-contexts` and fills the Toolbox JSON field.
3. Edit the namespaces. Each detected context allows only the `default` namespace.
4. List the contexts that Support may read in **Allowed context names**.
5. Click **Save settings**.

For a pasted configuration:

- Set `kubectl.kubeconfig` to `"{{kubeconfig}}"`. Support replaces it with a temporary kubeconfig path for each read.
- Set `kubectl.binary` to an absolute kubectl path where Support runs, for example `/usr/local/bin/kubectl`.
- Embed certificates and keys with the kubeconfig `*-data` fields.

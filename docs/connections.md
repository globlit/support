# Connections

Unlock the Vault, then add credentials in **Settings → Connections → `<connection>` → Credentials**. The Vault encrypts every credential. Click **Test `<connection>`** to check a connection before you save it.

| Connection | Credential |
| --- | --- |
| YouTrack | API token |
| GitLab | Personal or project access token |
| Slack | Slack token |
| Outline | Optional bearer token. Health check only. |
| Alertmanager, Prometheus | None, Basic auth, or bearer token |
| Toolbox | Toolbox JSON and kubeconfig, or a configuration path |

Support sends credentials over HTTPS only, except to loopback endpoints.

Use Basic auth when a proxy such as nginx `auth_basic` protects Alertmanager or Prometheus. Each connection uses one authentication mode.

## Model

Configure the model in **Settings → Model**.

| `modelAuth` | Credential |
| --- | --- |
| `api_key` | Anthropic or OpenAI API key. |
| `claude_cli` | Claude Code signed in on the server machine. |
| `chatgpt` | ChatGPT account sign-in. |

## Toolbox

Toolbox requires Linux. In **Settings → Connections → Toolbox**, paste the Toolbox JSON and the kubeconfig, or set a path to a Toolbox JSON file. A pasted configuration takes priority. See the Toolbox [setup guide](https://github.com/globlit/toolbox/blob/master/docs/setup.md).

For a pasted configuration:

- Set `kubectl.kubeconfig` to `"{{kubeconfig}}"`. Support replaces it with a temporary kubeconfig path for each read.
- Set `kubectl.binary` to an absolute kubectl path in the VM, for example `~/.local/bin/kubectl`.
- Embed certificates and keys with the kubeconfig `*-data` fields.

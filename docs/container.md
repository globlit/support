# Container

The `Dockerfile` builds an image with Support and kubectl. kubectl merges imported kubeconfig files. The image does not contain Claude Code. Claude Code runs in the command sandbox. The image runs as user `node` (uid 1000).

```shell
docker build -t support .
docker run -d --name support -p 127.0.0.1:4173:4173 -v support-data:/data support
```

Open `http://127.0.0.1:4173` and create the Vault passphrase. The Vault locks at every restart.

- Publish the port on `127.0.0.1` only.
- To use another host port, set both values: `-p 127.0.0.1:8080:4173 -e SUPPORT_PUBLIC_ORIGIN=http://127.0.0.1:8080`.
- Back up the `support-data` volume. It contains the database, the Vault and the logs.

## Support with the command sandbox

`compose.yaml` starts Support and its command sandbox. The agent's Claude Code sessions and shell commands run in the sandbox. The sandbox contains no Vault credentials. Support tools, Kubernetes reads and Git clones go through Support's agent gateway (port 7072) and Git proxy (port 7071), which add the credentials. Model requests depend on the model connection: with an API key they go through the gateway, and with a Claude subscription Claude Code sends them to Anthropic with its own login.

1. Run `docker compose up -d --build` in the repository folder.
2. Open `http://127.0.0.1:4173`.
3. Choose the model connection in **Settings → Model**. For a Claude subscription, follow [Claude subscription login](#claude-subscription-login).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_ACCESS_PATH` | `$HOME/claude_access` | Host folder shared with agent sessions. Mounted read-write in the sandbox and read-only in Support, at the same path. Agent sessions use its `.claude` folder as Claude Code configuration. |

Sandbox properties:

- The image is built from `sandbox/Dockerfile`. It contains Claude Code, kubectl, Helm, Flux, kustomize, the Argo CD CLI, yq, jq, git, curl and Python.
- Agent sessions get a kubeconfig with the enabled Kubernetes contexts. Each context points at the agent gateway, which adds the context token. See [Kubernetes access](kubernetes-access.md).
- Outgoing traffic to private, shared and link-local IPv4 ranges is rejected. Exceptions: DNS, and Support's Git proxy (7071) and agent gateway (7072).
- `sandbox/server.py` runs as `sandboxd`. Commands and agent sessions run as `admin`, and cannot signal the server.
- Only the `support` service reaches the sandbox, on the `agent` network (`172.31.251.0/24`).

## Claude subscription login

In **Settings → Model**, choose Claude and **Claude subscription · sandbox login**. Claude Code signs in inside the sandbox. Support does not store the login and has no `claude` binary.

1. Run `docker compose exec -u admin -e CLAUDE_CONFIG_DIR=$CLAUDE_ACCESS_PATH/.claude sandbox claude auth login`. Choose your Claude subscription.
2. In **Settings → Model**, click **Test Model**. Support runs `claude auth status` in the sandbox. The Model card on the Agent work page shows the result.

Claude Code writes the login to `$CLAUDE_ACCESS_PATH/.claude` and sends model requests to Anthropic directly. Support does not read or relay those requests. This mode needs **Let the agent run commands** on, with the sandbox and gateway available. The built-in agent loop refuses to start otherwise.

Risk: the agent can read the login file, and the sandbox can reach any public host. A malicious instruction in a ticket, alert or log can send the login out. Use a dedicated Claude account for Support, and sign it out if you suspect a leak. Anthropic restricts how subscription credentials may be used. Check the [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) before relying on this mode.

To use an API key instead, choose **API key** and save it in the Vault. The gateway adds the key to model requests and the sandbox holds a placeholder.

## Without Compose

To run Support without Compose, set `SUPPORT_SANDBOX_URL` to the sandbox server URL and `SUPPORT_RELAY_BIND` to an address of Support that the sandbox can reach. The Git proxy port is set by `SUPPORT_GIT_PROXY_PORT` (default 7071) and the agent gateway port by `SUPPORT_GATEWAY_PORT` (default 7072).


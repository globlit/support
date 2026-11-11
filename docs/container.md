# Container

The `Dockerfile` builds an image with Support, kubectl, Toolbox and the Claude Code CLI. The image runs as user `node` (uid 1000).

```shell
docker build -t support .
docker run -d --name support -p 127.0.0.1:4173:4173 -v support-data:/data support
```

Open `http://127.0.0.1:4173` and create the Vault passphrase. The Vault locks at every restart.

- Publish the port on `127.0.0.1` only.
- To use another host port, set both values: `-p 127.0.0.1:8080:4173 -e SUPPORT_PUBLIC_ORIGIN=http://127.0.0.1:8080`.
- Back up the `support-data` volume. It contains the database, the Vault and the logs.

## Claude Code login

To use the Claude Code CLI as the model:

1. Run `docker exec -it support claude auth login`.
2. In **Settings → Model**, set the executable path to `/home/node/.local/bin/claude`.

Mount `/home/node/.claude` to keep the login when the container is recreated.

## Support with the command sandbox

`compose.yaml` starts Support and its command sandbox. The agent's Claude Code sessions and shell commands run in the sandbox. The sandbox contains no credentials. Model requests, Support tools and Git clones go through Support's agent gateway (port 7072) and Git proxy (port 7071), which add the credentials.

1. Write the Claude subscription token to `~/.config/support/claude_oauth_token`. Skip this step when the model uses an API key from the Vault.
2. Run `docker compose up -d --build` in the repository folder.
3. Open `http://127.0.0.1:4173`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_ACCESS_PATH` | `$HOME/claude_access` | Host folder shared with agent sessions. Mounted read-write in the sandbox and read-only in Support, at the same path. Agent sessions use its `.claude` folder as Claude Code configuration. |
| `SUPPORT_PROVISION_PATH` | `$HOME/.config/support` | Host folder with `claude_oauth_token`. Mounted in Support only. Keep it outside `CLAUDE_ACCESS_PATH`. |

Sandbox properties:

- The image is built from `sandbox/Dockerfile`. It contains Claude Code, kubectl, Helm, Flux, kustomize, the Argo CD CLI, yq, jq, git, curl and Python.
- Outgoing traffic to private, shared and link-local IPv4 ranges is rejected. Exceptions: DNS, and Support's Git proxy (7071), agent gateway (7072) and tunnel relays (32768-60999).
- `sandbox/server.py` runs as `sandboxd`. Commands and agent sessions run as `admin`, and cannot signal the server.
- Only the `support` service reaches the sandbox, on the `agent` network (`172.31.251.0/24`).

To run Support without Compose, set `SUPPORT_SANDBOX_URL` to the sandbox server URL and `SUPPORT_RELAY_BIND` to an address of Support that the sandbox can reach. The Git proxy port is set by `SUPPORT_GIT_PROXY_PORT` (default 7071) and the agent gateway port by `SUPPORT_GATEWAY_PORT` (default 7072).


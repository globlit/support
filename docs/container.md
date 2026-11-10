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

## Command sandbox

Set `SUPPORT_SANDBOX_URL` to let the agent run shell commands in a separate sandbox service. Set `SUPPORT_RELAY_BIND` to an address of Support that the sandbox can reach, so that sandbox commands can use port-forward tunnels and clone GitLab repositories through the Git proxy on port 7071 (`SUPPORT_GIT_PROXY_PORT`). The claude-jail compose file sets both.

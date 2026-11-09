# Support

Investigate YouTrack tickets, Alertmanager alerts, and Slack requests with a language model. Review the plan in a browser. Support writes to GitLab, YouTrack, or Slack only after you approve each write.

## Start

Install Node.js 24.5 or newer, then run:

```shell
git clone https://github.com/globlit/support.git
cd support
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4173`, create the Vault passphrase, and add [connections](docs/connections.md). The Vault locks on every restart. Unlock it to resume polling.

To run Support in a container:

```shell
docker build -t support .
docker run -d --name support -p 127.0.0.1:4173:4173 -v support-data:/data support
```

See the [container guide](docs/container.md).

Support shows desktop notifications through the browser. Allow them in **Settings → Notifications**.

## Configuration

Set these variables before startup. In a container, pass them with `docker run -e`.

| Variable | Default | Description |
| --- | --- | --- |
| `SUPPORT_DEPLOYMENT` | `local` | `local` or `container`. |
| `SUPPORT_PORT` | `4173` | Listener port, 1024 to 65535. |
| `SUPPORT_BIND_HOST` | `127.0.0.1` | Listener address. `local` mode accepts loopback only. |
| `SUPPORT_PUBLIC_ORIGIN` | Listener origin | Browser origin. Required in `container` mode. |
| `SUPPORT_SESSION_SECONDS` | `43200` | Browser session lifetime, 300 to 43200. |
| `SUPPORT_DATA_DIR` | `.support-data` | Database, Vault, and logs. Back it up. |
| `SUPPORT_TOOLBOX_BINARY` | `/usr/local/bin/toolbox` | Toolbox binary path. |

## Reference

- [Connections](docs/connections.md)
- [Container](docs/container.md)
- [Architecture and development](docs/architecture.md)
- [Local test services](dev-services/README.md)

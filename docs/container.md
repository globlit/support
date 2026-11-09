# Container

Run Support in a Linux container. The `Dockerfile` at the repository root builds an image with Support, kubectl, Toolbox and the Claude Code CLI. The image runs as user `node` (uid 1000).

## Build

```shell
docker build -t support .
```

## Run

```shell
docker run -d --name support \
  -p 127.0.0.1:4173:4173 \
  -v support-data:/data \
  support
```

Open `http://127.0.0.1:4173`, create the Vault passphrase, and add [connections](connections.md). The Vault locks on every restart. Unlock it to resume polling.

- Publish the port on `127.0.0.1` only. Support accepts browser requests only when the `Host` header matches `SUPPORT_PUBLIC_ORIGIN`.
- The `support-data` volume contains the database, the Vault and the logs. Back it up.
- To publish another host port, change both values: `-p 127.0.0.1:8080:4173 -e SUPPORT_PUBLIC_ORIGIN=http://127.0.0.1:8080`.

## Image settings

The image sets these variables. See [Configuration](../README.md#configuration) for all variables.

| Variable | Value |
| --- | --- |
| `SUPPORT_DEPLOYMENT` | `container` |
| `SUPPORT_BIND_HOST` | `0.0.0.0` |
| `SUPPORT_PORT` | `4173` |
| `SUPPORT_PUBLIC_ORIGIN` | `http://127.0.0.1:4173` |
| `SUPPORT_DATA_DIR` | `/data` |
| `SUPPORT_TOOLBOX_BINARY` | `/usr/local/bin/toolbox` |

## Claude subscription sign-in

The **Claude subscription** model option runs the Claude Code CLI in the container. It needs a CLI login:

1. Sign in:
   ```shell
   docker exec -it support claude auth login
   ```
2. In **Settings → Model**, set the Claude executable path to `/home/node/.local/bin/claude`.
3. Click **Test Model**.

The login is stored in `/home/node/.claude` in the container. Mount a volume there to keep it when the container is recreated: `-v support-claude:/home/node/.claude`.

## Toolbox configuration file

A pasted or generated Toolbox configuration in **Settings → Connections → Toolbox** needs no mount. To use a configuration file instead, mount its folder and enter its container path in **Toolbox JSON configuration path**:

| Example mount | Path in Settings |
| --- | --- |
| `-v ~/.config/toolbox:/config/toolbox:ro` | `/config/toolbox/config.json` |

Support reads and changes code through the GitLab API only. It needs no repository mount.

## Notifications

Support shows desktop notifications through the browser. Open **Settings → Notifications**, click **Allow notifications**, then **Send test notification**. Notifications appear while a Support tab is open in that browser, including a background tab.

# systemd service

Run Support as the user service `support.service` in the Ubuntu VM. The service binds `127.0.0.1:4173` and restarts after a crash.

## Install

Run as the VM user, not `root`, in a checkout of this repository. Stop any `npm start` process first.

```shell
deployment/systemd/supportctl install
```

The command installs missing packages with `sudo apt-get`. It installs Node.js, Claude Code, kubectl, and Toolbox if they are missing, and verifies each download. Then it builds Support, enables linger, and starts the service.

Expected result: each `supportctl check` line shows `ok` or `warn`. If a line shows `fail`, run `supportctl logs -n 100`.

For the `claude_cli` model mode, run `claude auth login` once.

## Provision

Run these steps as `root` from your VM provisioner:

1. Install `curl`, `git`, `tar`, `gzip`, `coreutils`, and `ca-certificates`.
2. Run `loginctl enable-linger <user>`. Wait until `/run/user/<uid>/bus` exists.
3. Clone this repository as `<user>`.
4. Run `deployment/systemd/supportctl install` as `<user>` with `HOME`, `XDG_RUNTIME_DIR=/run/user/<uid>`, and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`.

## Commands

| Command | Action |
| --- | --- |
| `supportctl start`, `stop`, `restart` | Control the service. A restart locks the Vault. |
| `supportctl status` | Show the systemd status. |
| `supportctl logs [ARGS]` | Follow the log. Pass `journalctl` options, for example `-n 200`. |
| `supportctl rebuild` | Reinstall dependencies, rebuild, rewrite the unit, and restart. |
| `supportctl update` | Run `git pull --ff-only`, then `rebuild`. |
| `supportctl check` | Check tools, the unit, the service, the port, and linger. |
| `supportctl unit` | Print the unit. |
| `supportctl uninstall` | Remove the service. Data and the checkout remain. |

Data goes to `.support-data/` in the checkout. Run `supportctl rebuild` after you move the checkout or change Node.js.

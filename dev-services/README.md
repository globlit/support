# Local integration services

Actual products for local development. Nothing is published beyond 127.0.0.1.
Use these URLs when the support app runs on this same host:

| Service | URL | Container RAM cap |
| --- | --- | --- |
| YouTrack | http://127.0.0.1:8080 | 2048 MiB |
| GitLab CE | http://127.0.0.1:8929 | 3072 MiB |
| Prometheus | http://127.0.0.1:9090 | 256 MiB |
| Alertmanager | http://127.0.0.1:9093 | 128 MiB |
| Project CI runner | No published port | 256 MiB |

Total hard memory cap including the test runner: 5760 MiB. Containers cannot use swap and do not restart
on failure or host reboot. CPU and Docker log sizes are bounded. This is a
small test installation, not a production configuration. Unrelated workloads
are not managed by this Compose project. Check `free -h` before starting it.

From the repository root:

```sh
# First installation only, before starting YouTrack: persist its smaller heap.
docker compose -f dev-services/compose.yaml run --rm --no-deps youtrack configure -J-Xmx768m -J-Xms256m

# Start containers, preferably one heavy service at a time.
docker compose -f dev-services/compose.yaml up -d prometheus alertmanager
docker compose -f dev-services/compose.yaml up -d youtrack
docker compose -f dev-services/compose.yaml up -d gitlab

# Inspect memory and service status.
docker compose -f dev-services/compose.yaml ps
docker stats --no-stream $(docker compose -f dev-services/compose.yaml ps -q)

# Stop this stack and release RAM; retain all product data.
docker compose -f dev-services/compose.yaml stop
```

All product data is in named `support-lab_*` Docker volumes. Do not use
`down -v` unless you intend to permanently delete that data. The support app's
`.support-data` and configuration are separate and remain untouched.

## First-time setup

On a fresh volume, YouTrack requires its setup wizard to create the instance and administrator.
The current local instance has already been initialized by the user.
Retrieve its setup URL locally (it contains a secret) with:

```sh
docker compose -f dev-services/compose.yaml logs youtrack | rg 'wizard|token='
```

Use the local URL above if a displayed container hostname is unreachable.
Complete the license and account setup yourself. Create a support project and
an API token, then configure the URL, project/query and token in the support
app. YouTrack is configured with a 768 MiB JVM heap; the remaining memory is
reserved for native memory, bundled services and its database. The original
1536 MiB container cap was insufficient during installation; 2048 MiB is
configured after a verified recovery.

GitLab's initial account is `root`. Retrieve the generated password privately:

```sh
docker compose -f dev-services/compose.yaml exec gitlab cat /etc/gitlab/initial_root_password
```

Change it after login. The initial password file is automatically deleted by
GitLab after its initial grace period on subsequent reconfiguration. Create a
project and an API token with the scopes needed by the support app, then save
these in app settings. Use HTTP cloning; SSH is not published. Image versions and digests are pinned. A project-only runner is now installed for `root/support-flow-demo`. It runs one
job at a time, capped at 256 MiB / 0.5 CPU. Its shell executor runs inside the
runner container as UID 100, not on the host. Only its private configuration
folder and build volume are mounted; there is no Docker socket or privileged
mode. The job user cannot read the runner configuration. Use this runner only
for this disposable test project; it is not isolation between untrusted jobs.
Its configuration lives in the ignored `.support-data/local-lab/runner-config`
folder (directory mode 0700, config file 0600). Preserve it across restarts.


Prometheus scrapes itself and Alertmanager every minute, uses a one-day/100 MB retention target
(the WAL and active head add disk usage), and forwards alerts to Alertmanager. A synthetic alert rule is installed for the test exercise below. No outbound
notification receivers are enabled. `up` is a useful first
PromQL query. Alertmanager receives the synthetic warning from Prometheus. Configure its URL in the support app to test polling.

Configuration follows the official [GitLab low-memory guide](https://docs.gitlab.com/omnibus/settings/memory_constrained_envs/)
and [YouTrack installation instructions](https://www.jetbrains.com/help/youtrack/server/youtrack-docker-installation.html).

GitLab restricts its health endpoint by source IP. Check it from inside the
container (a host request can return 404 even when the sign-in page works):

```sh
docker compose -f dev-services/compose.yaml exec gitlab curl -fsS http://127.0.0.1:8929/-/readiness
```

## Seeded approval exercise

- YouTrack project: **Support Lab (LAB)**; ticket: [LAB-1](http://127.0.0.1:8080/issue/LAB-1).
- GitLab project: [root/support-flow-demo](http://127.0.0.1:8929/root/support-flow-demo).
- Repository checkout: `.support-data/local-lab/repositories/support-flow-demo`.
- Alert: `SupportLabRunbookMissing`, labels `test=true`, `cluster=local-lab`.
- The support app is configured with local endpoints, query `project: LAB`,
  the repository mapping and encrypted YouTrack/GitLab credentials.
- GitLab app credential: Developer access to this project only, API scope,
  expires 2026-11-14. The temporary admin bootstrap credential was revoked;
  plaintext bootstrap and app-token copies were removed.
- Automatic investigation is disabled. No model is configured.

The engineer explicitly requested creation of the test fixtures. The ticket
was created through the app's existing reviewed ticket-creation path, and the
manual alert plan was carried into its YouTrack work session. Neither the
alert plan nor the ticket plan is approved. No remediation branch, MR, ticket
resolution comment or closure was created.

Open the support app, switch to YouTrack, and select LAB-1. Read the full plan,
request a revision or edit it, then approve it when satisfied. The inherited
alert plan never grants approval to the ticket. Branch preparation still
requires an approved model connection to generate the file contents; a manual
plan does not substitute for that connection. Do not approve a dummy model or
bypass the approval checks to continue.

Once a real approved model is configured, re-review the plan because settings
changes invalidate approvals. Select this repository and `docs/runbook.md`.
Review the resulting diff before approving MR creation. The app creates a draft
MR; mark it ready and merge it manually in GitLab when satisfied. The runner
checks that the runbook exists, is nonempty and is under 32 KiB. Content review
remains the engineer's job. After the main-commit pipeline passes, return to
the app for separate resolution-message and ticket-close approvals.

The synthetic rule automatically stops firing eight hours after it was seeded.
Its absolute expiry is stored in `support-lab.rules.yml`; container restarts do
not extend it. It does not represent an outage, and merging documentation does
not clear it. To stop it early, remove the test rule (or its `rule_files` entry)
and restart only Prometheus. Allow one evaluation interval for delivery/state
changes. For a recurrence test, extend the rule expiry later and restart
Prometheus with the same labels; the existing case and ticket should be reused.

Verified against these actual services: alert ingestion and ticket listing,
manual plan handoff with approval cleared, repeated-poll deduplication,
unapproved branch preparation rejected with HTTP 409, and baseline CI success.
The future model/branch/MR/merge/resolution sequence is not yet exercised.

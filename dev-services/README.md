# Local test services

Run YouTrack, GitLab, Prometheus, and Alertmanager on `127.0.0.1` to test Support. The stack needs about 6 GiB of free memory.

| Service | URL |
| --- | --- |
| YouTrack | http://127.0.0.1:8080 |
| GitLab CE | http://127.0.0.1:8929 |
| Prometheus | http://127.0.0.1:9090 |
| Alertmanager | http://127.0.0.1:9093 |

## Start

Before the first YouTrack start, set its heap:

```sh
docker compose -f dev-services/compose.yaml run --rm --no-deps youtrack configure -J-Xmx768m -J-Xms256m
```

Start one heavy service at a time:

```sh
docker compose -f dev-services/compose.yaml up -d prometheus alertmanager
docker compose -f dev-services/compose.yaml up -d youtrack
docker compose -f dev-services/compose.yaml up -d gitlab
```

Stop the stack with `docker compose -f dev-services/compose.yaml stop`. Do not run `down -v`. It deletes all lab data.

## First-time setup

1. Get the YouTrack setup URL and complete the wizard:

   ```sh
   docker compose -f dev-services/compose.yaml logs youtrack | rg 'wizard|token='
   ```

2. Get the GitLab `root` password and change it after login:

   ```sh
   docker compose -f dev-services/compose.yaml exec gitlab cat /etc/gitlab/initial_root_password
   ```

3. Create a YouTrack project, a GitLab project, and an API token for each. Add them in Support.

## Test exercise

- YouTrack ticket: [LAB-1](http://127.0.0.1:8080/issue/LAB-1).
- GitLab project: [root/support-flow-demo](http://127.0.0.1:8929/root/support-flow-demo).
- Alert: `SupportLabRunbookMissing` with labels `test=true` and `cluster=local-lab`.

Open LAB-1 in Support, review the plan, and approve it. Configure a model to prepare the branch. Select `docs/runbook.md`, review the diff, and approve the merge request. Merge it in GitLab, then approve the resolution and closure in Support.

The synthetic alert stops firing eight hours after it was seeded. To stop it earlier, remove the rule from `support-lab.rules.yml` and restart Prometheus.

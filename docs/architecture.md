# Architecture

YouTrack is the source of truth for tickets. Support stores plans, approvals, write intents and the investigation queue in SQLite.

| Path | Content |
| --- | --- |
| `src/` | React UI. `src/model.ts` defines the configuration schema. |
| `server/` | HTTP API, connectors, agent loop and approvals. Entry point: `server/index.ts`. |
| `tests/` | Tests. |

## Agent

The model reads with tools and returns a plan. Writes to GitLab, YouTrack and Slack happen after engineer approval only.

- Service tools run in the Support server with Vault credentials.
- `run_command` runs in the command sandbox, which has no credentials.
- `repo_checkout` clones a GitLab repository with its history in the sandbox, through a read-only Git proxy in Support that adds the Vault token. The proxy refuses pushes, and its URLs stop working when the run ends. Without `SUPPORT_RELAY_BIND`, Support uploads an archive without history instead.
- `propose_change` saves the edited files as a proposal. A branch and merge request are created from a proposal only after plan approval and diff review.
- Prometheus tools query any configured source: the direct server, Grafana datasources, or a per-cluster server through a Toolbox tunnel. See [Connections](connections.md#prometheus-sources).
- **Settings → Model → Agent instructions** is added to the system prompt after fixed rules: untrusted tool output, no writes, no secrets, and the plan format.
- With a Claude API key, the agent can also use the provider's web search and fetch tools.
- The engineer can message a running investigation. The agent reads each message before its next step. `ask_engineer` questions do not pause the run. Unanswered questions are listed in the plan.
- A failed tool call is returned to the model, which can adapt. Limits are set in **Settings → Agent**.
- **Stop all** in the agent console stops every run, command and tunnel. It blocks new runs until **Resume**.

## Investigation queue

Intake adds eligible tickets, alerts and Slack threads to the queue. The queue starts the oldest entry when a slot is free.

- A failed automatic investigation is retried once after 60 seconds. A second failure moves it to the dead letter.
- If **Continue with other tickets while plans await review** is off, each plan waiting for review uses a slot until the engineer approves, ignores or resolves it.

## Development

| Command | Action |
| --- | --- |
| `npm start` | Start the server from sources. |
| `npm run build` | Type-check and build the UI. |
| `npm test` | Run all tests. |

Rules:

- Do not add a second ticket store.
- Route each external write through an approval and a durable intent record.
- Do not give the model write tools or credentials.

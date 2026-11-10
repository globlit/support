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

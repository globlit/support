# Architecture

YouTrack is the source of truth for tickets. Support stores plans, approvals, and write intents in SQLite.

| Path | Content |
| --- | --- |
| `src/` | React UI. `src/model.ts` defines the configuration schema. |
| `server/` | HTTP API, connectors, model loop, and approvals. Entry point: `server/index.ts`. |
| `Dockerfile` | Container image. See [Container](container.md). |
| `dev-services/` | Local test services. |
| `tests/` | Tests. |

The model uses read-only tools and returns a plan. After approval, separate services write to GitLab, YouTrack, and Slack. Each write needs its own approval.

## Development

| Command | Action |
| --- | --- |
| `npm start` | Start the server from sources. |
| `npm run build` | Type-check and build the UI. |
| `npm test` | Run all tests. |

Rules:

- Do not add a second ticket store.
- Route each external write through an approval and a durable intent record.
- Do not give the model write tools, credentials, or shell access.

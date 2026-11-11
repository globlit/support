# Architecture

YouTrack is the source of truth for tickets. Support stores plans, approvals, write intents and the investigation queue in SQLite.

| Path | Content |
| --- | --- |
| `src/` | React UI. `src/model.ts` defines the configuration schema. |
| `server/` | HTTP API, connectors, agent loop and approvals. Entry point: `server/index.ts`. |
| `tests/` | Tests. |

## Agent

With the Claude provider and **Let the agent run commands** on, each investigation is a Claude Code session in the command sandbox. Otherwise, the built-in agent loop runs in the Support server.

- **Environment:** the session runs as `admin` in `~/claude_access/.support-agent/work/<source>-<key>`. Your `~/claude_access` is mounted at the same path and `CLAUDE_CONFIG_DIR` is `~/claude_access/.claude`, so the agent uses your CLAUDE.md files, settings, skills, plugins and memory.
- **Tools:** all Claude Code tools (Bash, files, web, sub-agents), plus the Support tools over MCP: Toolbox, Prometheus, Grafana, Outline, GitLab, YouTrack, Alertmanager. In Bash and scripts, `kubectl` (read-only, through Toolbox) and `support <tool> '<json>'` call the same tools.
- **Credentials:** the sandbox has a placeholder credential. The agent gateway in Support (port 7072 on the relay address) replaces it with the real one for model requests only. Gateway URLs contain a session token that expires with the session.
- **Results:** the agent ends with `submit_result`: diagnosis, plan, questions or inconclusive. Only a plan from a session with successful checks becomes a plan version that can be approved. The first `submit_result` returns a review reminder.
- **Conversation:** the Investigation step shows the runs of a request as one conversation. Each run is a work block between the engineer turn that started it and its result; plan versions appear where they were produced. The message box continues the latest session of the shown branch (answers, comments, queued plan comments). **Recheck the request** continues it with the current ticket data. **Start over** opens a new session. **Restart from this version** on an older plan card branches from the session that produced that version. Each run forks the session it builds on, so branches stay independent. **Implement with the agent**, after approval, continues the session of the run that produced the approved plan.
- **Tool usage:** each run and the dashboard count tool calls: shell commands by their first program, Support tools by integration.
- **Approvals:** **Cancel approval** returns a plan to review, except while a GitLab write for it needs verification. Writes to GitLab, YouTrack and Slack still need engineer approval.
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

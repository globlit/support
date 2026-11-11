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
- **Tools:** all Claude Code tools (Bash, files, web, sub-agents), plus the Support tools over MCP: Prometheus, Grafana, Outline, GitLab, YouTrack, Alertmanager. In Bash and scripts, `support <tool> '<json>'` calls the same tools. `kubectl` and `flux` read the enabled Kubernetes contexts through the gateway, read-only; see [Kubernetes access](kubernetes-access.md).
- **Credentials:** the sandbox has no Vault credential. Support tools, Kubernetes reads and Git clones go through the agent gateway and the Git proxy in Support, which add the credentials. Model requests depend on the connection: with an API key, the sandbox has a placeholder and the gateway adds the key. With a Claude subscription, Claude Code is signed in inside the sandbox and calls Anthropic directly. Gateway URLs contain a session token that expires with the session.
- **Results:** the agent ends with `submit_result`: diagnosis, plan, questions or inconclusive. Only a plan from a session with successful checks becomes a plan version that can be approved. The first `submit_result` returns a review reminder.
- **Conversation:** the Investigation step shows the runs of a request as one conversation. Each run is a work block between the engineer turn that started it and its result; plan versions appear where they were produced. The message box continues the latest session of the shown branch (answers, comments, queued plan comments). **Recheck the request** continues it with the current ticket data. **Start over** opens a new session. **Restart from this version** on an older plan card branches from the session that produced that version. Each run forks the session it builds on, so branches stay independent. **Implement with the agent**, after approval, continues the session of the run that produced the approved plan.
- **Tool usage:** each run and the dashboard count tool calls: shell commands by their first program, Support tools by integration.
- **Approvals:** **Cancel approval** returns a plan to review, except while a GitLab write for it needs verification. Writes to GitLab, YouTrack and Slack still need engineer approval.
- **Stop all** in the agent console stops every run and command. It blocks new runs until **Resume**.

## Components and network

Compose starts two services on the private `agent` network (`172.31.251.0/24`). Both services have internet access.

```
Engineer browser ── http://127.0.0.1:4173
        │
   ┌────▼─────────────────────┐        ┌───────────────────────────────┐
   │ support       172.31.251.10 │        │ sandbox        172.31.251.20 │
   │ UI and API          4173    │        │ sandbox server       7070    │
   │ Vault, SQLite       /data   │ 7070 ─►│ Claude Code, kubectl, flux,  │
   │ Connectors                  │        │ helm, git                    │
   │ Agent gateway       7072 ◄──┼────────┤ tools, Kubernetes, model*    │
   │ Git proxy           7071 ◄──┼────────┤ git clone and fetch          │
   └─────────────────────────────┘        └──────────────┬────────────────┘
                                                         ▼
                                          Anthropic API (subscription mode)
```

\* The model route of the gateway serves API key mode only.

### Sandbox network access

| Destination | Result |
| --- | --- |
| Loopback and the DNS nameservers of `resolv.conf` | Allowed |
| Support, TCP 7071 and 7072 | Allowed |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16` | Rejected |
| Public internet | Allowed. The agent uses Web tools, and the sandbox can send data to any public host. |

### Credentials

| Credential | Location | In the sandbox |
| --- | --- | --- |
| YouTrack, GitLab, Slack, Outline, Alertmanager, Grafana, Prometheus, Kubernetes tokens | Vault in Support | No |
| API key of the model | Vault in Support | No. Placeholder only. |
| Claude subscription login | Claude configuration folder in the sandbox | Yes. The agent can read it. |
| Session token | Gateway URL | Yes, until the session ends |

### Connections

| Connection | Caller | Path |
| --- | --- | --- |
| Model, API key | Claude Code in the sandbox | Gateway `/<token>/v1/messages`, then the provider. The gateway adds the key and records usage and rate limits. |
| Model, Claude subscription | Claude Code in the sandbox | Directly to Anthropic with its own login. Support runs `claude auth status` in the sandbox to check the login. |
| Model, OpenAI or ChatGPT | Built-in agent loop in Support | Directly to the provider |
| YouTrack, Alertmanager, Slack | Support | Direct: intake, health checks and writes after approval |
| YouTrack, GitLab, Outline, Prometheus, Grafana, Alertmanager reads by the agent | Sandbox | Gateway `/<token>/mcp` or `/<token>/tools`, then the connector in Support, then the service |
| GitLab clone and fetch | Sandbox | Git proxy on 7071, read-only. Pushes and other paths return 403. |
| GitLab merge requests, branches, commits | Support | Direct, after engineer approval and a durable intent record |
| Kubernetes | `kubectl` and `flux` in the sandbox | Gateway `/<token>/k8s/<context>/…`. The gateway adds the ServiceAccount token. |
| Prometheus, URL kind | Support | Direct, with the credential of that server |
| Prometheus, through Kubernetes | Support | API server proxy of a context. The gateway refuses `portforward` and `proxy`, so the sandbox cannot use this path. |

The gateway forwards `GET` and `HEAD` to the Kubernetes API only. Cluster RBAC remains the main limit. See [Kubernetes access](kubernetes-access.md).

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

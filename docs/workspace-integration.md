# Workspace integration

## Boundaries

YouTrack remains the ticket authority. Local sessions, diagnostic traces and derived activity metrics are not a second ticket database. Existing execution, diff and message approval gates remain mandatory. No new remote writes or autonomous retries are introduced.

## Implementation order

1. URL navigation: persist page, issue, connection and selected step in a validated hash route. Preserve browser back/forward and hard refresh. Never put credentials or draft bodies in URLs.
2. Settings: three-way reconciliation of saved settings and local edits. Keep drafts during account refresh; surface conflicting fields and schema errors, including errors on another tab. Saving uses the current revision with conflict detection, not last-write-wins.
3. Authentication: retain rotating tokens across unrelated configuration changes; serialize refresh per account, and reject obsolete refresh results after sign-out, reauthorization or vault lock. OAuth completion redirects to a themed result page without keeping the code in the URL. Returning to Model refreshes account state and loads the catalog.
4. Diagnostics: one bounded encrypted store, tool-specific tabs and request/result detail. HTTP metadata plus bounded redacted text, never headers or OAuth exchanges. Model transport records metadata, not prompts or hidden reasoning. Limits: 2,000 entries, 24 KB response capture, configured retention capped at 30 days. No capture while locked. Existing investigation tool records remain available.
5. Dashboard: recorded activity only, explicit time range and denominators, active workflow counts, daily run outcomes, run completion rate and duration. No invented savings, spend or ticket SLA data. Reuse the workflow projection so status logic stays consistent.
6. Regression coverage: settings merge/conflicts, token rotation races, routes, log retention/redaction/stream preservation, dashboard aggregation. Serial build/tests and browser checks at the end.

## Claude subscription boundary

Claude subscription support uses the official unmodified local CLI, with login completed by the engineer through Claude's own flow. Support never reads/copies Claude OAuth tokens. The adapter returns structured proposed actions into the existing validated tool loop; CLI native and MCP tools are disabled. Safe/restricted mode, empty temporary cwd, filtered environment, bounded output, process-group cancellation and no session persistence limit execution. Enterprise managed policy remains applicable; VM isolation is still required. API key mode remains available. Provider HTTP and terminal-stream errors retain only redacted error fields, never response output/reasoning.

## Verification limitations

Recorded history can verify navigation, logs and dashboard rendering. A successful model invocation requires valid account usage and is not implied by catalog loading. Synthetic regression fixtures never invoke real providers or approve real work.

## List integration

Ticket and alert lists use compact rows and a shared themed column-filter popover. Ticket filters operate on the loaded YouTrack page (the list labels this scope); no hidden source-wide claim is made. Log filters execute on the server over the bounded retained history, with stable sequence pagination and incremental decryption. Time/action/tool/outcome/duration filters do not trigger tool calls. Active indicators and clear actions are visible. Menus are portalled to avoid clipping in horizontally scrollable tables, support Escape and keyboard focus, and retain existing row navigation.

Model settings uses Configuration and Accounts tabs. Tool-specific connection controls explain the enabled and disabled behavior and when saving takes effect. A new sign-in requires saving model configuration first, so the callback tab returns to the same configured provider.

Validation: full 163-test suite passed before the header-filter extension; the 10-test targeted HTTP/workspace suite passed after it (including the added retained-history filtering test). Production build passed. Live browser checks covered ticket investigation restoration, hidden-field validation/recovery without saved mutations, account status, dashboard data, log detail and header menus. OAuth completion visuals were previewed locally; no new sign-in, model run or remote approval was performed.

## Model investigation recovery

OpenAI plan tool definitions require every property in strict mode. The investigation now includes `findings` in `required`, constrains conclusion call IDs to the checks performed in the current run, and permits only an empty findings list before any read. Final server-side validation still rejects unknown references. HTTP admission, failed/incomplete stream events, usage errors and authentication failures remain separate; no automatic re-login, model substitution, plan approval or remote writes occur.

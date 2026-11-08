# Architecture and implementation boundary

> Installation and hosting roadmap: [Mac app, managed/existing VM and Kubernetes](installation-and-hosting-plan.md). It records current source boundaries and the proposed security and release gates; historical milestones below are not a hosted-readiness claim.

## Ownership

YouTrack is authoritative for ticket title, description, assignment, severity, status and comments. The application reads those records and writes only approved updates back to YouTrack. It must not maintain a second authoritative ticket table.

Persist local **work sessions**, linked by `(connection_id, issue_id)`:

- immutable plan versions and stable step IDs;
- review comments, reply drafts and approval records;
- operation intents, completed effects and recovery checkpoints;
- sanitized work logs and working-copy diffs;
- source version/fingerprint used to prepare the plan.

A bounded source snapshot may be retained with an approval for provenance. It is not current ticket state. A short-lived display cache may improve rendering; it must be labelled stale when disconnected. Re-read relevant YouTrack and infrastructure state before any write. A cached record never grants permission to execute.

The implementation currently persists `sample_tickets` solely to exercise UI interactions. It must not become the live source-record store when the YouTrack connector arrives. Existing sample state remains clearly segregated from real work sessions.

## Components

- React + TypeScript UI, served by the VM's Node application.
- Loopback-only HTTP API reached through an SSH tunnel from the Mac.
- SQLite local state and encrypted credential vault.
- Future isolated general-agent worker, per-work-session working copy and tool gateway.
- Future native Swift companion subscribes to notification-only events and opens application-owned ticket routes. No host shell, file or execution commands.

Only explicitly selected folders are shared into Ubuntu. Prefer read-only source repository mounts and independent per-session working copies inside Ubuntu. The application does not manage the native Mac VM or require Lima.

## State and approvals

Visible flow: Backlog → In progress → Review → Waiting / In progress → Done. Waiting always identifies its actor and reason. Reopened is a marker preserving prior history.

The current implementation records approvals over the complete current plan, target, configuration revision and actor. Optimistic revision checks reject stale browser actions. Review requests invalidate approvals and preserve prior plans. Configuration writes atomically invalidate approved sample sessions.

Future execution requirements:

1. Durable operation intent before calling a tool.
2. Exact approved operation, arguments, target and plan version.
3. Relevant remote preconditions and conditional writes when supported.
4. Tool credentials owned by the gateway, not worker environment.
5. Network/filesystem isolation preventing alternate tool paths.
6. Completion checkpoint and sanitized result after the effect.
7. Reconcile ambiguous outcomes before retrying after a crash.

An approval is not a broad grant to a shell. A ticket, README, MCP response or log cannot change approval policy. An already-running tool may finish before a pause; the UI must report that honestly.

## Configuration

One strict schema is shared by the UI and API. Unknown fields are rejected. Configuration changes use an expected revision. Imports are previewed before saving; exports omit vault content. Credentials are write-only to the UI and encrypted at rest. Unlock is explicit and reset on process restart.

Initial onboarding is resumable: welcome, VM paths, YouTrack, model/tools, scope, sample tour, review. The current completion action opens the sample workspace, never enables live intake.

## Planned connectors

- YouTrack: source reads, approved replies/status updates.
- GitLab: repository/pipeline reads and approved branch/MR creation.
- Toolbox: controlled resource and log reads, namespace exclusions; port-forward traffic needs explicit endpoint restrictions.
- Outline: DevOps collection only.
- Alertmanager: polling with stable fingerprint deduplication; failures are not resolution events.
- Prometheus: generated PromQL with query time/range/size limits.
- Slack: channel/thread intake and approved responses.

External ticket creation for alerts requires approval initially. Until a YouTrack issue exists, retain a local intake event, not a duplicate permanent ticket. Once linked, the YouTrack issue becomes authoritative.

## Next increments

1. YouTrack read adapter + short-lived cache + source/work-session split.
2. Agent read-only runner with approved inference endpoint and sanitized event stream.
3. Isolated gateway + precise write operations and restart reconciliation.
4. Secret sealing workflow and GitLab MR publishing.
5. Mac notification companion, intake scheduling, retention cleanup and handover.

The built-in sample flow deliberately stops at approval. There is no hidden or generic execution endpoint.

## Implemented YouTrack slice

`server/youtrack.ts` performs bounded, redirect-free GETs against the explicitly configured instance and query. `src/YouTrackTickets.tsx` renders source records separately from fixtures. Source titles, descriptions and custom fields remain ephemeral. `work_sessions` persists only local authorship, approval metadata and the stable remote reference. No work session is persisted until a local action is saved.

Every work-session action freshly reads the source. Changes to the source `updated` timestamp clear approvals when observed. A plan cannot be approved while a revision request is pending. Local optimistic revision checks guard concurrent windows; the initial transport is REST, while agent-facing MCP remains future work.


## Implemented Claude analysis boundary

The loopback-only server owns a bounded Messages API loop. The model sees only explicitly registered read tools and a local `prepare_plan` response schema. Tool adapters construct fixed endpoints/arguments; the model cannot choose credentials, URLs, methods, executable names or arbitrary CLI flags. Available adapters currently cover the current YouTrack issue, Prometheus instant queries, GitLab pipeline lists and Toolbox namespaced resource reads. Alertmanager cases also feed this loop through a source adapter that re-polls before accepting a plan. Outline, Slack and general MCP are not connected.

Each run captures configuration revision, credential epoch, source update timestamp and local session revision. Before saving a plan, the server re-reads YouTrack and checks every precondition. It appends a new version and clears approval in one SQLite transaction. Feedback saved during generation makes the old result ineligible. Cancellation, errors, truncation and limits leave prior plans intact. The analysis loop itself has no write tools. A separate approved-change service performs the narrowly scoped GitLab writes below.

Only generated plan/draft and bounded factual activity summaries persist. Source/tool bodies and model conversation remain transient; work products may quote sources. In-flight runs stop on process exit and are not replayed. The API loop runs in the trusted server process, not an isolated agent process. Toolbox is a trusted binary run without a shell on Linux, with a configured JSON policy, allowed contexts, namespace checks and fixed resource/argument allowlists. Additional process isolation is still future work.


## Approved GitLab changes

`Changes` owns the mutation boundary separately from the Claude read loop. The engineer selects a configured GitLab project/target and up to ten exact file paths after approving the plan. Generation reads files at an immutable base SHA and returns proposed contents only. The model never receives an executable, a write tool or GitLab credentials. The service validates paths/content, checks the original approval and target again, persists a write intent, then uses a single commit POST with a unique branch and `start_sha`, without force.

The service verifies the commit parent, operation marker, exact file contents and complete remote diff. The review digest covers plan/source/config/session provenance, refs, diff and MR metadata. A separate explicit approval checks remote state again before persisting MR intent and sending the only MR creation POST. No merge/update-target/delete endpoints are exposed. Post-write checks report concurrent external changes; GitLab MR refs cannot be transactionally frozen by this API.

`changes` is local execution history, distinct from source tickets. Pending writes survive restarts and reconcile by read only. Generation interrupted before write intent is marked failed. A shared in-process work gate serializes analysis/preparation/review writes; this is a single-process, single-engineer service. Files and change artifacts stay local/internal apart from configured model inference. Existing checkouts are never opened by the execution service.


## Pipeline tracking and follow-up approval

`Pipelines` uses the same credential, source-approval and single-operation guards as branch preparation. It reads the MR, source/target refs, associated pipeline and bounded job list. UI polling is serialized and suspended while the tab is hidden or an operation is active. Tracking snapshots are cached work-session metadata, with an explicit last-check timestamp and stale errors; GitLab remains authoritative.

Diagnosis reads capped failed-job traces, removes known credentials/common secret patterns, and sends bounded excerpts plus scoped files to the configured model. Traces are never persisted. The model can only return a summary and full replacement contents for existing scoped files. No write tools are exposed. Proposal hashes bind contents and the pipeline/job/ref snapshot. Approval is a separate route, followed by per-file last-commit checks and a non-force commit. Durable intent is written before the POST; reconciliation never retries it. Post-write parent/content checks detect concurrent changes that the GitLab commit API cannot atomically exclude.


## Resolution boundary

`Resolutions` is separate from the model/read loop. It verifies immutable merge metadata and a successful target-ref pipeline for the merge SHA, then creates a deterministic editable summary. The exact comment body, operation reference and current source/session/configuration are hashed for explicit post approval. The post intent is durable before the only comment POST.

Closure is independently reviewed against current YouTrack state metadata and current successful pipeline proof. Only supported resolved state values are sent via a fixed custom-field payload. The posted comment must still exist unchanged. Ticket-source changes caused by posting are handled by a new closure snapshot rather than reusing the earlier plan/source approval. Closure intent is durable; recovery reads the exact field value and resolved timestamp without resending. Reopening is an observed source change, never an instruction to reclose.

The REST APIs do not transactionally freeze GitLab pipeline state and YouTrack issue versions together. Pre-write checks, exact-target payloads and post-write verification limit the race; normal workflow enforcement remains authoritative. No success is reported for unverified/ambiguous writes. Multiple linked MRs and state-machine transitions require manual closure in this iteration.

### Implemented Alertmanager intake

The server polls `GET /api/v2/alerts`, with active/silenced/inhibited/unprocessed included and optional repeated matcher filters. Polls are coalesced; the interval is enforced on failures too. A successful bounded and validated response is applied in one SQLite transaction. Failed reads retain the previous state and expose an error. The configured endpoint is fixed; no upstream generator URL is fetched. Credential/config epochs guard in-flight results; vault lock pauses polling.

A stable SHA-256 ID binds normalized endpoint, matcher scope, configured grouping keys and canonical raw label identity. Default grouping uses all labels except severity, not notification timestamps or annotations. Explicit grouping always includes alertname. Raw identity is hashed before secret filtering so redaction cannot merge distinct labels. Sanitized members and local occurrence metadata are stored in `alert_cases`; only relevant member/state changes increment the source version. Absence from a successful full scoped response marks a case not firing, not verified resolved. Suppression is a separate property. Links, notes and plans survive recurrence; approvals are invalidated.

Claude accepts a read-source interface shared by YouTrack and Alertmanager. There is one shared model/change lock. Automatic alert investigation is opt-in, once per occurrence, with explicit retry after failure. Polling continues during analysis; changed input is rejected before plan persistence. No mutating tool is added to the model. Plan approval is local and guarded by a fresh poll; no approval is transferred to a linked YouTrack issue. Existing issues can be linked through a GET. A separate reviewed creation service supports new issues; plan approval is never transferred.

The process owns polling, so Mac sleep/VM suspend/server shutdown interrupt it; Alertmanager does not expose a complete historical event stream and short alerts between polls may be missed. Group recurrence counts are observed occurrences, not exact notification counts. Multiple engineer installations do not share local cases. Inactive, unlinked cases are pruned after configured retention; active/linked/pending-creation cases and other work history currently remain. This is not a full retention implementation.

### Local startup access

The app opens directly at its printed loopback URL. Startup pairing tokens and cookie sessions have been removed. Strict Host checks, same-origin writes, cross-origin API rejection through Origin/Fetch Metadata headers, and CSP remain. Local processes are trusted to access the workspace; credentials remain encrypted and the vault locks on restart. Vault unlocking and operation-specific engineer approvals are independent of opening the UI.

### Alert ticket creation

`AlertTickets` owns the create boundary; Claude has no creation tool. `AlertCase.ticketCreation` persists a versioned draft, destination instance/project, source and session versions, configuration revision, content digest, approval, optional returned issue ID, and draft/pending/created state. Normal polling updates case members without resetting this operation. Manual linking and creation share the existing single-process work lock. Every write of creation metadata merges onto the latest case to preserve in-flight polling updates.

The description footer contains a stable alphanumeric reference derived from the alert case ID. Search reads all token-visible matches, not just the configured support queue or unresolved issues. Exact footer verification rejects fuzzy search results; duplicate exact matches and incomplete scans fail closed. Preparation can reuse an existing ticket. Approval rechecks fresh alert state, source/session/config guards, destination project and duplicate search immediately before persisting intent. Only then is a fixed POST sent to the captured YouTrack instance. No arbitrary fields, commands or URLs are exposed.

After intent, failures remain pending: even a connection failure before remote acceptance is not automatically retried. On restart the pending record remains; reconciliation is GET-only, verifying the returned ID or exactly one reference match and the intended project. Vault/endpoint changes cannot redirect reconciliation to a different instance. Pending records are not pruned. A closed or deleted linked issue never triggers automatic replacement. Required custom fields/workflow rejections require manual inspection; the service does not bypass YouTrack rules.

This is an at-most-one create attempt per local case, not a distributed exactly-once protocol. No atomic remote uniqueness or shared lock exists across independent installations. Search indexing and permission visibility cannot prove global absence; shared serialization is required for cross-engineer concurrent creation. The supported deployment remains one active process per local workspace.

### Alert-to-ticket work-session handoff

`AlertHandoffs` performs two read-only upstream checks followed by one local transaction. The preview digest binds alert identity/content/update version, source session revision, linked instance/issue, target source update and session revision, and configuration revision. Config/credential epoch checks protect in-flight reads. Source and destination sessions are rechecked synchronously inside the write transaction. The shared work lock excludes model/change operations, and pending external intents block handoff rather than silently invalidating their review state.

The destination appends the complete plan text and an `alertHandoffs` provenance record containing source/target plan versions, alert context timestamp/state, original feedback, reply draft and recorded analysis activity. It clears approval but preserves existing notes, plans, nonempty reply drafts, analysis history, and pending revision flags. Source approval is never copied. Content identity plus the original review hash make repeated commits idempotent across restarts and lost responses; repeated imports do not disturb later approval or edited destination plans. No persistent source issue copy is added.

`YouTrackTickets` can open the linked work session directly and verifies its connection identity. The existing approval action still re-reads YouTrack; `Changes.prepare` requires that new ticket-plan approval. Imported activity is labeled as a historical alert investigation. Claude ticket revisions receive recent imported context as untrusted source data; branch generation remains limited to the approved plan and explicit file scope. This is local snapshot transfer, not ongoing source synchronization: later alert updates require explicit review/handoff, and remote source changes are revalidated at normal ticket approval/execution boundaries.

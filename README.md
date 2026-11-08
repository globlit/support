# Support

A local-first support workspace for infrastructure engineers. The first implementation includes the application shell, live ticket flows, persistent settings, encrypted credentials, repository discovery and resumable onboarding.

**This is a foundation build, not an autonomous operator.** Read-only YouTrack intake is implemented. Claude/OpenAI plan preparation and scoped Toolbox reads are implemented. Approved plans can prepare GitLab branches, followed by separately approved draft merge requests. Reviewed resolution comments and separate approved ticket closure are available. Cluster mutation is not implemented. A native macOS notification companion is available as a source installer in Settings → Notifications. YouTrack, GitLab, Alertmanager and Model checks authenticate with read-only requests; other checks validate saved configuration.

## Run inside your Ubuntu VM

Requires Node.js 24+ and npm. No Lima dependency. Use your existing VM based on Apple virtualization.

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4173` directly. No startup token is required. Unlock with your existing Vault passphrase to authenticate this browser; on first use, create the Vault. Sessions use an HttpOnly cookie plus CSRF protection and expire on Vault lock or server restart. Old pairing-link fragments are removed automatically. See [deployment/session configuration and verification limits](docs/security-foundation.md).

The server binds **127.0.0.1:4173 only**. Access it from the Mac with an SSH local forward:

```sh
ssh -N -L 4173:127.0.0.1:4173 ubuntu@YOUR_VM_IP
```

Use `http://127.0.0.1:4173`, not `localhost`, and keep the same local port. This build does not expose plaintext service traffic directly on the VM's LAN address. Do not forward the local port to your network. Native VM networking and folder sharing are managed by your existing VM launcher.

Optional environment variables:

- `SUPPORT_PORT`: local listener port (default 4173).
- `SUPPORT_DATA_DIR`: private local data directory (default `.support-data`).

`npm run dev` builds and starts the local server. It currently does not provide hot reload.

## Start with a real ticket

Use Setup to configure service paths and endpoints, then unlock Settings → Vault.
Open YouTrack to select a real ticket, analyze it and review its plan. Plan,
branch-diff, resolution-message and ticket-close approvals stay separate.
Sample tickets and their action endpoints are no longer exposed by the app.

## Data ownership

**YouTrack owns tickets.** We are not building a second issue tracker database.

The legacy `sample_tickets` table is unused by the app; new workspaces do not seed it. The YouTrack page reads issue data directly; no server-side ticket cache or persistent source copy is created. The `work_sessions` table stores local plans, review notes, approvals and reply drafts keyed by normalized instance identity and stable issue ID. It does not store issue title, description, assignee or remote status. Local notes and generated plans may quote ticket content; these are work-session artifacts, not a ticket mirror. See [architecture](docs/architecture.md).

## Credentials and access

The credential vault uses scrypt-derived keys and AES-256-GCM. The passphrase is never persisted; the key is held in the server process until lock or restart. Losing the passphrase means stored tokens cannot be recovered. Tokens are never returned by the API and are excluded from exports. Local file permissions are restricted to the service user.

The vault is not protection against a compromised server process, root, VM administrator, or memory access. Future workers must run separately and receive tool access through the gateway; they must never mount the vault directory.

The application uses loopback binding, strict Host/Origin and browser Fetch Metadata checks, a same-origin content policy, capped JSON bodies and rate limiting for vault attempts. Workspace APIs require an authenticated browser session; approval identities are server-owned and independent of editable display settings. It is a single-owner local service, not a multi-user or Internet-facing deployment. Hosted configuration fails closed until its identity and runner boundaries are implemented.

Configuration exports contain selected internal URLs and paths, but no stored tokens. Treat exports as internal data. Path and scope text is not an input for passwords. Unknown configuration fields and credential-bearing URLs are rejected.

## Current limitations

- YouTrack REST reads, Alertmanager v2 polling, Claude Messages API, Prometheus instant queries, GitLab pipeline status and scoped Toolbox resource reads are implemented. MCP, Outline, Slack and separate worker isolation are not. There is no offline YouTrack ticket mirror.
- Live work-session approvals re-read YouTrack and reject changed source timestamps or local revisions. Source changes clear approval on refresh. Revision requests require a new plan before approval. Write routes cover approved GitLab changes, reviewed alert-ticket creation, and separately approved YouTrack resolution comments/closure.
- Toolbox reads enforce allowed contexts and namespace exclusions. Secrets, ConfigMaps, logs, raw URLs and port forwarding are not exposed.
- Repository discovery scans at most two levels and 500 directories; it does not follow symlinks or run Git. Base branch defaults to `main` and must be reviewed.
- Configuration changes conservatively clear all existing approvals.
- Mac notifications: pair the native menu-bar app in Settings → Notifications. See [Mac installation, SSH pairing and troubleshooting](companion/macos/README.md). The server remains loopback-only; native OS behavior must be verified on macOS.
- Retention is configurable up to 30 days. Successful alert polls prune inactive, unlinked alert cases and their local work sessions after this period. Active, linked or pending-creation cases and other work history are retained; general history cleanup is not implemented.
- UI feedback drafts survive tab changes within an open ticket; only submitted drafts/notes survive reload.
- Source status mapping, support scheduling, reusable workflow execution and rotation handover remain future work.

## Checks

```sh
npm test
npm run build
```

Tests cover stale approvals, revision history, atomic configuration invalidation, encrypted vault persistence and configuration input validation. They use disposable temporary databases, never the local workspace data.

## Connect real YouTrack tickets

1. Open Settings → Connections → YouTrack.
2. Set the **instance URL**, e.g. `https://youtrack.internal` or `https://host/youtrack`. Do not enter `/api`, `/mcp`, a board URL, a token or query parameters here. HTTPS is required except for loopback testing. Configure your internal CA with Node trust configuration; TLS checks are never disabled.
3. Enter an actual **YouTrack search query**, e.g. `project: INFRA #Unresolved`. A bare board name is not supported. Use the corresponding board filter as a query.
4. Enable Include in setup and save settings.
5. Create/unlock the vault and save a permanent YouTrack token with read permission.
6. Click **Test YouTrack read access**, then open **YouTrack** in the main navigation.

The integration uses the documented REST API, not MCP. Reads request 50 issues per page, preserve custom field labels and support list/board views. Explicit Refresh and opening an issue re-read the source. Failed reads remove the previous source view rather than presenting it as current. General comment browsing, attachments, field-mapping controls and background ticket polling are not implemented. Resolution comments and resolved-state updates use the dedicated approval flow below.

In a real issue, you can save a local manual plan, request revisions, approve its current version, add internal notes and prepare a reply draft. Resolution comments are posted only through the separate approval flow. Claude can generate new plan versions after you start analysis. Local source timestamps are provenance/precondition metadata, not authoritative ticket status.

Every YouTrack request uses GET, a 15-second timeout, a 4 MB response cap and redirect rejection. Tokens never reach the browser. In-flight reads are discarded if configuration, credentials or vault state change. Issue data is held only in process/browser memory; authentication and request errors do not expose upstream response bodies. Navigating away or locking the vault clears the live component; no offline copies are available.

Official references: [Issue reads and pagination](https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues.html), [Permanent-token authentication](https://www.jetbrains.com/help/youtrack/devportal/authentication-with-permanent-token.html).


## Connect Claude or OpenAI for plan preparation

1. Configure YouTrack and unlock the vault as above.
2. In **Settings → Model**, select Claude (Messages API) or OpenAI (Responses API), enter your approved API base URL without `/v1`, and a tool-capable model ID enabled for your account. Turn on **Allow model requests** and save.
3. Unlock **Settings → Vault**, then open **Settings → Model → Configuration** and click **Add key**. Save the selected provider's API key. Use **? API key help** for provider-specific instructions. Each service has its own Add/Change action; optional Alertmanager/Prometheus tokens are labeled and Toolbox has no token field. A provider change requires a matching key and clears plan approvals.
4. Optionally enable read tools:
   - **Prometheus**: query-server base URL, not `/federate`; optional bearer token. Requests use `/api/v1/query` with a ten-second query timeout and result limit.
   - **GitLab**: instance base URL and vault token. Only the ten latest pipeline statuses for a project are exposed, not logs, files or CI variables.
   - **Toolbox**: absolute path to a Toolbox JSON configuration (which references kubeconfig), plus comma-separated exact allowed Kubernetes context names. Namespace exclusions apply. Install the trusted Toolbox binary inside Linux at `/usr/local/bin/toolbox`, or set `SUPPORT_TOOLBOX_BINARY` to its absolute path. The app invokes only fixed, namespaced `kubectl get` arguments through Toolbox, with sanitization enabled. It never uses a shell. The MCP endpoint field is unused in this adapter.
5. Open a real YouTrack issue and choose **Analyze ticket**. Follow the activity log, then read the complete plan and draft.
6. Save a revision request or internal note, then choose **Revise plan**. Old versions remain available. Review and approve the new version separately.

Analysis sends ticket text, local feedback and read results to the configured inference endpoint. Vault credentials are used by the server and stripped from model content. Common secret patterns are filtered too, but this is not complete data-loss prevention: do not put plaintext secrets in tickets or notes, and review the trusted Toolbox sanitizer configuration. Tool output and model conversations are not persisted. The local work session retains generated plans, reply drafts and factual activity summaries, not private reasoning.

One run can be active, with a three-minute deadline, seven model turns, twelve tool calls, response-size caps and redirect rejection. Cancellation prevents saving a result. An interrupted run is not resumed after server restart; start a new analysis. The last fifty run statuses are held in memory; completed activity is also kept with its work session. Source/configuration/credential/local-session changes discard results. A model-generated plan never implies approval. **Plan approval permits a separate branch-preparation action. Creating a draft merge request requires a second, exact-diff approval.**

The model has no generic HTTP tool, shell, arbitrary filesystem access or ability to choose executable flags. Toolbox is trusted server-side code and shares the app's VM user; there is no separate OS worker sandbox yet. Keep the app and Toolbox inside the VM, with only intended folders mounted.

Protocol references: [Claude Messages API](https://platform.claude.com/docs/en/api/messages), [Prometheus query API](https://prometheus.io/docs/prometheus/latest/querying/api/), [GitLab pipelines API](https://docs.gitlab.com/api/pipelines/), [Toolbox usage](https://github.com/globlit/toolbox).


## Execute an approved plan through GitLab

1. Under **Settings → Repositories**, discover/select the repository and enter its **GitLab project** (`group/project` or numeric ID), target branch, and Development/Preproduction environment. No local Git checkout is modified; the mapping defines the remote target.
2. Enable GitLab and store a token with API write access to that project. Keep target-branch protection and GitLab merge permissions in place.
3. Open the ticket, review and approve the plan, then open **Changes**.
4. Select the mapped repository and enter exact relative file paths, one per line. Choose **Prepare changes on a new branch**. This explicitly permits the approved plan to modify only these files on a new `support/<uuid>` branch.
5. The configured model receives the approved plan and selected files at the target SHA. The server validates the returned create/update/delete actions and commits them in one GitLab API request. It does not run model commands, Git hooks locally, tests, merges or deployments. The commit includes `[skip ci]`; server-side hooks and GitLab policy can still act on branch/MR events.
6. Review the complete GitLab diff and proposed MR title/description. Save edited metadata to refresh the review, then choose **Approve diff & create draft MR**. No merge request is created during preparation. No automatic merge is ever requested.

Approvals bind the plan, local session, source version, settings, project, target SHA, prepared SHA, diff and MR text. Changes to source/target branches or the work session block the write. GitLab cannot atomically freeze both refs through its MR creation endpoint: the app checks them before and after creation, and marks a changed result for review. Normal GitLab branch protection and review rules remain necessary after MR creation.

Write intents are saved before network calls. A lost response or restart leaves **Check branch** / **Check merge request** state. **Check remote status** only reads: it never retries the commit or MR POST. If the resource is still absent, the operation remains pending for manual investigation, avoiding ambiguous duplicate writes. Branches and MRs are never automatically deleted. Old change sets remain as local work history; stale plans require a newly approved preparation.

Current limits: ten explicit UTF-8 files, 32 KB each, one selected repository and one operation at a time. Renames, binary files, symlinks and mode changes are unsupported. Large, collapsed or incomplete GitLab diffs block approval. Common credential patterns and stored tokens are rejected before model transmission or commit; this is not a complete secret scanner. Only use sanitized source files. Automatic tests/manifest validation and automatic file discovery are not yet implemented: the engineer must review correctness and normal CI should validate the MR.

Local `changes` records contain operation metadata, selected before/after content, diffs and approval records. They are work-session artifacts, not ticket copies. Keep the VM data directory private; configured automatic retention is still pending.

API references: [atomic branch commits](https://docs.gitlab.com/api/commits/), [repository files](https://docs.gitlab.com/api/repository_files/), [complete comparisons](https://docs.gitlab.com/api/repositories/), [merge request creation](https://docs.gitlab.com/api/merge_requests/).


## Track pipelines and review follow-up fixes

Open **Changes** on a ticket with a merge request. MR state, merge status, pipeline status and jobs refresh every 30 seconds while this tab is visible; **Refresh status** reads immediately. There is no background scheduler when the page is closed. Failed reads keep the last snapshot visibly marked stale, with its original check time. Closed/merged MRs are displayed without enabling fix writes. No jobs are retried automatically.

For an open MR with a failed pipeline on the tracked source commit, choose **Diagnose failure & propose fix**. Optional notes can guide a revised diagnosis. The configured model receives the approved plan, currently scoped files and filtered excerpts from up to three failed jobs. Raw traces remain in memory only, with a 256 KB per-log read cap and a 12 KB excerpt per job. Credential filtering is best effort, not a complete secret scanner; keep CI logs free of plaintext credentials.

The diagnosis and complete proposed file updates are saved locally. Empty proposals explain manual steps or why no code fix is appropriate. Only existing files in the original change scope can be updated. Read the summary and full-file diff, then select **Approve fix & push to MR branch** to add a commit. This push may trigger CI normally; it does not request CI skipping. The app never merges or force-pushes. New file scope or a changed ticket/plan requires a new plan review.

Approval binds the proposal, source/target commits, current pipeline and job snapshot, ticket session and configuration. Changed status, new pipeline/job attempts or changed refs require a fresh diagnosis. GitLab per-file `last_commit_id` checks protect concurrent edits to modified files. The commit API has no atomic compare-and-swap for the entire branch: a simultaneous unrelated branch update can still occur between checks. Post-write parent/content validation marks such cases for manual review, without overwriting or force-pushing the branch.

An uncertain push remains **pushing** across restart. **Check push status** only reads the branch, commit marker, parent and contents; it never repeats the commit request. The proposal and explicit approval remain in local history. Initial branch diffs and follow-up proposals are shown separately. Automated diagnosis currently excludes merged-result pipelines whose SHA differs from the source commit, pipelines with 100 or more jobs, and more than three failed jobs. These remain visible for manual inspection.

References: [GitLab MR state](https://docs.gitlab.com/api/merge_requests/), [job status and traces](https://docs.gitlab.com/api/jobs/), [commit action preconditions](https://docs.gitlab.com/api/commits/).


## Complete a ticket after merge

In **Changes → Resolve YouTrack ticket**, choose **Prepare resolution summary** after merge. The server requires the tracked source commit to be merged into the configured target and checks the latest target-branch pipeline for that exact merge commit. A passing source/MR pipeline alone does not qualify. Squash merge commit metadata is supported; absent/failed/skipped/manual pipelines block resolution. Tracking switches to the merged-commit pipeline after merge.

The app prepares a factual, editable summary from the MR, changed-file scope, verified follow-up commits and successful pipeline. It does not infer deployment health or claim that every step of the original plan ran. Review the text and its visible operation reference, save any edits, then choose **Approve & post summary**. Posting uses the configured YouTrack token, normal issue visibility and notification behavior. It does not request ticket closure.

After the summary is confirmed, load the project's closing states, select a resolved state, and choose **Review ticket closure**. Review the field/value and successful pipeline, then choose **Approve & close ticket**. Only a `StateIssueCustomField` value that YouTrack reports as `isResolved=true` can be selected. No arbitrary command strings, guessed status names or workflow bypass are supported. State-machine transitions, unavailable state metadata and tickets with multiple linked MRs require manual resolution in YouTrack.

Both approvals bind the current ticket update timestamp, local session, configuration and verified merge/pipeline metadata. Editing the summary invalidates its approval hash. Posting advances the source timestamp, so closure gets its own fresh review. A new successful pipeline can be reviewed for closure without reposting the existing summary. Changed/deleted summary comments and changed closing states block closure. YouTrack workflows may reject a write; the app reports the failure and never bypasses workflow rules.

Comment and close intents persist before the request. After an uncertain response/restart, **Check YouTrack status** performs reads only. Comment recovery requires exactly one non-deleted comment matching the approved text and unique visible reference; closure recovery verifies the exact state and the issue's resolved timestamp. Missing/ambiguous results remain pending for manual inspection, with no automatic replay. YouTrack's REST update endpoint does not provide an atomic compare-and-swap for issue timestamps; the app checks immediately before the request and verifies the result afterward, but cannot eliminate a concurrent server-side change in that interval.

The ticket view refreshes after posting and closure. Reopened tickets are flagged during status tracking and are never automatically closed again. A completed ticket may disappear from an `#Unresolved` queue because YouTrack remains the source of truth; local execution records are retained.

References: [comment API](https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues-issueID-comments.html), [updating issue fields](https://www.jetbrains.com/help/youtrack/devportal/api-how-to-update-custom-fields-values.html), [state metadata](https://www.jetbrains.com/help/youtrack/devportal/api-entity-StateProjectCustomField.html).

## Alertmanager intake and review

1. In Settings → Connections → Alertmanager, set the **base URL** (not `/api/v2`), enable the connection, and optionally save a bearer token in the vault. Remote endpoints require HTTPS; loopback HTTP is allowed for testing. Unlock the vault to poll, even when no token is required.
2. Optionally enter Alertmanager matchers, one per line. Only warning/critical alerts are admitted. Set a polling interval from 15–900 seconds (default 60). Polling runs on the server independently of the browser and pauses when the vault is locked, the connection is disabled or the server stops. It is not limited to configured work hours.
3. By default, the same full label set (except severity) maps to one local case. Optional grouping labels combine instances; `alertname` is always included. Include cluster/environment labels to avoid grouping unrelated systems. Changing URL, matchers or grouping creates a separate scope; old cases are preserved locally and become visible again if that scope is restored.
4. Open **Alerts** for list/board views, severity and work-state filters, occurrences, instance details and linked tickets. Repeated polls, notification timestamps and a severity escalation do not create another case. A return after absence, or a changed start time for the same fingerprint, increments occurrences and clears old approval. An outage is never treated as recovery. Suppressed alerts remain present. “Not firing” only means absent from a successful scoped poll.
5. **Analyze ticket** uses the same bounded read-only tool loop as YouTrack. The full versioned plan, activity summaries, notes and suggested reply stay local. Save a revision request, then use **Revise plan**. Approving records the reviewed plan only; it does not execute, silence, post or close anything. Fresh polling and local revision checks reject stale reviews.
6. **Investigate new alerts automatically** is opt-in. It sends alert context to your configured model endpoint, uses one shared investigation/change slot, and attempts each occurrence once. Fully suppressed cases wait. Failed/cancelled/interrupted runs need an explicit retry; a later recurrence can be investigated again. No custom scheduling or automatic retry loop is enabled.
7. In the case’s **YouTrack** tab, link an existing ticket or prepare a ticket draft and approve creation as described below. Repeated alerts reuse the link. Ticket state and plan approvals are not automatically synchronized. Use the reviewed local handoff below to carry the investigation into the linked ticket. Continue external change handling in the existing YouTrack flow.

Alert snapshots and deduplication IDs live in `alert_cases`; plans use `work_sessions`. Known vault values, sensitive label names and common secret patterns are redacted before storing snapshots, but filtering is best-effort: do not put secret values in alert labels or annotations. The adapter never follows generator URLs. Redirects, malformed/oversized responses, settings changes and credential changes cannot replace a successful snapshot. Limits: 2 MB response, 5,000 alerts, 200 members per local group. There is no cross-machine deduplication database; each engineer's installation has its own cases. No dependency was added.

The read endpoint and suppression flags follow the [official Alertmanager v2 API schema](https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml).

## Reviewed tickets from alert cases

Open an alert → **YouTrack** → **Load YouTrack projects**. Select the exact destination project, then **Prepare ticket draft**. Review/edit the title and full description and use **Save draft edits** before **Approve & create ticket**. Preparation and editing are local; only that final approval permits a create POST. The draft can include the existing proposed plan, clearly labeled as not executed. Creation does not transfer plan approval or start remediation.

Projects are read from the configured YouTrack instance and checked again before submission. The token needs Create Issue permission for the chosen project. The app uses standard issue creation with the project’s default custom fields, visibility and notifications; it does not guess required fields, severity mappings or board/sprint assignments. Workflows can reject the request. A project appearing in the list does not prove create permission. The resulting issue may not match your configured support search query.

A stable, visible `Support alert case: supportalert…` footer is included in the approved description. Before preparation and again before creation, the app searches readable YouTrack issues for that reference, including closed issues outside the configured queue query. One exact match is linked; multiple matches or search errors block creation. The local link is retained across polling, restarts and recurrence, even when the ticket is closed. Alert changes, new feedback/plan versions, edited draft content or settings changes require a fresh review.

Creation intent and approval are stored before the sole POST. Once submitted, the operation cannot return to draft or send another create request. **Check YouTrack status** only reads: a returned issue ID is verified directly, or a lost response is reconciled by its stable reference. Delayed indexing, lost access, removed references or an unverified response leave the case pending. Inspect YouTrack before doing anything manually; the app never interprets “not found yet” as permission to create again. Pending creations are excluded from retention cleanup. Background alert updates remain intact while creation is in flight.

This prevents duplicate creation from retriggers, repeated clicks and retries within one local workspace/process with its data intact. Reference searches can also discover tickets created by another installation, but YouTrack offers no atomic uniqueness constraint for this description marker: simultaneous creation from independent engineers’ installations is **not** globally serialized. Use one active support installation for creation; a shared coordinator would be required for a cross-machine guarantee. Changing grouping/scope creates a different case identity and requires reviewing existing tickets manually.

API references: [create an issue](https://www.jetbrains.com/help/youtrack/devportal/api-howto-create-issue.html), [project discovery](https://www.jetbrains.com/help/youtrack/devportal/resource-api-admin-projects.html), [description search](https://www.jetbrains.com/help/youtrack/server/search-and-command-attributes.html#description).

## Carry an alert investigation into a ticket

In the linked alert’s **YouTrack** tab, choose **Review handoff**, inspect the destination and full plan, then **Carry plan to ticket**. The app freshly reads Alertmanager and the linked YouTrack issue, checks both local session revisions, and appends a new plan version to that ticket’s local work session. No ticket comment, remote update, model call or GitLab write is performed by the handoff.

The full plan is preserved. Alert feedback, reply draft, model identifier and factual investigation activity are retained in a dated **From alert** section, with source/target plan versions and the person who carried the plan. Existing ticket plans, notes and history stay intact. An empty reply draft receives the alert draft; an existing ticket draft is kept, with the alert draft still accessible in its context section. An unresolved ticket revision request remains unresolved. A source revision request must be finished before carrying its plan.

Choose **Review ticket plan** to open the local YouTrack work session directly—even if the issue is outside the configured queue query. Review the current ticket’s scope and targets, then **Approve current plan**. Alert approval is never transferred, and any prior ticket approval is cleared by a new handoff. The existing **Changes** workflow then requires the configured repository/file scope and its normal branch, diff and MR approvals. You can also use **Revise plan**; ticket analysis receives the latest three imported alert snapshots as context, alongside its own notes and current plan.

Repeating a completed handoff reuses the existing imported version, including after restart or a lost response. It does not duplicate plans or clear a later ticket approval. New source content can be carried as another version. Stale source/ticket/settings reviews, unresolved ticket-creation results, resolved tickets, running work, and pending external writes block the handoff. A resolved ticket must be reopened in YouTrack first; the app does not reopen it.

This is a reviewed snapshot, not live synchronization. Later alert changes do not silently replace or revoke ticket work; review current conditions before approving remediation and carry a newer version when necessary. Only the approved ticket plan guides GitLab change preparation. No raw model reasoning or new source-ticket mirror is stored.

### Local integration products

For a resource-limited local instance of actual YouTrack, GitLab CE,
Prometheus and Alertmanager, see [dev-services/README.md](dev-services/README.md).
The separate Compose stack uses loopback-only ports, persistent volumes, CPU
and memory limits, and no automatic restarts.

### Model authentication and privacy

Claude uses the Messages API; OpenAI uses the Responses API with only the
app's custom tools. The optional local Claude subscription connection launches the official CLI with native tools disabled; Support continues to control tool execution. No provider-hosted computer tool or automatic write tool is enabled. OpenAI requests set `store: false`; opaque reasoning
history is retained only in memory for the bounded run and is never displayed
or written into work sessions. This is not a claim that provider-side abuse
monitoring or retention is disabled; use your organization's approved account
and gateway settings. The connection check reads model metadata only, not
inference quota or tool-call compatibility.

ChatGPT subscription sign-in is supported through the official dynamic-client
OAuth flow, with PKCE and verified ID tokens. Claude subscriptions use the unmodified local Claude Code CLI and its own login flow inside the Linux VM.

### ChatGPT / Codex subscription setup

1. Unlock **Settings → Vault**. In **Settings → Model → Configuration**, choose **OpenAI / ChatGPT**, select **ChatGPT subscription**, and save the configuration.
2. Choose **Continue with ChatGPT** and complete OpenAI's sign-in and consent in your browser. Eligibility and usage limits come from that account/workspace.
3. The themed completion screen returns to Model settings, where account status and available models load automatically. Choose a model, turn on **Allow model requests**, and save. Manage saved accounts, reconnect or sign out in the **Accounts** tab.
4. Analyze a real ticket. The model can investigate using the existing read
   tools and save a plan, but it cannot approve that plan or create an MR.
5. Review the plan before preparing changes, then review the exact diff before
   creating the draft MR. Account or settings changes clear approvals.

The callback is `http://127.0.0.1:<SUPPORT_PORT>/auth/chatgpt/callback`.
When the app runs in a VM and the browser runs on a Mac, forward that same
loopback port to the VM. Keep the callback listener running and the Vault
unlocked during sign-in. Restarts discard pending sign-in attempts.

Accounts are stored separately by issued client ID and verified subject in an
encrypted Vault record. Access, refresh and ID tokens are never returned to the
browser. The host UUID persists; switching accounts never mixes registrations.
Refreshes are serialized, rotating credentials are saved together, and a
confirmed invalid refresh requires reauthorization. Signing out clears the
local tokens and attempts remote revocation; if revocation fails, disconnect
the app in ChatGPT Settings → Usage. Account registration is retained for
future sign-in. The app supports one running process per workspace.

Subscription inference uses `https://api.openai.com/v1/responses`, streamed with
`store:false`, replayed in-memory context, and namespaced custom tools only.
It omits unsupported token-limit fields and caps stream bytes and run duration
locally. Only `response.completed` is accepted; incomplete, failed, oversized
or disconnected streams cannot become executable plans or changes. No CLI is
launched and no subscription credential is sent to custom model gateways.
Account catalog reads are not an inference entitlement check. There is no
fallback from subscription usage to billable API-key usage.

Protocol: [Sign in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[account lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[subscription inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[preview contract](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

References: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling),
[OpenAI API key setup](https://developers.openai.com/api/docs/quickstart),
[Claude API setup](https://platform.claude.com/docs/en/api/overview).

### Markdown content

Ticket descriptions, work plans, notes, reply drafts, handoffs and diagnoses render Markdown with headings, lists, read-only task checkboxes, tables and fenced code blocks. Prose editors offer a formatting preview. New model plans, alert descriptions and resolution summaries use Markdown; existing saved text is preserved. Reviewed Markdown is sent unchanged in YouTrack description/comment fields, with the existing tracking reference appended. Raw HTML is not rendered, remote images are not loaded, and links allow only HTTP(S) or mailto destinations.

### Investigation history and feedback

New investigation runs store bounded, filtered tool arguments, results, model findings and produced plans in an encrypted local investigations table. Unlock the Vault to read history. Runs survive restarts; interrupted runs are marked failed rather than resumed. History expires with the configured retention (at most 30 days); the history picker shows the latest 100 runs. Legacy runs retain only their previously saved activity summaries. Raw private reasoning is never recorded. Filtering is best effort, and source tickets should not contain credentials.

The open queue or ticket checks YouTrack every 30 seconds while visible and when the window regains focus. Refresh preserves unsaved plan edits, reply drafts and investigation instructions. Source fingerprints cover priority/custom fields, title, description, state and current comments (including edits/deletions even when the issue timestamp stays unchanged). A changed source clears approval and flags the session; writes re-read the source, and investigation results are discarded if the source changed during the run. New investigations receive the latest ticket, not a cached ticket body.

Investigation instructions appear only in Investigation. Plan feedback lives beside the plan. Selecting text opens an icon toolbar for Comment, Recheck and Remove passage. These are revision requests, not immediate edits to the plan or infrastructure. Add comment queues feedback; Send for revision saves it and starts the read-only investigation. The side panel can send all queued comments together. Up to 50 pending comments are included even when the usual recent-note context limit is exceeded. Comments can be deleted with a session-version check; deletion never restores an old approval. Existing history remains intact.

Selected passages use compact previews with safe Markdown formatting for emphasis, code, lists and checkboxes; legacy plain-text selections remain plain text rather than artificial blockquotes. A revised plan remains unapproved. Notes never post to YouTrack automatically.

### AI overview

The AI tab groups local work by ticket or alert and lists the latest 200 retained conversations. It updates every five seconds while visible and requires an unlocked Vault. Workflow states distinguish active runs, engineer review, external pipeline waits, failures, stopped work and confirmed closure. Pipeline waits are explicitly based on the last stored GitLab check; opening this page does not poll GitLab or start work. Source titles are read from the current YouTrack query in memory; work sessions keep only the source key as a reference, not copied ticket bodies.

Investigations, approved change preparation and pipeline diagnoses all record activity. Preparation and diagnosis runs record lifecycle steps in the encrypted investigation store; their file diffs and fix proposals stay in the existing review workflow. Interrupted operations are shown as needing attention rather than remaining running forever. Three identical consecutive tool calls are flagged as repeated actions (a review hint, not proof of a loop). A running conversation with no new event for over a minute is labeled as waiting on a response. No automatic retries, approvals or external writes are introduced by the overview.

Annotated plan text gets a subtle highlight without flattening Markdown formatting. New annotations store selection offsets to distinguish repeated phrases within the same plan version; older annotations use a text match. Long comments, expanded selections and run details have bounded scrolling areas.

### Workspace navigation, settings and diagnostics

The URL preserves the page, selected issue/alert and timeline step, settings tab, AI view, log tool/outcome and dashboard range. Hard refresh and browser back/forward restore that context; URLs never contain credentials or draft text. Unsaved edits remain local to the mounted editor and are not persisted across a browser reload.

Settings reconcile server updates with local edits. Disjoint changes are merged; competing edits to a field require an explicit choice. Account refresh does not reset local settings drafts. Validation lists invalid fields and links to their settings section. Connection switches describe the actual behavior: YouTrack reads, GitLab support operations, Toolbox reads, metric queries, Alertmanager polling or model requests. Changes take effect on Save; disabling a connection keeps credentials and existing remote objects. Outline and Slack remain unavailable adapters. Model configuration and account management have separate tabs.

ChatGPT refreshes are serialized per credential generation. Successful rotating credentials are saved even if unrelated settings changed; obsolete results cannot restore a signed-out or replaced account. Transient provider errors keep saved authentication. Explicit invalid-grant errors require reauthorization. OAuth callbacks redirect away from authorization parameters to the app-themed result screen. Claude subscriptions use the official local CLI login; Support never collects or forwards Claude OAuth credentials. Claude API keys remain supported.

**Logs** contains encrypted diagnostic entries by tool and outcome, with timestamp, duration, request and output detail. Entries are bounded to 2,000 records and configured retention (at most 30 days). HTTP bodies over 24 KB are omitted, not streamed into an unbounded copy. Saved credentials and sensitive fields are filtered before persistence; filtering is best effort. OAuth exchanges and headers are excluded. Model transport bodies are omitted; investigation tool results and terminal run errors are recorded separately. Logs begin with this version; previous investigation details remain in AI. Diagnostic output is not an authoritative ticket store. Rows are compact; opening a row shows scrollable raw text without executing anything.

**Dashboard** shows current workflow states, daily run outcomes, terminal run completion rate, median terminal duration and tool activity. Run metrics use the latest 200 retained runs, grouped by start date in the configured timezone; diagnostic counts use a rolling time window over retained entries. It does not infer ticket resolution, time saved or spend from model runs. Exact chart values are available in a table. No extra service or chart dependency is required.

Architecture and verification plan: [workspace integration](docs/workspace-integration.md). The test command runs files serially to fit a small VM.

Ticket and alert table headers open themed column-filter menus. Ticket filters operate on the loaded YouTrack page; logs filter all retained entries by time, action, tool, outcome and duration. Menus show active filters and clear actions. No filtering action executes a tool or changes a ticket.

List search text and column selections are kept in tab-local session storage so hard refresh restores them. Ticket/alert filters are scoped to the configured source. URL-backed view/state choices continue to support browser navigation. These preferences contain no credentials or copied outputs and are separate from saved server settings.

### Local Claude subscription

In Settings → Model, select Claude → Claude subscription · local CLI. Install the official Claude Code CLI inside the Linux VM, run `claude auth login` there, and choose your own subscription. Set the absolute executable path (`command -v claude`), enter a model such as `sonnet`, allow model requests, save, and check access. Support does not switch your current provider automatically.

Requires CLI support for `--safe-mode`, `--restricted`, structured JSON output and `--no-session-persistence`. Each model turn runs without native file/shell tools or MCP tools, from an empty temporary directory, with user/project customizations disabled. Managed enterprise policy still applies. Prompts travel over stdin; API-key and alternate-provider environment overrides are not inherited. Login remains in the CLI's own credential storage. The app's vault and freshness/approval checks still gate work. This is a CLI capability boundary inside your VM, not an additional OS sandbox.

Model failures retain redacted provider codes, request IDs and error messages in the run and Model logs, without storing model output or reasoning. Successful HTTP admission or model listing alone does not prove inference succeeded. Incomplete/failed streams never produce a plan or changes.

### Dashboard usage and availability

Token usage is grouped by **response time** into the dashboard's hourly or daily buckets (configured timezone). Cached input is already included in input tokens; it is not added again. Model usage totals stay beside the chart. Clicking a token bar opens Model usage logs with that exact time window; counts reflect retained, provider-reported responses.

A server-owned health scheduler checks enabled connections every 60 seconds while the Vault is unlocked, even if no page or investigation is active. At most two checks run concurrently. Each has an abort deadline: Alertmanager 3s, Prometheus/Slack/Toolbox 5s, YouTrack/Outline 8s, GitLab 10s, Model 12s. The first failed check is **Stale**, the second consecutive failure is **Failed**; a successful check resets the failure count. Disabled connections are skipped, Vault/configuration/credential changes invalidate old results, and shutdown aborts outstanding checks. Normal tool activity does not affect these counters. Logs record health-state transitions, never probe response bodies or each healthy minute.

Read-only probes use [YouTrack's current-user API](https://www.jetbrains.com/help/youtrack/devportal/api-fields-syntax.html), GitLab's configured repository branch (or the project list before repositories are mapped), the [Alertmanager](https://prometheus.io/docs/alerting/latest/management_api/) and [Prometheus readiness endpoints](https://prometheus.io/docs/prometheus/latest/management_api/), [Outline's Docker health endpoint](https://github.com/outline/outline/blob/main/Dockerfile), and [Slack api.test](https://docs.slack.dev/faq/). Model API checks read the model/catalog without generating tokens. Local Claude checks its CLI sign-in status; Toolbox checks its executable and readable configuration. These local checks do not claim remote cluster/model availability or validate every operation's permissions.

### Guided tour

Settings → Setup & tour replays the guided journey: configure access → choose a request → investigate → inspect tool results → review/edit/comment on the plan → approve → review a branch diff → approve the MR → track delivery → approve the resolution. Ticket-stage examples exist only in the tour UI: they never create tickets, sessions, approvals or requests. Users who are already configured can skip directly to the ticket journey. Previous/Next, End tour and Escape remain available; welcome dismissal is remembered in this browser.

### Automatic intake and activity housekeeping

YouTrack intake checks the configured query every minute while Model and YouTrack are enabled and the Vault is unlocked. Settings → Approvals & access controls automatic intake and the shared investigation limit (default 2, range 1–4). The former fixed, disabled limit of 1 migrates to 2 once. Alertmanager retains its separate automatic-investigation setting and shares these slots. Approved change preparation and other external operations remain exclusive: they cannot overlap investigations or each other.

Intake reads at most one page of 50 candidates per cycle, rotates through pages, re-reads each source before starting, and records an attempt per source fingerprint. Failed/cancelled unchanged requests are not automatically retried, including after restart. Manual Start investigation supports explicit retries within capacity. Pending plan feedback, current plan reviews, approvals and existing implementation workflows are preserved. New source content can trigger a fresh investigation before implementation; it never grants approval. Open ticket views discover background runs and retain previous snapshots.

AI cards support Resolve locally / Drop and bulk selection of the blocked cards currently shown. These dispositions survive refresh and restart, do not change remote tickets or original outcomes, and can be restored through the corresponding filters. Run dispositions exclude that run from dashboard activity/outcome counts; workflow dispositions exclude that workflow from current workload counts. Token usage and diagnostic history remain factual and unchanged. A new run or changed workflow invalidates its previous disposition. Bulk updates check current signatures atomically; stale selections are rejected.

The guided list and board examples lead into the ticket journey. Investigation uses the same Tool / Query / Result / Conclusion card component as the tour, with bounded scrolling for long outputs. The tour's approval step covers restoring an earlier plan as a new current version before approval.

### Source intake, ownership and ignore rules

Every request starts with its source in the timeline. Alerts and Slack threads wait for an intake decision; the global automatic-investigation setting does not bypass this decision.

| Source decision | Next steps |
| --- | --- |
| Create a ticket | Review the YouTrack project, title and body → approve creation → continue investigation in the linked ticket. The origin stays visible. Recurrences reuse the link; ambiguous creation responses require reconciliation, never another automatic POST. |
| Investigate here | Read-only investigation → plan review → approved GitLab branch → reviewed MR → verified merged pipeline → approved reply. No YouTrack ticket is needed. Alertmanager has no reply endpoint, so an alert's resolution is recorded locally. |
| Reply directly (Slack) | Draft an answer without tools or implementation → edit and approve the exact text → post in the original thread. New comments invalidate an unsent draft. |
| Ignore | Choose a reason, exact scope and expiry (or until removed). Manage rules in Settings → Ignore rules. This is a Support intake rule, not an Alertmanager silence. |
| Take over / Refuse | Stop agent handling, including after new comments, edits and restarts. A reason and history are saved locally. No YouTrack status or public message is changed. Return to agent explicitly, or mark resolved by engineer. |

Alert rules match the configured Alertmanager endpoint, exact alert name and optional exact label values. Use the production/cluster/instance label appropriate to your infrastructure; selecting several values means any of those values. All selected labels must match. Partial groups retain their visible members, but matching members are excluded from the model's source snapshot. Rules invalidate earlier approvals and in-flight results. Expired rules stop matching; permanent rules survive case pruning and recurrence. Slack ignore rules target one channel and thread, including later replies.

Ownership checks run on the server before investigation, plan approval and approved delivery operations. A takeover cancels active investigations and invalidates their results; change generation rechecks ownership before a write. An external request already sent cannot be undone by takeover. Pending writes remain available for read-only reconciliation. Refusal/manual resolution affect AI workflow metrics; recorded run outcomes and token usage remain factual.

Slack connection settings require an API base URL (normally `https://slack.com/api`) and one channel ID. The adapter polls cursor-paginated history one page per minute, deduplicates by endpoint/channel/thread, reads complete threads before decisions and approvals, and honors `Retry-After`. It never posts during polling. Configure an internal Slack app/token with history access and `chat:write` for approved replies. Public/private channel thread reads require the appropriate user-token scopes; see [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/), [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/) and [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/). Subscription/model credentials are separate from Slack tokens.

The setup tour includes source decisions, scoped maintenance ignores, human ownership and Slack direct replies. Tour interactions are examples only. Integration tests use isolated services; configuring a real Slack token and validating its workspace permissions remains a deployment step.

## VM host boundary development

`npm run build` also creates `host-dist/`: an independent host UI and JSON gateway. VM mode uses a private Unix-socket SSH forward, reviewed host PF policy and no live Mac folder shares. This does not alter the current local server. See [VM host boundary](docs/vm-host-boundary.md) before using this profile: native Vagrant topology and actual Mac enforcement are not yet verified. Never run the host gateway from a guest-writable checkout.

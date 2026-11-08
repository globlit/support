# Support installation and hosting plan

**Current decision — 2026-11-08:** Users manage their own VM with vagrant-tart 1.0.0. Support does not create, provision or control VM lifecycle. The earlier managed-default stages below are superseded by [existing VM setup](existing-vm.md); the companion is delivered as an ad-hoc-signed drag-to-Applications DMG built on an existing Mac. No Apple membership or dedicated Mac runner is required. Tart isolation must be validated before its connection is enabled.


Status: implementation roadmap, updated 2026-11-08. Step-one implementation and its verification boundaries are recorded in [security-foundation.md](security-foundation.md). The host gateway, network-policy tools and no-share input boundary are implemented in [vm-host-boundary.md](vm-host-boundary.md), pending native-provider Mac validation. This document does not claim that a DMG, managed VM, container deployment or hosted authentication already exists.

The intended product is one Mac application, one browser UI and one workflow engine, with three deployment choices. Keep YouTrack authoritative and retain all plan, diff, ticket creation and reply approvals.

## Decisions confirmed with the engineer

- Offer a managed Linux VM by default and support an existing Ubuntu VM.
- Hosted deployments expose an Ingress or HTTPRoute, restricted to company source IP ranges.
- Hosted sign-in supports Google and generic OIDC, including a future move to Keycloak or Authentik.
- No Apple Developer membership or dedicated Mac build machine will be acquired. Ship an unsigned/ad-hoc-signed DMG and accept per-application Gatekeeper warnings.
- Installation must not require end users to compile Swift, run an installation script, install developer tools, manage certificates or maintain tunnels manually.

## Non-negotiable host boundary

The AI/guest must never gain a VM-to-Mac command, filesystem, agent, proxy or reverse-forward capability through the Support connection. Only Mac-initiated application requests and bounded data responses are permitted. A transport is bidirectional at the byte level; that must never become bidirectional authority.

This rule overrides installation convenience. Host-side firewall isolation, independent read-only input images with no live shares, protected application code, browser-origin handling and an adversarial Mac/VM test are release gates. Guest-controlled policy or an SSH argument list alone does not prove that a compromised VM cannot reach the host through its normal virtual network. A guest must not control a host update, executable path, mount, local proxy destination or URL scheme. Do not claim complete isolation until these independent controls are demonstrated.

## 1. User experience and deployment choices

Deliver `Support.dmg` containing `Support.app` and an Applications shortcut. The native application owns the menu-bar status, connection setup, optional login launch, notifications and the Open Support action. The application opens the default Mac browser; it does not need a second embedded browser UI or an Electron runtime.

| Setup choice | Runtime | Browser entry | End-user work |
| --- | --- | --- | --- |
| On this Mac — recommended | Small Linux VM managed by Support using Apple Virtualization.framework | Mac loopback gateway | Install app, select workspace folders, configure accounts |
| Existing VM | Supported container bundle inside the engineer's Ubuntu VM | Same Mac loopback gateway, carried over SSH | Import a prepared connection profile; complete VM enrollment once |
| Team workspace | Shared Support service in Kubernetes; restricted runners close to tools | Workspace HTTPS URL | Enter/import workspace URL, company SSO, allow notifications |

Hosted browser access also works without the Mac app; install the companion for native notifications and the menu-bar entry.

The browser interaction, tour, filters, plan revisions, approval steps and notification deep links remain the same. The address differs for a hosted workspace. Persist UI preferences by stable workspace ID, not one global key that mixes local and hosted data.

The difference that cannot be hidden is availability: local work pauses when the Mac/VM sleeps; hosted work can continue. A notification can only appear on a Mac when its companion is running, awake and connected. Show this clearly in connection status without adding instructions to every page.

“On this Mac” runs the interface natively and the tools in an isolated Linux guest. Do not run the agent and privileged CLI tools directly as the Mac user. This also matches the existing Linux-only Toolbox adapter. A separate native macOS backend would duplicate packaging and weaken the established boundary; exclude it from the normal product. An existing compatible container runtime can become an advanced connection option, not another mandatory installation.

Apple documents both Linux guests and host–guest socket communication through Virtualization.framework. Using it removes the requirement for a separately installed VM manager, but makes VM image maintenance and recovery our product responsibility. [Linux virtualization](https://developer.apple.com/documentation/virtualization/running-linux-in-a-virtual-machine), [host–guest sockets](https://developer.apple.com/documentation/virtualization/sockets).

## 2. Baseline repository findings before step one

These baseline observations explain the planned changes. The implemented session/deployment/identity slice is described in [security-foundation.md](security-foundation.md); this table is not the current security status or a deployment certification.

| Component | Current behavior | Change needed |
| --- | --- | --- |
| `companion/macos/install.sh` | Compiles Swift on the user's Mac, ad-hoc signs by default, copies into `~/Applications` | Prebuilt unsigned/ad-hoc-signed app bundle and DMG |
| `companion/macos/SupportCompanion.swift` | Native notifications, Keychain pairing, fixed SSH forwarding, loopback endpoint; no hosted profile | Profile-aware connection service, native enrollment, runtime management and remote HTTPS mode |
| `server/index.ts` | Hard-coded loopback bind, Host and Origin; timers live in one server process | Explicit bind/public origin configuration, authenticated sessions, deployment mode validation and durable scheduling |
| `server/companion.ts` | Hash-only device tokens; notification polling and acknowledgment; encrypted outbox | Preserve scope, add user/workspace ownership, rotation and authenticated device enrollment |
| `server/store.ts` | SQLite, one process-wide unlocked vault key; approval actor often comes from configured engineer name | Trusted actor context, workspace scopes, hosted key management and durable ownership/leases |
| `server/toolbox.ts` | Fixed read adapter; Linux-only CLI; subprocess currently inherits environment | Isolated broker, minimal environment and credentials scoped to the operation |
| Deployment files | Compose exists for lab dependencies | Actual production image, deployment bundle, Helm chart and release pipeline |

The loopback/Origin checks are useful browser defenses, but they are not user authentication. Vault encryption is not user authorization. Neither an ingress allowlist nor an SSH tunnel changes that. Do not expose the current server by simply changing its bind address.

Earlier sections of `docs/architecture.md` contain historical implementation milestones. Use current source plus this plan when designing deployment changes.

## 3. Mac distribution and updates

### Release artifact

- Package a prebuilt app into a DMG without requiring an Apple membership or dedicated build infrastructure. Native Swift/AppKit binaries still require a macOS toolchain at some point; use an existing engineer Mac for a release build or a supplied compatible artifact. End users must not compile the app. This plan does not acquire a build machine.
- Produce arm64 and x86_64 artifacts, or a verified Universal app. VM images and bundled Linux tools must match the host architecture; do not silently emulate amd64 on an M2.
- Use ad-hoc signing where macOS requires it for executable integrity/entitlements, then package the drag-to-Applications DMG. This is not a verified publisher identity. Validate the bundle and entitlements; document the expected per-app Gatekeeper warning. Never disable Gatekeeper system-wide.
- There is no Apple notarization pipeline. No customer configuration, workspace data or credentials may be embedded in release artifacts.
- Keep the bundle identifier and Keychain identity stable so updates preserve pairing. Explicitly test migrating the existing ad-hoc install: macOS may require new permission or re-pairing because its signing identity changes.
- Store settings and disks in Application Support, not inside the app bundle. Use Keychain for device private keys and local unlock material. Avoid root launch daemons and Full Disk Access.
- Optional launch at login uses the native ServiceManagement API. Explain that quitting the connection service stops local connectivity/notifications; closing a setup window does not.
- Ship a signed update manifest with app/runtime compatibility, hashes and image digests. Verify signatures before staging; do not accept updates from arbitrary workspace-provided URLs. Use the organization's release origin and an independently pinned release-signing key.
- Keep the previous runtime until migration succeeds. A database migration requires a consistent encrypted backup and explicit rollback compatibility, not blindly starting an old binary on a new schema.
- Uninstall removes the app normally. Offer a separate explicit “Remove local workspace data” action; dragging the app to Trash must not silently destroy tickets' work sessions, backups or VM disks.

Distribution accepts Gatekeeper warnings by product decision. Independent release-manifest signatures and pinned hashes remain useful without Apple membership; they protect updates but do not remove macOS warnings. A prebuilt native binary cannot be generated or Mac-tested on this Linux workspace alone.

### First launch

1. Choose **On this Mac**, **Existing VM**, or **Team workspace**.
2. Local default: check disk/RAM, download and verify the runtime, create the VM, then ask for explicitly selected folders. No Terminal step.
3. Existing VM: import a signed workspace profile or enter its address, verify its identity, and enroll this Mac. Never silently trust the first SSH key received over an untrusted network.
4. Hosted: open browser sign-in against the selected workspace. Return through a short-lived bound enrollment transaction; the native app does not collect Google/OIDC passwords.
5. Ask for macOS notifications at the point where their purpose is clear. Test delivery and opening the correct page.
6. Open the existing in-app setup and tour. Connection and Vault settings remain separate. A packaged tool path is prefilled; users enter endpoints, accounts, project/channel scopes and repository choices.

Existing arbitrary VMs need a one-time administrator bootstrap if SSH/container support is not already present. A prepared guest image or organization provisioning can eliminate that per-user work. There is no secure way to control an unprepared VM without an initial trust/bootstrap step.

## 4. Browser access and certificates

### Managed VM

`Mac browser → authenticated loopback gateway → authenticated guest channel → Support`

Use a host–guest socket for the default managed VM, avoiding guest-IP discovery and an open guest TCP listener for browser ingress. Provision a per-install identity over the owned VM bootstrap path and use mTLS on the guest channel with an app-private trust store. No browser or system-wide CA installation is involved. Authorize this channel; a socket is not by itself a user identity. A small guest relay forwards only the Support application endpoint and exposes no generic command, filesystem or network proxy API.

If the host–guest path is unavailable for a supported host, a fixed-purpose SSH tunnel is a compatible fallback, not a reason to expose the VM to the LAN.

### Existing VM

`Mac browser → loopback gateway → SSH local forward → VM loopback publish → Support container`

SSH already authenticates and encrypts the Mac–VM hop. Use a dedicated forwarding identity restricted server-side to the Support destination, with strict host-key verification, no shell/subsystem sessions, no remote/dynamic forwarding, no agent forwarding and no arbitrary SSH config execution. `MaxSessions 0` can disallow shell/subsystem sessions while allowing forwarding; `PermitOpen` restricts destinations. Verify the actual Ubuntu OpenSSH version and account configuration in integration tests. [OpenSSH configuration](https://man.openbsd.org/sshd_config).

Keep provisioning privileges separate from this day-to-day identity. A one-time installer may install a narrowly specified user service after administrator authorization, but the companion must not retain a general-purpose admin key for normal operation.

### Why not weekly self-signed browser certificates?

A self-signed leaf that changes weekly breaks the browser's trust relationship unless every replacement is trusted again. Installing an app-owned root CA system-wide adds a powerful trust anchor and extra setup. It adds little value to the local UI path when the network hop is already protected by SSH.

Recommended local default: HTTP on literal `127.0.0.1` only, with authenticated browser sessions and an authenticated/encrypted guest transport. The browser-to-companion segment stays on the Mac. This is not protection against malware controlling that Mac. If policy requires TLS on even the local loopback segment, use organization-managed trust as a separate deployment profile; do not teach users to bypass certificate warnings.

For hosted access, use a normal browser-trusted certificate at the ingress/gateway, managed through the organization's issuer or existing cert-manager installation. An internal enterprise CA is also possible when already trusted by managed Macs. Client IP restrictions still apply.

For runner mTLS, short-lived private certificates are appropriate: proposed lifetime **7 days**, renewal **48 hours before expiry**, fresh key on renewal, automatic reload and bounded connection lifetimes. That renews before the weekly deadline rather than risking a gap at expiry. Pin the stable CA/trust identity, not a changing leaf. CA rotation uses an overlapping trust bundle and a separate tested rollover process. Expired or revoked identities fail closed; an offline runner that misses renewal requires authenticated re-enrollment. Certificate rotation is not a replacement for revocation.

cert-manager supports early renewal and explicit private-key rotation; self-signed/CA issuers still require trust-distribution and recovery design. Reuse company PKI when possible rather than installing another issuer for every user. [Certificates](https://cert-manager.io/docs/usage/certificate/), [SelfSigned limitations](https://cert-manager.io/docs/configuration/selfsigned/).

### Local gateway rules

- Bind only the Mac loopback interface; never `0.0.0.0`. Detect port conflicts and verify the workspace identity before sending secrets to a listener.
- Keep a stable workspace identity separate from the port. Handle port remapping without corrupting OAuth callbacks, bookmarks or filters. Provider redirect-URI requirements must be tested; do not assume every provider accepts arbitrary ports.
- Issue an actual browser session. Use a short-lived single-use browser handoff from the paired app, bound to the workspace and login attempt; never place a long-lived device token in a URL. Remove transient handoff data from browser history immediately.
- Use HttpOnly/SameSite cookies, CSRF tokens and exact Host/Origin checks; use Secure cookies on HTTPS. Test Safari and Chromium loopback behavior explicitly rather than assuming HTTPS cookie behavior on HTTP.
- Do not make the notification-only token authorize browser login or approvals. New browser-enrollment credentials are a distinct scope and identity.
- No open reverse proxy: only one enrolled Support backend, no caller-supplied upstream URL, no forwarded host/header trust outside the configured proxy chain.
- Properly support streaming, cancellation, downloads and OAuth completion through the gateway. Reconnect with bounded backoff and preserve the current page.

## 5. Runtime bundle and tool boundaries

Use the same versioned Linux OCI images for the managed guest, existing VM and Kubernetes. Distribute a pinned multi-architecture release bundle, with an optional offline bundle for corporate environments.

Do not equate “tools included” with “model may run any command.” Provide two roles:

- **Support service:** UI, source intake, orchestration, provider adapter, sessions and approval records. No cluster-admin credentials or container-engine socket.
- **Tool runner/broker:** fixed tool adapters, execution policy, scoped credentials, temporary working copies and sanitized results. The model receives typed operations, not a shell prompt with ambient credentials.

These can be two small containers locally. Keep a basic read-only deployment compatible with the existing adapters during migration, but do not expand execution permissions before the broker boundary exists. Separate an arbitrary-code worker further if that capability is introduced later; it receives neither the broker's credentials nor unrestricted network access.

Bundle supported, pinned versions of Toolbox, Git, kubectl, kubeseal and the necessary adapters. Include glab/promtool/Flux tooling where the corresponding supported workflow needs them. API-based adapters do not need redundant CLIs merely for packaging symmetry. Put optional heavyweight tools in versioned profiles. Verify each exact dependency's license before distribution; Terraform distribution and any OpenTofu alternative require an explicit compatibility/licensing decision rather than a silent swap.

Hardening defaults:

- Non-root processes; prefer rootless runtime in the guest; drop all unnecessary capabilities, prohibit privilege escalation, apply seccomp, read-only root filesystem and bounded tmpfs.
- No Docker/containerd socket in Support or model containers; no host PID/network namespaces; no broad Mac home mount or host SSH-agent forwarding.
- Explicit selected repository mounts, normally read-only. Writable independent per-run checkouts with disk quotas. Reject symlink/path escape and keep Git credentials out of model-readable files.
- Disable Git hooks, uncontrolled filters/helpers, submodules and repository-defined execution during inspection. Configuring a repository must not itself authorize executing repository code.
- Minimum environment for tool processes; credentials are selected per adapter and operation. Kubeconfig exec plugins and MCP executables are executable code and require admin-reviewed allowlisting, not arbitrary path acceptance.
- Kubernetes access scoped by context, namespace, resource and verb; enforce exclusions outside the model. Port-forward permissions require separate destination and lifetime limits. Current read restrictions remain until a specific new adapter is implemented and tested.
- Secret creation/modification uses placeholders and a dedicated secure entry/sealing path; decrypted values never need to enter model messages or general logs.
- Restrict network egress to configured tool and model endpoints. Protect cloud metadata, loopback and internal management endpoints from SSRF while explicitly allowing the private enterprise endpoints each connection requires. Revalidate DNS/redirect targets.
- Per-operation timeout, result-size cap, process-group cancellation and concurrency budget. Proposed initial budget: 2 active investigations total per workspace, 1 write operation per affected target, with serial local writes.

Container networking needs an explicit server change: bind the process on the container interface, but publish only `127.0.0.1:4173` on the VM host; preserve public-origin validation independently of bind address. Do not use host networking as a shortcut. Docker's documentation notes historical localhost-publishing exposure before Engine 28.0.0; require a patched supported engine and test reachability from another machine, for IPv4 and IPv6. [Port publishing](https://docs.docker.com/engine/network/port-publishing/), [rootless operation](https://docs.docker.com/engine/security/rootless/).

Starting resource targets, to benchmark rather than promise: managed VM 2 vCPU / 2 GiB RAM, sparse disk capped at 20 GiB, hosted-model inference, no desktop environment, no local GitLab/YouTrack/Prometheus instances. Bound caches/logs/worktrees and expose disk pressure before exhaustion. Validate rootless cgroup enforcement; reject settings that appear capped but are not. Raise limits through an explicit profile when a real tool workload needs it. Do not bundle local model weights by default.

## 6. Hosted Kubernetes architecture

The hosted service must not become a central unrestricted tunnel into every cluster. Prefer a small number of **runners per trust zone**: for example development, preproduction and production. A runner lives where its allowed services are reachable. It opens an outbound authenticated connection to the control plane and receives typed scoped jobs; no inbound access to remote clusters is required.

This is an application job protocol, not a VPN, SOCKS proxy, remote shell or generic TCP tunnel. A compromised control plane can still attempt malicious jobs, so outbound-only connectivity is not a complete security boundary. The runner independently enforces a locally administered policy that the central application cannot broaden.

```text
Mac browser + companion
         │ HTTPS, company IP allowlist, Google/generic OIDC
         ▼
Ingress or Gateway + HTTPRoute
         │
Support control plane ── database / encrypted state / audit
         ▲
         │ outbound runner-initiated mTLS job sessions
         │
Runner: development       Runner: preproduction       Runner: production
  local credentials        local credentials          local credentials
  allowed endpoints        allowed endpoints          allowed endpoints
```

### Hosting and ingress

- Default installation: one DevOps workspace, four named users, one active control-plane instance. Do not claim general multi-tenant SaaS isolation.
- Publish either Ingress or HTTPRoute in the chart, not two accidental exposure paths. Reuse an existing ingress/gateway and TLS issuer.
- Apply company IPv4/IPv6 CIDR allowlists at the actual external enforcement point. Source-IP preservation and trusted-proxy configuration must match the selected controller/load balancer. Never trust client-supplied `X-Forwarded-For` as proof of company origin.
- HTTPRoute routing alone does not define a portable source-IP allowlist. Support documented controller-specific policy profiles, and fail deployment validation if the requested restriction cannot be enforced. Test the real external path from allowed and disallowed networks. [HTTPRoute](https://gateway-api.sigs.k8s.io/guides/http-routing/).
- No alternate publicly reachable Service/NodePort/origin bypass. NetworkPolicy restricts ingress to the selected proxy, not every pod in the cluster.
- Runner enrollment/connection may need a separate hostname or listener with runner-network source ranges and mandatory mTLS. Do not broaden the UI's company-IP allowlist just to admit a runner from another network.
- Macs outside company egress require the company VPN to use the UI or notifications. Google token/JWKS requests are outbound from Support; the user's browser returns to the allowed callback URL.

### Identity and authorization

- One OIDC implementation with a Google preset and generic issuer/discovery configuration. Use authorization-code flow, PKCE where supported, state, nonce, exact redirect URIs and validated signatures/issuer/audience/expiry. Use server-side sessions; no provider secrets in browser storage.
- Identify users by `(issuer, subject)`. Validate Google hosted-domain claims where configured plus explicit membership; an email suffix or the requested `hd` parameter is not proof of membership. Generic providers may supply configured group claims. Google OIDC does not automatically provide the company's group membership; start with explicit user/role assignments unless a directory integration is separately authorized. [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html).
- Roles: Viewer, Engineer, Workspace administrator. Scope engineer rights to environments/connections and exact actions. A configuration display name is never the approving actor.
- Capture authenticated identity and current authorization on every API action, stream, download, event and approval. Notifications carry only events the paired user can currently access; revoke on device removal or user access removal.
- Login lock/logout is per user; operational Vault lock is a separate workspace/admin action. Signing one engineer out must not halt everyone's work or release another user's credentials.
- Allow an auditable IdP migration: explicit verified account linking. Never merge Google and generic-OIDC identities merely because email addresses match.
- Short-lived sessions and periodic role revalidation; MFA enforced by the IdP, with stronger reauthentication for sensitive approvals if available. Browser authentication and CLI/model subscription authentication stay separate.

### Infrastructure authority and approvals

Keep cluster credentials on runners, never on the ingress-facing service. Give the control plane no ambient Kubernetes token; set `automountServiceAccountToken: false` except where a narrowly scoped role explicitly needs it. GitLab writes remain branch/MR operations against selected repositories; production changes flow through protected branches and independently enforced review/CI/Flux policies.

A dispatch is bound to workspace, user, operation ID, plan/diff hash, target, source revision, policy/config revision, expiry and runner identity. The runner checks policy, expiry, deduplication and current preconditions. Store operation intent before effects and reconcile ambiguous results; never retry an uncertain write blindly.

A central approval record signed only by the same central service does not protect against that service being compromised. Initial hosted production policy therefore prohibits direct privileged cluster mutations and relies on independent GitLab/Flux enforcement. Direct high-risk actions would require a later independent approval mechanism—such as an engineer-held signing key with a separate trusted review surface and locally enrolled public keys—and dedicated security review. Do not present mTLS alone as solving this problem.

Takeover, refusal, ignore rules and cancellation apply before dispatch and when accepting results. An already-submitted GitLab operation may finish; retain and report that fact. A new comment must not reactivate a human-owned ticket. In-flight results from stale source/configuration/credentials become review-only and cannot inherit approval.

### Storage, keys and availability

- Local mode keeps SQLite and encrypted Vault data on the guest disk. No state in disposable container layers. Preserve the existing explicit unlock default; optional local auto-unlock must be a separate user choice backed by a device-wrapped key in Keychain, never a plaintext stored passphrase.
- First hosted profile can use one SQLite writer on a supported block-backed PVC with `Recreate` rollout and an explicit single-replica guard. This is a modest team deployment with restart downtime, not HA. Never run multiple SQLite writers over a shared network filesystem.
- Introduce a storage interface and migration tooling. Offer PostgreSQL when multi-replica availability is needed; durable database-backed leases and job claiming are prerequisites, not optional afterthoughts. No Redis/Kafka requirement for four engineers.
- Hosted unattended work needs an operational key strategy: envelope encryption with the organization's KMS/secret manager where available, otherwise an explicitly accepted mounted key with rotation and backup controls. Do not share a vault passphrase among engineers or require one engineer to unlock every pod restart.
- A Kubernetes Secret is delivery/storage plumbing, not by itself encrypted application key custody. Separate key recovery from encrypted database backups and enable the platform's at-rest protection.
- Document which existing tables are plaintext before migration. Current credential/log encryption does not prove all work-session content is encrypted. Encrypt sensitive plan, reply, artifact and provenance data deliberately, including backups.
- Keep personal model accounts per user; do not pool subscription credentials into a team service. Prefer organization-approved provider API credentials for unattended shared jobs; validate provider terms and enterprise policy before enabling any subscription-backed hosted runner.
- One active intake owner per source/workspace prevents duplicate automatic investigations. Local-to-hosted migration stops local intake before enabling the hosted owner. Cross-installation cooperation is not supplied by SQLite leases in separate installations.

### Kubernetes hardening

Run in a dedicated management namespace, preferably a management cluster outside the production targets. Enforce Restricted Pod Security, default-deny ingress and egress, non-root users, read-only root filesystems, seccomp, capability drops, limits/quotas and dedicated identities. Cluster admin applies policy; the app cannot edit its own network or RBAC boundary.

NetworkPolicy needs a supporting CNI and does not provide TLS identity or portable FQDN/L7 filtering. For changing DNS endpoints and operation-level restrictions use the broker and an explicitly controlled egress proxy/CNI policy. Separate networks are still necessary to limit a compromised broker. Reuse existing platform services rather than adding a service mesh solely for Support. [Kubernetes security checklist](https://kubernetes.io/docs/concepts/security/security-checklist/), [NetworkPolicy limits](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

Prefer pre-created restricted runners rather than giving Support broad permission to create arbitrary Jobs. If per-job pods are later needed, use a separate constrained launcher, fixed signed image digests and admission policy that rejects arbitrary images, credentials, capabilities and mounts. `create pods` can otherwise become an indirect privilege-escalation permission.

## 7. Notifications across all modes

Retain native local notifications and the current minimal payload policy. No APNs, public notification relay or browser push dependency is needed for the first release.

- Local and VM profiles use the authenticated local channel. Hosted profiles use HTTPS with notification-only device authorization tied to a user and workspace.
- Prefer a resumable event stream with heartbeat and polling fallback. Authenticate reconnects, cap buffers and use per-device event IDs/cursors with acknowledgments and deduplication.
- Store device secrets in Keychain; keep only hashes or public keys server-side. Add expiry/rotation and remote revocation; never rotate by silently extending a revoked enrollment.
- Notification clicks open validated application-owned relative routes, never arbitrary URLs embedded in ticket/model content. Opening a page may require browser sign-in; it never approves anything.
- Hide content by default. Do not display raw tool outputs, secrets or sensitive ticket titles on the lock screen.
- On sleep/wake, reconnect and deliver only still-relevant notifications. Backoff during outages. “Accepted by macOS” is distinct from “seen by the engineer.”
- Expose a single status: Connected / Reconnecting / Sign in required / Vault locked / VM stopped, with one precise action. Allow per-profile disconnect and revoke.

## 8. Settings and onboarding integration

Mac app handles installation, workspace profiles, runtime start/stop, selected folder grants, connection identity and notification permission. Browser Settings handles service connections, repositories inside the runtime, model accounts, Vault, scope/approvals and team administration.

Show mappings explicitly: `Mac selected folder → VM/container path`. Hosted users select runner repository IDs or remote GitLab projects; a Mac filesystem path has no meaning on a remote pod. Preserve aliases across deployment migration rather than silently reinterpreting paths.

Provide a read-only readiness page: runtime health, endpoint/identity validation, authentication, permissions, storage, selected repositories, tools installed versus supported adapters, runner connectivity and notification delivery. A health check must never execute a deployment or reveal a credential.

Tour branches only for setup screens that differ by mode, then converges on the same real ticket workflow. Demonstrate the connection menu, notification action, and local sleep/hosted availability behavior. The live UI remains the source for tour visuals.

For Kubernetes, ship a chart schema and validated example values: route mode/class/hostname, external TLS secret or issuer, company CIDRs/controller profile, Google/generic OIDC secret references, existing data/key storage, runner enrollment policy, approved model endpoint, resource/retention limits and backup destination. Helm users perform the platform install; engineers should not need cluster access just to open the app.

## 9. Code integration and migration boundaries

Keep deployment-specific behavior behind explicit interfaces rather than scattering platform checks through ticket components.

| Area | Implementation direction |
| --- | --- |
| Native app | Split the current single Swift file into profile storage, connection transport, notification delivery, browser enrollment and runtime lifecycle modules. SSH, guest socket and hosted HTTPS implement the same connection protocol. |
| Release build | Replace the end-user source ZIP with a CI-built DMG. Keep development compilation separate. `scripts/package-companion.mjs` must link only to a verified release artifact and never label a source ZIP as the normal Mac download. |
| API server | Extract deployment configuration and authentication middleware from `server/index.ts`. Validate listen address, public origin and proxy chain separately. Pass a trusted actor/workspace context into services. |
| Tool execution | Define a versioned typed runner protocol, capability manifest and operation envelope. Existing adapters move behind the broker with behavior-preserving regression coverage before new tool authority is added. |
| Persistence | Introduce repository interfaces around current Store operations, versioned migrations and operation leases. Preserve SQLite local compatibility; use a separate tested SQL implementation if PostgreSQL is enabled. |
| Device delivery | Keep notification credentials narrowly scoped. Add separate enrollment/session types and per-user ownership to `server/companion.ts`; never broaden `companionScope` to allow workflow writes. |
| Browser | Keep existing ticket UI and routes. Add a deployment capability response for setup/settings, workspace-scoped preferences and typed recovery states. Never infer identity from a user-editable configuration name. |
| Deployment | Add production Dockerfiles, pinned tool manifest/SBOM, guest image recipe, Compose bundle, Helm schema/templates and controller-specific ingress restriction tests. The development service stack is not the production bundle. |

Migration must preserve existing local work sessions, plans, annotations, ignore rules, filters and configured paths. Import shows path remapping, credential ownership and operational consequences before switching. Take an encrypted backup; enroll the new runtime; verify reads and notification delivery; stop the old intake owner; revalidate approvals; then enable the new owner. A migration never auto-approves or retries an unfinished external write.

Host identity, profile data and device keys remain outside the app binary. A runtime protocol handshake rejects incompatible app/server/runner combinations with a concrete update action. Do not silently fall back to insecure authentication when connecting an older workspace.

## 10. Delivery sequence and acceptance gates

| Stage | Deliverables | Acceptance gate |
| --- | --- | --- |
| 1. Shared foundation | Runtime/public-origin configuration, trusted session/actor context, workspace IDs, version handshake, scoped device enrollment and storage interface | Origin/session/CSRF, cross-workspace denial, token scope and approval regression tests |
| 2. Mac release | Native profile UI; unsigned DMG pipeline; integrity checks; stable Keychain identity; update staging | Clean Mac drag-install, permissions, notification/deep link, upgrade/uninstall with data preserved |
| 3. Existing VM bundle | Production OCI images, loopback publishing, restricted SSH enrollment, broker policy, Compose/service management | No LAN reachability; unknown host/port takeover fails; sleep/restart reconnect; no general remote command |
| 4. Managed VM default | Signed guest image, first-run provisioning, folder grants, host–guest channel, resource cap and recovery | Fresh Mac setup without Terminal/Docker/Xcode; M2 resource benchmark; interrupted download/boot recovery |
| 5. Hosted team profile | Google/generic OIDC, role enforcement, Helm Ingress/HTTPRoute profiles, source-IP policy, state/key/backup lifecycle | External allow/deny tests, source-IP spoofing denial, OIDC failures/role revocation, restore drill |
| 6. Restricted remote runners | Scoped outbound job sessions, runner PKI rotation/revocation, local policy, durable dispatch/reconciliation | Compromised-control-plane simulation cannot expand runner scope; cross-zone denial; stale/replayed job rejection |
| 7. Operational rollout | Signed release channels, dependency/SBOM/license inventory, runbooks, metrics and update/rollback drills | Development pilot, then preproduction; production only after independent enforcement is proven |

Stages 5 and 6 form one hosted release gate: do not give a publicly reachable Stage-5 service production infrastructure credentials while runner isolation is unfinished. Stage 3 can ship earlier for the existing VM, while Stage 4 makes the final default install self-contained.

Apple membership and dedicated Mac build infrastructure are excluded. Native packaging/verification must use an existing Mac or an appropriate supplied binary; no notarized-release promise is made.

Additional required validation:

- No tool can read outside mounted roots, execute repository hooks or inherit unrelated credentials.
- Unknown SSH host keys, changed workspace identity, occupied loopback port and expired mTLS identities fail closed without transmitting a pairing token.
- Certificate renewal survives clock skew/restart and reloads on both peers; CA rollover and emergency revoke terminate old authorization, not just future handshakes.
- Browser refresh retains route/filters; connection loss preserves drafts; Vault recovery returns to the same page.
- Approval remains specific across source edits, priority changes, changed comments, plan versions, config/credential changes and human takeover.
- Multiple browser sessions and controller restarts cannot create duplicate branches, MRs, tickets or replies. Ambiguous writes are reconciled before retry.
- OIDC issuer migration does not silently merge identities or grant roles; removed users lose streams, devices and approval rights.
- Backup restore recovers sessions, approvals, ignore rules and settings; old device credentials and approvals are reconciled/revalidated before work resumes. Use a restore generation to invalidate outstanding jobs.
- Uninstall/update never erase a workspace without an explicit data-removal choice. Credential and backup recovery are documented and exercised.

## 11. Recommended scope

Finish the existing-VM connection adapter and validate Tart/Softnet isolation on the intended Mac. The DMG builder and connection diagnostics preserve local-service mode. App-owned VM creation and image distribution are out of scope. Hosted identity and independent runner isolation remain required before hosted infrastructure access.

The remaining deployment-specific inputs are the actual ingress/gateway implementation, company egress CIDRs (including runner egress), Google Workspace domain/client registration, existing key/backup services and supported Mac baseline. These are configuration/release inputs, not reasons to redesign the three-mode architecture.

# Support Companion for macOS

A native menu-bar app for macOS 13 or newer (Apple silicon or Intel). It delivers local notifications for new reviews, blocked work, reopened work and optional completions. Clicking opens the matching ticket or alert in Support. The companion cannot approve plans, run model tools, create tickets or send replies.

## Install on the Mac

1. Download the source installer from **Support → Settings → Notifications** and unzip it.
2. Install Apple Command Line Tools if needed: `xcode-select --install`. Use current tools (Xcode/Command Line Tools 15 or newer).
3. Open Terminal in the extracted folder and run `bash install.sh`. It compiles locally, signs the app with a local ad-hoc signature and installs it into `~/Applications/Support Companion.app`. No sudo, package manager or external dependency download is used by the installer. Apple may need to download its tools separately.
4. Keep the companion open; its bell icon appears in the menu bar. Launch at login is optional.

No Apple Developer membership or dedicated Mac build machine is planned. This development source installer does not ship a notarized binary; unsigned/ad-hoc release packaging will retain the expected per-app Gatekeeper warning. Rebuilds with ad-hoc signatures may require Keychain or notification permission again. Existing Keychain pairing is preserved, unless macOS denies access to the newly built app.

## Connect from the host Mac to the Ubuntu VM

VM connections now require the **host gateway**. The companion no longer opens a raw browser-facing SSH tunnel. Existing local-service mode is unchanged; do not select it as a bypass for a VM connection.

The host gateway serves an independently packaged UI and bounded data, verifies host PF rules and owns a private Unix-socket SSH forward. The companion checks a fresh challenge against a private host key before sending a pairing code/token or opening the browser. Guest HTML or a process occupying the port cannot satisfy that challenge without the host key.

This is development integration, not yet a certified native Vagrant installation. Follow the repository's `docs/vm-host-boundary.md` for the provider/network checks, no-share Vagrant guard and input images. Native NAT must not be assumed filterable. Actual Mac validation remains required. Native activation is currently gated in code until the actual provider network and folder controls are verified. The gateway development bundle needs Node 24; final drag-install packaging is separate work.

After a verified native-provider adapter is implemented and the host gateway can be activated:

1. Choose **In my VM · host gateway** and its Support port (default 4173). No SSH host, key or tunnel options are supplied by the VM.
2. Open the host-served Support page and unlock with the existing Vault passphrase.
3. In **Settings → Notifications**, generate a pairing code, then paste it into the companion and select **Pair this Mac**.
4. Allow native notifications and send a test. Clicking a notification revalidates the host gateway before opening the app.

For a service actually running locally on the Mac, choose **On this Mac · local service**. It does not claim VM isolation. Do not expose Support on the LAN or retain old TCP forwards to the guest UI.

## Preferences and delivery

Save notification preferences in Support. Review notifications include plan, diff, ticket and reply approvals and intake decisions. Blocked notifications cover workflow failures and unresolved actions. Reopened notifications cover a recorded ticket reopening or a previously completed workflow returning to active work; the VM must first observe that change through its normal source refresh. Completion means the workflow is complete, not merely that a model run finished.

A new installation establishes a baseline rather than notifying for all existing work. Subsequent relevant transitions are recorded every five seconds while a Mac is paired and the Vault is unlocked. Each Mac polls every five seconds, backing off during outages. The app retries unacknowledged delivery and remembers delivered IDs to reduce duplicate banners across reconnects. Queued notifications are discarded when their workflow changes, and eligible for delivery only within your configured retention (maximum 30 days / 500 events). Expired encrypted entries are pruned on the next unlocked check; removing the last Mac clears the outbox immediately. A sleeping or disconnected Mac sees only still-relevant queued updates after reconnecting. No delivery occurs while the Vault is locked.

Private previews are enabled by default. If disabled, notifications may include a constrained ticket reference such as LAB-1; ticket titles, descriptions, comments, results and model output are never included. Delivered notifications belong to macOS Notification Center; changing preferences or locking Support cannot retract previously displayed content. You can clear these in Notification Center.

## Pairing and removal

The device token is stored in the Mac's Keychain. Support stores only its hash. Pairing codes are also stored only as hashes. The VM's outbox and workflow fingerprints are encrypted using the unlocked Vault key. No push provider or Apple push service is involved; notification traffic stays on the local connection or SSH tunnel.

**Remove Mac** in Support revokes access immediately. **Disconnect** in the companion removes the local Keychain item and delivered notifications, but does not delete the server-side device; remove it in Support too. At most five Macs can be paired. Paired tokens grant only notification poll/ack access; they do not unlock the Vault or authorize workspace actions. This is not isolation from software already controlling your local OS: Support itself remains a trusted, local application.

## Troubleshooting

- **Host gateway unavailable:** verify the separately installed host gateway, reviewed PF policy, dedicated forwarding key and pinned SSH host key. A missing host proof must never be bypassed with a direct tunnel.
- **Pairing code expired:** generate another code with the Vault unlocked. A lost response during pairing may leave an offline device entry; remove that entry and pair again.
- **Paired but silent:** send a test with the Vault unlocked, then check System Settings → Notifications → Support Companion and Focus settings. Server “Connected” only confirms polling.
- **Vault locked:** open Support and unlock Settings → Vault. No service token replacement is necessary.
- **Keychain write failed:** remove the orphan Mac entry in Support, fix Keychain access, and generate another pairing code.
- **Pairing revoked:** disconnect in the companion, generate a fresh code, and pair again.
- **Update:** quit the companion from its menu bar before rerunning `bash install.sh`. It builds and verifies the replacement before touching the installed app.
- **Uninstall:** turn off Launch at login, disconnect, quit, remove the device in Support, then remove `~/Applications/Support Companion.app`.

## Verification boundary

The backend pairing, scope, privacy, queue, lock and retry behavior is covered by repository tests. The native app needs a macOS build and an end-to-end notification check; Linux cannot compile AppKit or validate OS permissions, login launch, Keychain prompts or notification delivery. Perform those checks on the intended Mac before rollout.


Before rollout on a Mac, verify: (1) installation and notification permission, (2) pairing and a test banner, (3) clicking the banner opens the correct page, (4) locking and unlocking the Vault pauses and resumes delivery, (5) sleeping/restarting the VM reconnects without duplicate banners, (6) Remove Mac immediately blocks delivery, and (7) Launch at login survives a Mac sign-out/sign-in. Also verify that an occupied local port and an unknown SSH host key fail without pairing.

Apple API references: [local notifications](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app), [notification permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications), [login items](https://developer.apple.com/documentation/servicemanagement/smappservice), and [loopback ATS exceptions](https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSAppTransportSecurity/NSExceptionDomains).

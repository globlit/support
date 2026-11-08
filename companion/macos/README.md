# Support Companion for macOS

A native menu-bar app for macOS 13 or newer (Apple silicon or Intel). It delivers local notifications for new reviews, blocked work, reopened work and optional completions. Clicking opens the matching ticket or alert in Support. The companion cannot approve plans, run model tools, create tickets or send replies.

## Install on the Mac

After pulling this repository on the Mac, double-click **Build Support.app** in Finder. If Apple Command Line Tools are missing, accept their installation prompt and reopen the builder when finished. The graphical builder compiles an ad-hoc-signed companion and produces a DMG. Open it and drag **Support Companion** onto **Applications**. No terminal commands, Apple membership, Homebrew or Docker are required for this workflow. Users receiving an already built DMG need no compiler or Node installation.

The app is not notarized. Gatekeeper may require the per-app Open Anyway action in Privacy & Security. Do not disable Gatekeeper globally. Rebuilds can require fresh notification or Keychain permission; existing pairing/data are not erased.

The developer source ZIP remains an alternative for maintainers; its `install.sh` is not the normal end-user installation flow. macOS compilation and launch must still be checked on the target Mac; Linux cannot produce a verified native DMG.

## Connect a local service or existing VM

For a service running on the Mac, select **On this Mac · local service**, enter its port and pair with a code from Settings → Notifications.

For an Ubuntu VM, manage it yourself with Vagrant/Tart. Support does not create, boot, resize, provision or delete VMs. Open **VM connection**, choose the host-owned Vagrant project and click **Check provider**. The known provider is **vagrant-tart 1.0.0**. The check reports Tart/Softnet capabilities and opens no tunnel. Select a reviewed host gateway profile for a future verified connection; current unverified Tart activation is refused.

Default Tart NAT and default Softnet networking permit host access. The supplied **Setup guide** explains the required host-side network, folder/device and return-path validation. The browser gateway alone is not guest isolation. Never bypass a rejected VM connection by switching to local mode or a direct SSH TCP forward.

A verified VM connection serves independent host UI assets and bounded JSON, and the companion checks a host-only challenge before pairing, notifications or navigation. It cannot approve plans or authorize workflows.

## Preferences and delivery

Save notification preferences in Support. Review notifications include plan, diff, ticket and reply approvals and intake decisions. Blocked notifications cover workflow failures and unresolved actions. Reopened notifications cover a recorded ticket reopening or a previously completed workflow returning to active work; the VM must first observe that change through its normal source refresh. Completion means the workflow is complete, not merely that a model run finished.

A new installation establishes a baseline rather than notifying for all existing work. Subsequent relevant transitions are recorded every five seconds while a Mac is paired and the Vault is unlocked. Each Mac polls every five seconds, backing off during outages. The app retries unacknowledged delivery and remembers delivered IDs to reduce duplicate banners across reconnects. Queued notifications are discarded when their workflow changes, and eligible for delivery only within your configured retention (maximum 30 days / 500 events). Expired encrypted entries are pruned on the next unlocked check; removing the last Mac clears the outbox immediately. A sleeping or disconnected Mac sees only still-relevant queued updates after reconnecting. No delivery occurs while the Vault is locked.

Private previews are enabled by default. If disabled, notifications may include a constrained ticket reference such as LAB-1; ticket titles, descriptions, comments, results and model output are never included. Delivered notifications belong to macOS Notification Center; changing preferences or locking Support cannot retract previously displayed content. You can clear these in Notification Center.

## Pairing and removal

The device token is stored in the Mac's Keychain. Support stores only its hash. Pairing codes are also stored only as hashes. The VM's outbox and workflow fingerprints are encrypted using the unlocked Vault key. No push provider or Apple push service is involved; notification traffic stays on the local connection or protected host gateway.

**Remove Mac** in Support revokes access immediately. **Disconnect** in the companion removes the local Keychain item and delivered notifications, but does not delete the server-side device; remove it in Support too. At most five Macs can be paired. Paired tokens grant only notification poll/ack access; they do not unlock the Vault or authorize workspace actions. This is not isolation from software already controlling your local OS: Support itself remains a trusted, local application.

## Troubleshooting

- **Host gateway unavailable:** open VM connection and check the provider report, profile and free browser port. A missing host proof must never be bypassed with a direct tunnel.
- **Pairing code expired:** generate another code with the Vault unlocked. A lost response during pairing may leave an offline device entry; remove that entry and pair again.
- **Paired but silent:** send a test with the Vault unlocked, then check System Settings → Notifications → Support Companion and Focus settings. Server “Connected” only confirms polling.
- **Vault locked:** open Support and unlock Settings → Vault. No service token replacement is necessary.
- **Keychain write failed:** remove the orphan Mac entry in Support, fix Keychain access, and generate another pairing code.
- **Pairing revoked:** disconnect in the companion, generate a fresh code, and pair again.
- **Update:** quit the companion from its menu bar before rerunning `bash install.sh`. It builds and verifies the replacement before touching the installed app.
- **Uninstall:** turn off Launch at login, disconnect, quit, remove the device in Support, then remove `~/Applications/Support Companion.app`.

## Verification boundary

The backend pairing, scope, privacy, queue, lock and retry behavior is covered by repository tests. The native app needs a macOS build and an end-to-end notification check; Linux cannot compile AppKit or validate OS permissions, login launch, Keychain prompts or notification delivery. Perform those checks on the intended Mac before rollout.


Before rollout on a Mac, verify: (1) installation and notification permission, (2) pairing and a test banner, (3) clicking the banner opens the correct page, (4) locking and unlocking the Vault pauses and resumes delivery, (5) sleeping/restarting the VM reconnects without duplicate banners, (6) Remove Mac immediately blocks delivery, and (7) Launch at login survives a Mac sign-out/sign-in. Also verify that an occupied local port, missing host proof and failed VM boundary all refuse pairing.

Apple API references: [local notifications](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app), [notification permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications), [login items](https://developer.apple.com/documentation/servicemanagement/smappservice), and [loopback ATS exceptions](https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSAppTransportSecurity/NSExceptionDomains).

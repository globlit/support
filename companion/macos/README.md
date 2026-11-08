# Support Companion for macOS

Show macOS notifications for Support reviews, blocked work, reopened work, and completions. Click a notification to open the ticket. The companion cannot approve work.

## Install

1. Double-click **Build Support.app** in Finder.
2. Open the DMG from `release/` and drag **Support Companion** to **Applications**.
3. If Gatekeeper blocks the app, click **Open Anyway** in **System Settings → Privacy & Security**.

## Connect

- For a server on the Mac, select **On this Mac · local service** and pair with a code from **Settings → Notifications** in Support.
- For a server in a VM, open **VM connection**. See `docs/existing-vm.md`.

Notifications stop while the Vault is locked.

## Troubleshooting

- **Paired but silent:** send a test notification, then check **System Settings → Notifications → Support Companion**.
- **Pairing code expired:** unlock the Vault and generate another code.
- **Pairing revoked:** click **Disconnect** and pair again.
- **Uninstall:** click **Disconnect**, remove the Mac in Support, and move the app to the Trash.

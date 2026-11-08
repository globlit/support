# Existing VM setup — Vagrant Tart

Support no longer creates or manages VMs. The supported development direction is an independently managed Ubuntu VM, with the Mac companion providing a host-owned browser UI and native notifications. The known provider is **vagrant-tart 1.0.0**, provider name **tart**. Keep the existing local service and its data unchanged while testing the companion.

## Install the Mac companion

After pulling the repository on the Mac, double-click **Build Support.app** in Finder. Accept Apple Command Line Tools installation if needed, then reopen it. The graphical builder downloads a pinned standalone Node runtime, builds in an isolated temporary copy, compiles an ad-hoc-signed app, and creates `release/Support-arm64.dmg` or `release/Support-x64.dmg`. Open the DMG and drag the app to Applications. End users receiving this DMG do not install Node or compiler tools and do not run a shell installer.

No Apple membership or dedicated Mac runner is required. Gatekeeper can require the per-app Open Anyway flow in Privacy & Security. No global Gatekeeper changes are made. These files were authored/tested on Linux; native compilation and the actual DMG launch must be checked on the Mac. The Linux environment cannot produce or certify an Apple application binary.

## Point Support at your existing VM

1. Start/manage the VM using your existing Vagrant workflow, independently of Support.
2. Open the companion's **VM connection** window. Choose the **host-owned Vagrant project**, outside all guest-visible paths. **Check provider** reads Vagrant status and plugin/tool versions. Vagrant evaluates the selected Vagrantfile: select only your trusted project.
3. Review detected Tart/Softnet capabilities and the requirements below. A version check does not attest the active VM devices or filtering.
4. A reviewed **host gateway profile** selects the SSH user/key, pinned host keys, VM address, browser port and exact allowed infrastructure destinations. The current profile schema/SSH restrictions are documented in [vm-host-boundary.md](vm-host-boundary.md). **Connect** performs checks before opening anything; the unverified-provider gate remains active.
5. Once a verified provider adapter is available, select **Existing VM · host gateway** in the notification companion, use its browser port, and pair through Settings → Notifications. Do not switch to local-service mode or a raw SSH port forward to bypass a refused VM connection.

**Current boundary:** this delivery supplies the DMG builder, connection UI, read-only Tart diagnostics and guidance. It does not yet authorize a real Tart tunnel: actual host filtering, folder/device controls and return-path behavior must be validated on macOS first. This is intentional enforcement of the requirement that the guest cannot reach the Mac, not a missing service token. A `verified: true` flag or successful guest self-test cannot bypass it. Local-service notifications remain usable.

## What vagrant-tart 1.0.0 supports

The versioned provider source exposes `extra_run_args`, `volumes`, `clipboard`, `gui`, `audio`, CPU and memory settings. Its driver forwards `extra_run_args` directly to `tart run`, and turns volumes into `--dir` arguments. This permits host-owned network settings, but does not make any particular settings safe by itself.

For your **existing** Vagrantfile, the shape is:

```ruby
require_relative "support-boundary"
Vagrant.configure("2") do |config|
  # Retain your existing reviewed Ubuntu image/name and provisioning.
  SupportBoundary.configure(config)
  config.vm.provider "tart" do |tart|
    tart.gui = false
    tart.audio = false
    tart.clipboard = false
    tart.volumes = []
    # extra_run_args must be reviewed for the installed Tart/Softnet release.
    # Never enable an AI workload using only default NAT or --net-softnet.
  end
end
```

Use the supplied `deployment/vagrant/support-boundary.rb` guard. It checks the final Vagrant config for enabled synced folders, agent forwarding, bridged networking and forwarded ports. For Tart it also checks provider volumes, clipboard and known bypass flags. It does not configure a safe network or certify runtime isolation. Do not overwrite your actual Vagrantfile with the excerpt; retain provider-specific image/name and credentials. No image is silently downloaded or VM created by Support.

Keep Vagrant state, its keys and the Support host application/configuration outside every guest path. Remove `/vagrant`, `~/claude_access` and other live shared folders for the strict profile, including read-only shares: a read-only share still exposes host files. Clone repositories inside Ubuntu. Use an independent input disk only when deliberately needed; never mount a Mac block device, Docker socket, SSH agent, Rosetta share, USB device or browser-control channel.

## Tart validation on the Mac

Tart defaults to shared NAT. Softnet defaults also permit the vmnet gateway, which belongs to the Mac. Merely adding `--net-softnet`, using a private IP, disabling clipboard or adding a guest firewall does not meet the boundary requirement.

Before enabling the provider adapter:

- Check the **actual Tart and Softnet versions**, not just the Vagrant plugin version. Confirm the running Tart command and Softnet child, their executable provenance, and their final arguments. Reject network bridges, host networking, alternate `--net-fd`, exposed TCP ports, VNC, directory/Rosetta shares and unknown additional devices.
- Require default-deny egress with reviewed service IPs/protocols/ports. Deny guest-initiated access to the vmnet gateway **and every Mac LAN/VPN/loopback/link-local/IPv6 address**, including address changes after VPN/sleep transitions. An approved remote endpoint must not be a proxy back to the Mac.
- Verify how the installed Softnet version handles **host-initiated SSH and its return packets**. Newer upstream code advertises directional rules such as `in proto tcp @host port 22`; do not assume an older binary understands them or solves other host-interface filtering. A broad allow for the Mac/gateway to make SSH work would defeat isolation. `@host` alone refers to the vmnet gateway, not all Mac interfaces.
- Document unavoidable DHCP/DNS handling in that exact version. Do not claim these controls are equivalent to a VM with no network card. Generic PF rules are not enough unless native packet traversal has been demonstrated.
- Run guest-root probes to actual host services and unrelated LAN addresses while observing host-side counters/traffic. Check IPv4, IPv6, spoofing, reconnects, changed policy, sleep/wake and VPN changes. Then verify only approved service connections and the host-initiated SSH session work. Do not use real infrastructure secrets in these probes.
- Kill the gateway and test that guest-to-Mac denial persists independently. Attempts to serve HTML, redirects or executable content through the API must remain blocked by the host UI gateway.

Until those checks are implemented in a concrete runtime adapter and verified on the intended Mac, the connection stays refused. This avoids turning the previously unsafe generic PF assumption into a false Tart security guarantee.

## Ubuntu-side application

Install/run Support inside the existing Ubuntu VM with the repository's current Node 24+ workflow. Keep the listener at `127.0.0.1:4173`. The host gateway forwards via a private Unix socket, never a browser-facing raw TCP tunnel. Bind Docker publishing to guest loopback if you package the service in a container. Keep the Vault directory and repository workspace inside the guest; do not use a host shared mount for either.

No app-level configuration, tokens, Vault keys, existing plans or approvals are migrated or reset by the Mac installer. The native app's local-service mode continues to work with the existing setup. An existing insecure raw tunnel is not made secure merely by installing this companion.

## Primary references

- [vagrant-tart 1.0.0 configuration](https://github.com/letiemble/vagrant-tart/blob/v1.0.0/lib/vagrant-tart/config.rb) and [driver](https://github.com/letiemble/vagrant-tart/blob/v1.0.0/lib/vagrant-tart/util/driver.rb).
- [Tart run options](https://github.com/cirruslabs/tart/blob/main/Sources/tart/Commands/Run.swift).
- [Softnet networking and default gateway access](https://github.com/cirruslabs/softnet), [directional rule syntax in current source](https://github.com/cirruslabs/softnet/blob/main/src/main.rs).
- [Apple's per-app Gatekeeper opening guidance](https://support.apple.com/en-us/102445).

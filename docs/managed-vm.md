# Managed VM proposal retired

On 2026-11-08 the user chose to keep VM lifecycle outside Support. The native VM controller, creation/import UI and virtualization entitlement have been removed from the companion build. No Ubuntu image is downloaded or bundled by the Mac installer.

Use [existing VM setup with vagrant-tart](existing-vm.md). The reusable guest service recipes and broker tests remain development components; they do not imply that the app creates a VM or that an existing Tart VM has a verified host boundary.

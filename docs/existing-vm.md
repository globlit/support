# VM connection

Open Support from the Mac when it runs in a Tart VM managed by `vagrant-tart` 1.0.0. Support does not create, start, or stop VMs.

## Prerequisites

- Support running in the VM. See the [service guide](service.md).
- `tart.gui = false` and `tart.audio = false` in the `Vagrantfile`.
- The Vagrant project folder outside every folder shared with the VM.
- macOS 13 or newer with Apple Command Line Tools.

## Install the Mac app

1. Double-click **Build Support.app** in Finder.
2. Open `release/Support-<arch>.dmg` and drag **Support Companion** to **Applications**.
3. If Gatekeeper blocks the app, click **Open Anyway** in **System Settings → Privacy & Security**.

## Connect

1. In **Support Companion**, open **VM connection**.
2. Click **Choose folder…** and select the folder that contains the `Vagrantfile`.
3. Optional: select one folder under **Shared repositories**.
4. If **Running VM shares** lists other shares, approve them or remove them from the `Vagrantfile`.
5. Select the VM.
6. Compare the fingerprint in the app with this command's output in the VM:

   ```shell
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
   ```

7. If they match, click **Fingerprints match · Trust this VM**, then **Connect** and **Open Support**.

If a check fails, click **What to do**, apply the change, and click **Recheck**.

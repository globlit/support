import AppKit
import SwiftUI
import Virtualization
import Darwin

@MainActor final class ManagedVMModel: NSObject, ObservableObject, VZVirtualMachineDelegate {
    @Published var status = "Import a Linux runtime to create your managed VM."
    @Published var busy = false
    @Published var active = false
    @Published var installed = FileManager.default.fileExists(atPath: ManagedFiles.vm.appendingPathComponent("manifest.json").path)
    @Published var preferences = ManagedPreferences()
    @Published var network = ManagedNetworkPolicy()
    private var vm: VZVirtualMachine?
    private var process: Process?
    private var control: Pipe?
    private var output: Pipe?
    private var hostReady = false
    private var lease: Timer?
    private var run: URL?
    private var lockFD: Int32 = -1
    private var api: ManagedAPIListener?
    private var relays: ManagedRelays?
    private var egress: ManagedEgressListener?
    private var listener: VZVirtioSocketListener?
    private var runningLease = false
    override init() {
        super.init()
        if let data = try? Data(contentsOf: ManagedFiles.root.appendingPathComponent("managed-preferences.json")), let value = try? JSONDecoder().decode(ManagedPreferences.self, from: data) { preferences = value }
        if let data = try? Data(contentsOf: ManagedFiles.root.appendingPathComponent("managed-network.json")), let value = try? JSONDecoder().decode(ManagedNetworkPolicy.self, from: data) { network = value }
        if installed { status = "Stopped · guest disk preserved" }
    }
    func openUI() {
        guard active, runningLease, process?.isRunning == true,
              let url = URL(string: "http://127.0.0.1:\(preferences.port)/") else { return }
        NSWorkspace.shared.open(url)
    }
    func importRuntime() {
        guard !active, !busy else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false; panel.prompt = "Import runtime"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        busy = true; status = "Copying and verifying the Linux runtime…"
        Task {
            defer { busy = false }
            do { try await Task.detached(priority: .utility) { try ManagedFiles.importImage(url) }.value; installed = true; status = "Runtime imported · ready to configure access" }
            catch { status = error.localizedDescription }
        }
    }
    func importInput() {
        guard installed, !active, !busy else { return }
        let panel = NSOpenPanel(); panel.allowedFileTypes = ["iso"]; panel.allowsMultipleSelection = false; panel.prompt = "Copy input disk"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        busy = true
        Task { defer { busy = false }; do { try await Task.detached(priority: .utility) { try ManagedFiles.importInput(url) }.value; status = "Independent input disk copied · attached read-only at next start" } catch { status = error.localizedDescription } }
    }
    private func configuration() throws -> VZVirtualMachineConfiguration {
        let p = preferences
        guard (1...4).contains(p.cpu), [2048, 3072, 4096].contains(p.memoryMiB), (1024...65535).contains(p.port),
              UInt64(p.memoryMiB + 2048) * 1024 * 1024 <= ProcessInfo.processInfo.physicalMemory else { throw CompanionError(message: "Choose 1–4 CPUs and 2–4 GiB RAM, leaving at least 2 GiB for the Mac.") }
        let config = VZVirtualMachineConfiguration()
        config.cpuCount = p.cpu; config.memorySize = UInt64(p.memoryMiB) * 1024 * 1024
        let boot = VZLinuxBootLoader(kernelURL: ManagedFiles.vm.appendingPathComponent("vmlinuz"))
        boot.initialRamdiskURL = ManagedFiles.vm.appendingPathComponent("initrd")
        boot.commandLine = "console=hvc0 root=/dev/vda rw quiet"
        config.bootLoader = boot
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        // Non-negotiable boundary: no NIC/NAT/bridge, live shares, clipboard, USB or host directory device.
        config.networkDevices = []
        config.directorySharingDevices = []
        config.serialPorts = []
        let disk = try VZDiskImageStorageDeviceAttachment(url: ManagedFiles.vm.appendingPathComponent("rootfs.raw"), readOnly: false)
        var disks: [VZStorageDeviceConfiguration] = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
        let input = ManagedFiles.vm.appendingPathComponent("inputs.iso")
        if FileManager.default.fileExists(atPath: input.path) { disks.append(VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: input, readOnly: true))) }
        config.storageDevices = disks
        try config.validate()
        return config
    }
    func start() async {
        guard installed, !active, !busy else { return }
        busy = true; defer { busy = false }; status = "Verifying managed runtime…"
        do {
            umask(0o077); try ManagedFiles.directory(ManagedFiles.root)
            lockFD = Darwin.open(ManagedFiles.root.appendingPathComponent("managed.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw CompanionError(message: "This managed VM is already open in another app instance.") }
            try await Task.detached(priority: .utility) { try ManagedFiles.verifyBoot() }.value
            let config = try configuration()
            try ManagedFiles.save(preferences, name: "managed-preferences.json"); try ManagedFiles.save(network, name: "managed-network.json")
            guard let resources = Bundle.main.resourceURL else { throw CompanionError(message: "Managed runtime resources are missing.") }
            let node = resources.appendingPathComponent("Runtime/node"), script = resources.appendingPathComponent("Host/host/managed-service.js")
            guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: script.path) else { throw CompanionError(message: "This build does not include the managed host runtime. Local-service mode is still available.") }
            let run = ManagedFiles.root.appendingPathComponent("run-" + String(UUID().uuidString.prefix(8)), isDirectory: true); try ManagedFiles.directory(run); self.run = run
            let child = Process(), input = Pipe(), out = Pipe(); process = child; control = input; output = out; hostReady = false; runningLease = false
            child.executableURL = node; child.arguments = ["--max-old-space-size=192", script.path, run.path, String(preferences.port)]
            child.environment = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory(), "LANG": "C"]
            child.standardInput = input; child.standardOutput = out; child.standardError = FileHandle.nullDevice
            var readiness = ""
            out.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                Task { @MainActor in
                    guard let self, self.process === child else { return }
                    readiness = String((readiness + String(decoding: data, as: UTF8.self)).suffix(512))
                    if readiness.contains("SUPPORT_MANAGED_READY_V1\n") { self.hostReady = true }
                }
            }
            child.terminationHandler = { [weak self] _ in Task { @MainActor in
                guard let self, self.process === child else { return }
                self.status = "Host boundary stopped · VM access closed"
                self.stopBoundary()
                if let vm = self.vm, vm.canRequestStop { do { try vm.requestStop() } catch { self.status = "Boundary closed. Use Force stop to stop the guest." } }
                else { self.finished() }
            } }
            try child.run()
            lease = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in
                guard let self else { return }
                do { try self.control?.fileHandleForWriting.write(contentsOf: Data((self.runningLease ? "RUNNING\n" : "BOOTING\n").utf8)) }
                catch { self.stop(force: true) }
            } }
            for _ in 0..<100 { if hostReady { break }; if !child.isRunning { throw CompanionError(message: "Host policy or gateway startup failed. No VM network was enabled.") }; try await Task.sleep(nanoseconds: 100_000_000) }
            guard hostReady else { throw CompanionError(message: "Host gateway did not become ready.") }
            let vm = VZVirtualMachine(configuration: config); self.vm = vm; vm.delegate = self
            guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else { throw CompanionError(message: "Virtual socket device is unavailable.") }
            let relays = ManagedRelays(); self.relays = relays
            let egress = ManagedEgressListener(path: run.appendingPathComponent("egress.sock").path, relays: relays); self.egress = egress
            let listener = VZVirtioSocketListener(); listener.delegate = egress; self.listener = listener
            device.setSocketListener(listener, forPort: 4174)
            api = try ManagedAPIListener(path: run.appendingPathComponent("api.sock").path, device: device, relays: relays)
            active = true; status = "Booting Linux · no network card or shared folders"
            try await vm.start(); guard self.vm === vm, child.isRunning else { throw CompanionError(message: "Host boundary stopped during boot.") }; runningLease = true
            // No auto-unlock, migration, approvals or external writes on boot.
            status = "Running · Linux is starting Support at http://127.0.0.1:\(preferences.port)"
        } catch { status = error.localizedDescription; stopBoundary(); finished() }
    }
    private func stopBoundary() {
        runningLease = false; lease?.invalidate(); lease = nil
        api?.stop(); api = nil; relays?.stop(); relays = nil
        try? control?.fileHandleForWriting.close(); control = nil
        output?.fileHandleForReading.readabilityHandler = nil; output = nil
        process?.terminationHandler = nil; if process?.isRunning == true { process?.terminate() }; process = nil
    }
    private func finished() {
        if let vm, vm.state != .stopped && vm.state != .error { active = true; status = "VM is still active with its boundary closed. Stop it before restarting."; return }
        active = false; stopBoundary(); vm = nil; egress = nil; listener = nil
        // Only this run's transient sockets are removed. The VM disk and Vault remain intact.
        if let run { try? FileManager.default.removeItem(at: run) }; run = nil
        if lockFD >= 0 { _ = flock(lockFD, LOCK_UN); Darwin.close(lockFD); lockFD = -1 }
    }
    func stop(force: Bool = false) {
        guard let vm else { return }
        stopBoundary()
        if force, vm.canStop { vm.stop { [weak self] error in Task { @MainActor in
            guard let self else { return }; if let error { self.status = error.localizedDescription } else { self.finished(); self.status = "Stopped · guest disk preserved" }
        } } }
        else { do { try vm.requestStop(); status = "Stopping Linux… Force stop only if it cannot shut down." } catch { status = "Graceful stop failed. Use Force stop if the guest is stuck." } }
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { guard vm === virtualMachine else { return }; finished(); status = "Stopped · guest disk preserved" }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { guard vm === virtualMachine else { return }; finished(); status = "VM stopped: \(error.localizedDescription)" }
}

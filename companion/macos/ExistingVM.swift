import AppKit
import SwiftUI

private final class ConnectionOutput {
    private let lock = NSLock()
    private var value = ""
    func append(_ data: Data) -> String {
        lock.lock(); defer { lock.unlock() }
        value = String((value + String(decoding: data, as: UTF8.self)).suffix(12000))
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

@MainActor final class ExistingVMConnection: ObservableObject {
    static let shared = ExistingVMConnection()
    @Published var project = UserDefaults.standard.string(forKey: "vagrantProject") ?? ""
    @Published var profile = UserDefaults.standard.string(forKey: "hostProfile") ?? ""
    @Published var status = "Choose your existing Vagrant project to inspect its provider. Support never creates or provisions a VM."
    @Published var working = false
    @Published var running = false
    private var child: Process?
    private var pipe: Pipe?
    func choose(project: Bool) {
        guard !working, !running else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = project; panel.canChooseFiles = !project; panel.allowsMultipleSelection = false
        panel.message = project ? "Choose your host-owned Vagrant project, outside every guest share. Inspection evaluates its Vagrantfile." : "Choose a private host gateway profile prepared for your VM."
        guard panel.runModal() == .OK, let path = panel.url?.path else { return }
        if project { self.project = path; UserDefaults.standard.set(path, forKey: "vagrantProject") }
        else { profile = path; UserDefaults.standard.set(path, forKey: "hostProfile") }
    }
    func run(check: Bool) {
        guard !working, !running, let resources = Bundle.main.resourceURL else { return }
        let path = check ? project : profile
        guard !path.isEmpty else { status = check ? "Select your Vagrant folder first." : "Select a reviewed host gateway profile first."; return }
        let node = resources.appendingPathComponent("Runtime/node"), script = resources.appendingPathComponent("Host/host/main.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: script.path) else { status = "Use the DMG build for VM connection tools. This source-only companion can still connect to an already running gateway."; return }
        let process = Process(), output = Pipe(); child = process; pipe = output; working = true
        status = check ? "Checking Vagrant provider…" : "Checking the host boundary before connecting…"
        process.executableURL = node; process.arguments = ["--max-old-space-size=192", script.path, check ? "inspect-vagrant" : "serve", path]
        process.environment = ["PATH": "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", "HOME": NSHomeDirectory(), "LANG": "C"]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = output; process.standardError = output
        let capture = ConnectionOutput()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            let text = capture.append(data)
            Task { @MainActor in
                guard let self, self.child === process else { return }
                self.status = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !check && text.contains("Host-served Support UI:") { self.running = true; self.working = false }
            }
        }
        process.terminationHandler = { [weak self] task in
            output.fileHandleForReading.readabilityHandler = nil
            let text = capture.append(output.fileHandleForReading.readDataToEndOfFile())
            Task { @MainActor in
            guard let self, self.child === task else { return }
            self.working = false; self.running = false
            // Keep output readable; revocation never stops or changes the user's VM.
            self.status = text.isEmpty ? (task.terminationStatus == 0 ? "Check completed." : "Connection check failed.") : text
        } }
        do { try process.run() } catch { working = false; status = error.localizedDescription }
    }
    func stop() {
        child?.terminationHandler = nil; pipe?.fileHandleForReading.readabilityHandler = nil
        if child?.isRunning == true { child?.terminate() }
        child = nil; pipe = nil; running = false; working = false
    }
    func guide() {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("Host/public/downloads/existing-vm-guide.html"), FileManager.default.fileExists(atPath: url.path) else { status = "The full DMG includes the existing VM guide."; return }
        NSWorkspace.shared.open(url)
    }
}

@MainActor struct ExistingVMView: View {
    @ObservedObject private var model = ExistingVMConnection.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Connect an existing VM").font(.title2.bold())
            Text("You own its lifecycle in Vagrant/Tart. Support opens only the protected browser and notification connection.").foregroundStyle(.secondary)
            HStack { Text("Vagrant project"); Spacer(); Button("Choose folder…") { model.choose(project: true) } }.disabled(model.working || model.running)
            Text(model.project.isEmpty ? "No folder selected" : model.project).font(.caption).textSelection(.enabled).lineLimit(2)
            HStack { Button("Check provider") { model.run(check: true) }.disabled(model.project.isEmpty || model.working || model.running); Button("Setup guide") { model.guide() } }
            Divider()
            HStack { Text("Host gateway profile"); Spacer(); Button("Choose file…") { model.choose(project: false) } }.disabled(model.working || model.running)
            Text(model.profile.isEmpty ? "No profile selected" : model.profile).font(.caption).textSelection(.enabled).lineLimit(2)
            HStack {
                Button("Connect") { model.run(check: false) }.buttonStyle(.borderedProminent).disabled(model.profile.isEmpty || model.working || model.running)
                if model.running { Button("Disconnect") { model.stop() } }
                if model.working { ProgressView().controlSize(.small) }
            }
            ScrollView { Text(model.status).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 180)
            Text("Tart’s default NAT or default Softnet mode is not sufficient host isolation. An unverified boundary is refused; there is no direct-tunnel fallback.").font(.caption).foregroundStyle(.secondary)
        }.padding(24).frame(width: 560)
    }
}

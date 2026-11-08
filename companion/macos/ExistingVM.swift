import AppKit
import SwiftUI

fileprivate struct VMMachine: Decodable, Identifiable {
    let name: String; let provider: String; let state: String
    var id: String { name }
}
fileprivate struct VMCheck: Decodable, Identifiable {
    let id: String; let title: String; let state: String; let detail: String
    let help: String?; let copy: String?
}
private struct VMReport: Decodable {
    let machines: [VMMachine]; let machine: String?; let checks: [VMCheck]; let ready: Bool
    let fingerprint: String?; let url: String?
}
private final class ConnectionOutput {
    private let lock = NSLock()
    private var value = Data()
    func append(_ data: Data) -> Data {
        lock.lock(); defer { lock.unlock() }
        value.append(data)
        if value.count > 524288 { value = Data(value.suffix(262144)) }
        return value
    }
}

@MainActor final class ExistingVMConnection: ObservableObject {
    static let shared = ExistingVMConnection()
    @Published var project = UserDefaults.standard.string(forKey: "vagrantProject") ?? ""
    @Published fileprivate var machines: [VMMachine] = []
    @Published fileprivate var checks: [VMCheck] = []
    @Published var machine = ""
    @Published var status = "Choose the folder containing your Vagrantfile."
    @Published var working = false
    @Published var running = false
    @Published var ready = false
    @Published var fingerprint: String?
    @Published var url: URL?
    @Published var browserPort = UserDefaults.standard.string(forKey: "vmBrowserPort") ?? "4173"
    @Published var repositories = UserDefaults.standard.string(forKey: "vagrantRepositories") ?? ""
    private var child: Process?
    private var pipe: Pipe?
    private var request: Pipe?
    private var generation = UUID()
    func choose() {
        guard !working, !running else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.message = "Choose a host-owned Vagrant project outside VM shares. Vagrant evaluates its configuration on your Mac."
        guard panel.runModal() == .OK, let path = panel.url?.path else { return }
        project = path; UserDefaults.standard.set(path, forKey: "vagrantProject")
        machine = ""; machines = []; run("vm-discover")
    }
    func chooseRepositories() {
        guard !working, !running else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.message = "Choose the one repositories folder the VM may read and write. Keep Vagrant configuration, SSH keys and the Mac app outside it."
        guard panel.runModal() == .OK, let path = panel.url?.path else { return }
        repositories = path; UserDefaults.standard.set(path, forKey: "vagrantRepositories")
        if !project.isEmpty { run("vm-discover") }
    }
    func removeRepositories() {
        guard !working, !running else { return }
        repositories = ""; UserDefaults.standard.removeObject(forKey: "vagrantRepositories"); ready = false; checks = []
        status = "Repository sharing removed from this connection. Recheck the VM."
    }
    func select(_ name: String) {
        guard !working, !running else { return }
        machine = name; run("vm-check")
    }
    func run(_ command: String) {
        guard !working, !running, !project.isEmpty, let resources = Bundle.main.resourceURL else { return }
        guard let port = Int(browserPort), (1024...65535).contains(port) else { status = "Choose a browser port between 1024 and 65535."; return }
        let node = resources.appendingPathComponent("Runtime/node"), script = resources.appendingPathComponent("Host/host/main.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: script.path), FileManager.default.isExecutableFile(atPath: resources.appendingPathComponent("Runtime/inspect-processes").path) else { status = "Install the full DMG build to use VM connection checks."; return }
        var selection: [String: Any] = ["project": project, "port": port]
        if !repositories.isEmpty { selection["repositories"] = repositories }
        if command != "vm-discover" { selection["machine"] = machine }
        if command == "vm-trust", let fingerprint { selection["fingerprint"] = fingerprint }
        guard let data = try? JSONSerialization.data(withJSONObject: selection) else { return }
        generation = UUID(); let ticket = generation
        checks = []; ready = false; fingerprint = nil; url = nil; working = true
        status = command == "vm-discover" ? "Finding Vagrant VMs…" : "Checking the selected VM…"
        let process = Process(), output = Pipe(), input = Pipe(); child = process; pipe = output; request = input
        process.executableURL = node; process.arguments = ["--max-old-space-size=192", script.path, command]
        process.environment = ["PATH": "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", "HOME": NSHomeDirectory(), "LANG": "C"]
        process.standardInput = input; process.standardOutput = output
        // Structured host-generated results only. No Vagrant/SSH stderr or guest output in the UI.
        process.standardError = FileHandle.nullDevice
        let capture = ConnectionOutput()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let all = capture.append(handle.availableData)
            Task { @MainActor in
                guard let self, self.generation == ticket else { return }
                self.receive(all)
            }
        }
        process.terminationHandler = { [weak self] task in
            output.fileHandleForReading.readabilityHandler = nil
            let all = capture.append(output.fileHandleForReading.readDataToEndOfFile())
            Task { @MainActor in
                guard let self, self.generation == ticket else { return }
                self.receive(all); self.working = false; self.running = false; self.url = nil
                if command == "vm-connect" { self.ready = false; if task.terminationStatus == 0 { self.status = "Disconnected. Recheck to connect again." } }
                if task.terminationStatus != 0 { self.ready = false; self.status = "The connection check could not finish. Recheck, or rebuild the app if its bundled tools are missing." }
                self.child = nil; self.pipe = nil; self.request = nil
                if command == "vm-discover" {
                    if !self.machines.contains(where: { $0.name == self.machine }) { self.machine = "" }
                    let available = self.machines.filter { $0.state == "running" && $0.provider == "tart" }
                    if available.count == 1, self.checks.allSatisfy({ $0.state == "passed" }) {
                        self.machine = available[0].name; self.run("vm-check")
                    } else if !self.machines.isEmpty { self.status = "Select the running VM you want to use." }
                }
            }
        }
        do { try process.run(); input.fileHandleForWriting.write(data); try input.fileHandleForWriting.close() }
        catch { working = false; ready = false; status = "Could not start the bundled connection tools." }
    }
    private func receive(_ data: Data) {
        // Ignore incomplete final lines; termination drains and replays the last complete report.
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        guard let report = lines.reversed().compactMap({ try? JSONDecoder().decode(VMReport.self, from: Data($0.utf8)) }).first else { return }
        machines = report.machines; checks = report.checks; ready = report.ready; fingerprint = report.fingerprint
        if let value = report.url, let candidate = URL(string: value), candidate.host == "127.0.0.1", candidate.scheme == "http" {
            url = candidate; running = true; working = false; status = "Connected. Open Support in your browser."
            UserDefaults.standard.set(String(candidate.port ?? 4173), forKey: "vmBrowserPort")
            AppDelegate.model?.useUnpairedVMPort(candidate.port ?? 4173)
        } else { running = false; url = nil; status = report.ready ? "Ready to connect." : (checks.first(where: { $0.state == "action" }) != nil ? "Complete the highlighted step, then Recheck." : "Checking…") }
    }
    func stop() {
        generation = UUID()
        // Drain discarded output until shutdown so the Node owner can close SSH cleanly.
        if let process = child, let output = pipe, process.isRunning {
            output.fileHandleForReading.readabilityHandler = { handle in
                if handle.availableData.isEmpty { handle.readabilityHandler = nil }
            }
            process.terminationHandler = { _ in output.fileHandleForReading.readabilityHandler = nil }
            process.terminate()
        }
        child = nil; pipe = nil; request = nil; running = false; working = false; ready = false; url = nil; fingerprint = nil
        status = "Disconnected. Your VM is still running."
    }
    func open() { if let url { NSWorkspace.shared.open(url) } }
    func copy(_ text: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
}

@MainActor struct ExistingVMView: View {
    @ObservedObject private var model = ExistingVMConnection.shared
    @State private var expanded: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect your VM").font(.title2.bold())
            Text("Select your existing VM. Support discovers the connection and checks what is ready.").foregroundStyle(.secondary)
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Vagrant project").font(.headline)
                    Text(model.project.isEmpty ? "No folder selected" : model.project).font(.caption).lineLimit(2).textSelection(.enabled)
                }
                Spacer()
                Button("Choose folder…") { model.choose() }.disabled(model.working || model.running)
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Shared repositories").font(.headline); Text("Optional").font(.caption).foregroundStyle(.secondary); Spacer()
                    Button("Choose folder…") { model.chooseRepositories() }
                    if !model.repositories.isEmpty { Button { model.removeRepositories() } label: { Image(systemName: "xmark") }.help("Remove shared folder selection") }
                }
                if !model.repositories.isEmpty {
                    Text(model.repositories).font(.caption).textSelection(.enabled).lineLimit(2)
                    Text("Read/write exception, including Git metadata. Keep host configuration outside this folder.").font(.caption).foregroundStyle(.secondary)
                }
            }.disabled(model.working || model.running)
            if !model.project.isEmpty {
                HStack {
                    Picker("VM", selection: Binding(get: { model.machine }, set: { model.select($0) })) {
                        Text("Select a VM").tag("")
                        ForEach(model.machines) { vm in Text("\(vm.name) · \(vm.state) · \(vm.provider)").tag(vm.name) }
                    }.disabled(model.working || model.running)
                    Button { model.run("vm-discover") } label: { Image(systemName: "arrow.clockwise") }
                        .help("Refresh VMs").disabled(model.working || model.running)
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(model.checks) { check in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: check.state == "passed" ? "checkmark.circle.fill" : check.state == "action" ? "exclamationmark.circle" : "circle")
                                .foregroundStyle(check.state == "passed" ? Color.green : check.state == "action" ? Color.orange : Color.secondary)
                            VStack(alignment: .leading, spacing: 7) {
                                Text(check.title).font(.headline)
                                Text(check.detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                if let help = check.help {
                                    Button(expanded == check.id ? "Hide steps" : "What to do") { expanded = expanded == check.id ? nil : check.id }.buttonStyle(.link)
                                    if expanded == check.id {
                                        Text(help).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                        if let text = check.copy {
                                            ScrollView([.vertical, .horizontal]) { Text(text).font(.system(.caption, design: .monospaced)).textSelection(.enabled).padding(10) }.frame(maxHeight: 130).background(Color.secondary.opacity(0.08)).cornerRadius(6)
                                            Button("Copy commands") { model.copy(text) }
                                        }
                                    }
                                }
                                if check.id == "identity", model.fingerprint != nil {
                                    Button("Fingerprints match · Trust this VM") { model.run("vm-trust") }.disabled(model.working)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }.padding(.vertical, 10)
            }.frame(minHeight: 130, maxHeight: 310)
            Divider()
            HStack {
                if model.working { ProgressView().controlSize(.small); Text(model.status).font(.caption); Spacer(); Button("Cancel") { model.stop() } }
                else if model.running {
                    Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green); Spacer()
                    Button("Disconnect") { model.stop() }; Button("Open Support") { model.open() }.buttonStyle(.borderedProminent)
                } else {
                    Text(model.status).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true); Spacer()
                    if !model.machine.isEmpty { Button("Recheck") { model.run("vm-check") } }
                    Button("Connect") { model.run("vm-connect") }.buttonStyle(.borderedProminent).disabled(!model.ready)
                }
            }
            if !model.machine.isEmpty && !model.running {
                HStack { Text("Browser port").font(.caption); TextField("4173", text: $model.browserPort).frame(width: 70); Text("Change if another local app uses 4173.").font(.caption).foregroundStyle(.secondary) }.disabled(model.working)
            }
        }.padding(24).frame(width: 610).textFieldStyle(.roundedBorder)
    }
}

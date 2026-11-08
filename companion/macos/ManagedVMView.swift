import SwiftUI
import AppKit

@MainActor struct ManagedVMView: View {
    @ObservedObject var model: ManagedVMModel
    @State private var confirmForce = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Managed VM").font(.title2.bold())
                Text(model.status).foregroundStyle(.secondary).textSelection(.enabled)
                HStack(spacing: 12) {
                    if !model.installed { Button("Import Linux runtime…") { model.importRuntime() }.buttonStyle(.borderedProminent) }
                    else if !model.active { Button("Start VM") { Task { await model.start() } }.buttonStyle(.borderedProminent) }
                    else {
                        Button("Open Support") { model.openUI() }.buttonStyle(.borderedProminent)
                        Button("Stop VM") { model.stop() }
                        Button("Force stop…", role: .destructive) { confirmForce = true }
                    }
                }.disabled(model.busy)
                Text("No network card. No live Mac folders. The browser receives the host UI; the guest supplies data only.").font(.callout)
                Divider()
                Group {
                    Stepper("CPUs: \(model.preferences.cpu)", value: $model.preferences.cpu, in: 1...4)
                    Picker("Memory", selection: $model.preferences.memoryMiB) { Text("2 GiB").tag(2048); Text("3 GiB").tag(3072); Text("4 GiB").tag(4096) }
                    TextField("Browser port", value: $model.preferences.port, format: .number)
                    if model.installed { Button("Copy read-only input disk…") { model.importInput() } }
                    Text("Working files live on the guest disk. Import a prepared ISO for selected inputs; your original folder is never mounted.").font(.caption).foregroundStyle(.secondary)
                }.disabled(model.active || model.busy)
                Divider()
                HStack { Text("Allowed infrastructure").font(.headline); Spacer(); Button("Add destination") { model.network.endpoints.append(ManagedEndpoint()) }.disabled(model.active || model.busy || model.network.endpoints.count >= 128) }
                Text("Start with no access. Each grant names an exact service hostname, pinned IPv4 and port. Mac addresses are always denied. These settings stay on the Mac and cannot be changed by the agent.").font(.caption).foregroundStyle(.secondary)
                ForEach($model.network.endpoints) { $entry in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { TextField("Service hostname", text: $entry.host); TextField("Pinned IPv4", text: $entry.address); TextField("Port", value: $entry.port, format: .number).frame(width: 70) }
                        HStack { Toggle("Allow this private infrastructure IP", isOn: $entry.allowPrivate); Spacer(); Button("Remove", role: .destructive) { model.network.endpoints.removeAll { $0.id == entry.id } } }
                    }.disabled(model.active || model.busy)
                    Divider()
                }
                Text("Changes apply on the next start. Existing Vault data and approvals are kept on the guest disk. Stop the VM before quitting Support.").font(.caption).foregroundStyle(.secondary)
            }.padding(24)
        }.frame(width: 650, height: 600).textFieldStyle(.roundedBorder)
        .alert("Force stop the VM?", isPresented: $confirmForce) {
            Button("Cancel", role: .cancel) { }
            Button("Force stop", role: .destructive) { model.stop(force: true) }
        } message: { Text("Linux cannot finish pending writes. Use Stop VM first; an interrupted write may require recovery.") }
    }
}

import AppKit
import SwiftUI
import UserNotifications
import Security
import ServiceManagement
import CryptoKit
import Darwin

struct Pair: Codable { let id: String; let token: String }
struct Notice: Decodable { let id: String; let title: String; let body: String; let route: String }
struct Inbox: Decodable { let paused: Bool; let reason: String?; let events: [Notice] }
struct APIError: Decodable { let error: String }
struct CompanionError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum Keychain {
    static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "ing.support.companion", kSecAttrAccount as String: "pairing"]
    static func load() throws -> Pair? {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw CompanionError(message: "Unlock your Mac Keychain to reconnect.")
        }
        return try JSONDecoder().decode(Pair.self, from: data)
    }
    static func save(_ pair: Pair) throws {
        let data = try JSONEncoder().encode(pair)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw CompanionError(message: "Could not update the Mac Keychain.") }
        var q = query; q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else {
            throw CompanionError(message: "Could not save the pairing in the Mac Keychain.")
        }
    }
    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CompanionError(message: "Could not remove the pairing from Keychain.")
        }
    }
}

// No redirects, cookies, proxy credentials or browser session are used for delivery.
final class Transport: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor final class Companion: ObservableObject {
    @Published var status = "Not paired"
    @Published var working = false
    @Published var paired = false
    @Published var code = ""
    @Published var port = UserDefaults.standard.string(forKey: "supportPort") ?? "4173"
    @Published var useSSH = UserDefaults.standard.object(forKey: "useSSH") as? Bool ?? true
    @Published var login = SMAppService.mainApp.status == .enabled
    private var pair: Pair?
    private var runner: Task<Void, Never>?
    private var failures = 0
    private var terminalAuthFailure = false
    private var delivered: [String] = []
    private let gate = Transport()
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 10; c.timeoutIntervalForResource = 15
        c.httpCookieStorage = nil; c.urlCredentialStorage = nil; c.urlCache = nil
        c.connectionProxyDictionary = [:]
        return URLSession(configuration: c, delegate: gate, delegateQueue: nil)
    }()
    var base: String { "http://127.0.0.1:\(port)" }
    init() {
        do { pair = try Keychain.load(); paired = pair != nil }
        catch { status = error.localizedDescription }
        if let p = pair {
            delivered = UserDefaults.standard.stringArray(forKey: "delivered.\(p.id)") ?? []
            status = "Connecting…"
        }
        runner = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.pair != nil && !self.working && !self.terminalAuthFailure { await self.poll() }
                let delay = min(60, 5 * (1 << min(self.failures, 3)))
                try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000)
            }
        }
    }
    func validate() throws {
        guard let p = Int(port), (1024...65535).contains(p), String(p) == port else {
            throw CompanionError(message: "Enter a valid Support port (default 4173).")
        }
    }
    // In VM mode the host gateway owns SSH and serves only its bundled UI.
    // A TCP tunnel or guest response cannot impersonate it without this host-only key.
    func tunnel() async throws {
        try validate()
        guard useSSH else { return }
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Support Host", isDirectory: true)
        let file = root.appendingPathComponent("gateway-key-\(port)")
        guard FileManager.default.fileExists(atPath: file.path) else {
            throw CompanionError(message: "VM access is not active. Open VM connection settings to check your host gateway profile.")
        }
        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        let dirAttrs = try FileManager.default.attributesOfItem(atPath: root.path)
        guard attrs[.type] as? FileAttributeType == .typeRegular,
              (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              (dirAttrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 511) & 0o077 == 0,
              ((dirAttrs[.posixPermissions] as? NSNumber)?.intValue ?? 511) & 0o077 == 0,
              file.resolvingSymlinksInPath().path == file.path,
              (attrs[.size] as? NSNumber)?.intValue == 64 else {
            throw CompanionError(message: "Start the host gateway with private host settings. Direct VM tunnels are not supported.")
        }
        let text = try String(contentsOf: file, encoding: .utf8)
        guard text.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw CompanionError(message: "Invalid host gateway identity.")
        }
        let key = Data(stride(from: 0, to: 64, by: 2).map { offset -> UInt8 in
            let start = text.index(text.startIndex, offsetBy: offset)
            return UInt8(text[start..<text.index(start, offsetBy: 2)], radix: 16)!
        })
        var random = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else {
            throw CompanionError(message: "Could not verify the host gateway.")
        }
        let nonce = random.map { String(format: "%02x", $0) }.joined()
        var req = URLRequest(url: URL(string: base + "/__support/host?nonce=" + nonce)!)
        req.setValue(base, forHTTPHeaderField: "Origin")
        let (stream, response) = try await session.bytes(for: req)
        var data = Data()
        for try await byte in stream {
            guard data.count < 1024 else { throw CompanionError(message: "Invalid gateway response.") }
            data.append(byte)
        }
        struct Proof: Decodable { let version: Int; let proof: String }
        let proof = try JSONDecoder().decode(Proof.self, from: data)
        let expected = HMAC<SHA256>.authenticationCode(for: Data(nonce.utf8), using: SymmetricKey(data: key))
            .map { String(format: "%02x", $0) }.joined()
        guard (response as? HTTPURLResponse)?.statusCode == 200, proof.version == 1, proof.proof == expected else {
            throw CompanionError(message: "This listener is not the trusted host gateway. No credential was sent.")
        }
    }
    func stopTunnel() { } // Host gateway lifecycle is independent of notifications.
    func request<T: Decodable>(_ path: String, method: String = "GET", payload: [String: Any]? = nil,
                               authenticated: Bool = true) async throws -> T {
        guard let url = URL(string: base + "/api/companion/" + path) else { throw CompanionError(message: "Invalid connection address.") }
        var req = URLRequest(url: url); req.httpMethod = method; req.setValue(base, forHTTPHeaderField: "Origin")
        if authenticated, let pair { req.setValue("Bearer \(pair.token)", forHTTPHeaderField: "Authorization") }
        if let payload { req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = try JSONSerialization.data(withJSONObject: payload) }
        let (bytes, response) = try await session.bytes(for: req)
        var data = Data()
        for try await byte in bytes {
            guard data.count < 262144 else { throw CompanionError(message: "Support returned an oversized response.") }
            data.append(byte)
        }
        guard let http = response as? HTTPURLResponse else { throw CompanionError(message: "Invalid Support response.") }
        if http.statusCode == 401 && authenticated { terminalAuthFailure = true }
        guard http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode(APIError.self, from: data).error) ?? "Support returned HTTP \(http.statusCode)."
            throw CompanionError(message: message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func connect() async {
        guard !working else { return }; working = true; defer { working = false }
        do {
            try validate()
            code = code.trimmingCharacters(in: .whitespacesAndNewlines)
            guard code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
                throw CompanionError(message: "Paste a fresh pairing code from Support → Settings → Notifications.")
            }
            try await tunnel(); status = "Connecting…"
            // Retry only safe connection failures; pairing credentials are never resent on an ambiguous response.
            var connected: Pair?
            for attempt in 0..<5 {
                do { connected = try await request("pair", method: "POST", payload: ["code": code, "name": String((Host.current().localizedName ?? "My Mac").components(separatedBy: .controlCharacters).joined().prefix(60))], authenticated: false); break }
                catch let error as URLError where [.cannotConnectToHost, .networkConnectionLost].contains(error.code) && attempt < 4 {
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
            guard let result = connected else { throw CompanionError(message: "Could not reach Support.") }
            try Keychain.save(result); pair = result; paired = true; code = ""; terminalAuthFailure = false; delivered = []
            UserDefaults.standard.set(port, forKey: "supportPort")
            UserDefaults.standard.set(useSSH, forKey: "useSSH")
            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            status = allowed ? "Connected · waiting for notifications" : "Connected · allow notifications in macOS System Settings"
        } catch { status = error.localizedDescription }
    }
    func poll() async {
        guard !working else { return }; working = true; defer { working = false }
        do {
            try await tunnel()
            let inbox: Inbox = try await request("events")
            failures = 0
            if inbox.paused { status = inbox.reason ?? "Vault locked · open Support to unlock"; return }
            let center = UNUserNotificationCenter.current()
            let permission = await center.notificationSettings()
            guard [.authorized, .provisional].contains(permission.authorizationStatus) else {
                status = "Allow Support Companion notifications in macOS System Settings"; return
            }
            // A crash after scheduling but before acknowledgement must not alert again.
            let shown = await center.deliveredNotifications()
            for notification in shown where !delivered.contains(notification.request.identifier) { delivered.append(notification.request.identifier) }
            let pending = await center.pendingNotificationRequests()
            for notification in pending where !delivered.contains(notification.identifier) { delivered.append(notification.identifier) }
            var acked: [String] = []
            for event in inbox.events {
                if !delivered.contains(event.id) {
                    let content = UNMutableNotificationContent(); content.title = String(event.title.prefix(120))
                    content.body = String(event.body.prefix(300)); content.sound = .default
                    content.userInfo = ["route": event.route, "device": pair?.id ?? ""]
                    try await center.add(UNNotificationRequest(identifier: event.id, content: content, trigger: nil))
                    delivered.append(event.id); delivered = Array(delivered.suffix(1000))
                    if let id = pair?.id { UserDefaults.standard.set(delivered, forKey: "delivered.\(id)") }
                }
                acked.append(event.id)
            }
            if !acked.isEmpty {
                struct Ack: Decodable { let ok: Bool }
                let _: Ack = try await request("ack", method: "POST", payload: ["ids": acked])
            }
            status = "Connected · checked \(Date().formatted(date: .omitted, time: .shortened))"
        } catch {
            failures += 1
            status = terminalAuthFailure ? "Pairing revoked · disconnect here, then pair again" : "Reconnecting · \(error.localizedDescription)"
        }
    }
    func open(_ route: String = "#/dashboard", device: String? = nil) {
        guard device == nil || device == pair?.id else { return }
        guard route.count <= 1500, route.range(of: "^#/(dashboard|youtrack|alerts|slack|settings)(\\?|$)", options: .regularExpression) != nil,
              let url = URL(string: base + "/" + route) else { return }
        Task { do { try await tunnel(); NSWorkspace.shared.open(url) } catch { status = error.localizedDescription } }
    }
    func disconnect() {
        guard !working else { return }
        do {
            try Keychain.remove()
            if let id = pair?.id { UserDefaults.standard.removeObject(forKey: "delivered.\(id)") }
            pair = nil; paired = false; terminalAuthFailure = false; delivered = []; stopTunnel()
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
            status = "Disconnected. Remove this Mac in Support Settings to revoke its credential."
        } catch { status = error.localizedDescription }
    }
    func setLogin(_ enabled: Bool) async {
        do { if enabled { try SMAppService.mainApp.register() } else { try await SMAppService.mainApp.unregister() }; login = SMAppService.mainApp.status == .enabled
            if SMAppService.mainApp.status == .requiresApproval { status = "Allow Support Companion in System Settings → General → Login Items." }
        }
        catch { status = "Could not update launch at login: \(error.localizedDescription)"; login = SMAppService.mainApp.status == .enabled }
    }
    func shutdown() { runner?.cancel(); stopTunnel() }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static var model: Companion?
    func applicationDidFinishLaunching(_ notification: Notification) { UNUserNotificationCenter.current().delegate = self }
    func applicationWillTerminate(_ notification: Notification) { MainActor.assumeIsolated { Self.model?.shutdown(); ExistingVMConnection.shared.stop() } }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) { completion([.banner, .sound, .list]) }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let route = info["route"] as? String, let device = info["device"] as? String {
            Task { @MainActor in Self.model?.open(route, device: device) }
        }
        completion()
    }
}

@MainActor struct CompanionView: View {
    @Environment(\.openWindow) private var openWindow
    @ObservedObject var model: Companion
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Image(systemName: "bell.badge").font(.largeTitle).foregroundStyle(.green); VStack(alignment: .leading) { Text("Support Companion").font(.title2.bold()); Text("Your workspace, in reach.").foregroundStyle(.secondary) } }
            Label(model.status, systemImage: model.paired ? "link" : "link.badge.plus").font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if !model.paired {
                Picker("Support runs", selection: $model.useSSH) { Text("Existing VM · host gateway").tag(true); Text("On this Mac · local service").tag(false) }
                if model.useSSH {
                    Text("Start your VM separately. Support connects through a verified host gateway; it does not create or manage VMs.").font(.caption).foregroundStyle(.secondary)
                    Button("VM connection settings…") { openWindow(id: "vm-connection") }
                }
                HStack { Text("Support port"); TextField("4173", text: $model.port).frame(width: 100) }
                SecureField("Pairing code from Settings → Notifications", text: $model.code)
                    .onSubmit { Task { await model.connect() } }
                Button("Pair this Mac") { Task { await model.connect() } }.buttonStyle(.borderedProminent).disabled(model.working || model.code.isEmpty)
            } else {
                HStack { Button("Open Support") { model.open() }.buttonStyle(.borderedProminent); Button("Disconnect") { model.disconnect() }.disabled(model.working) }
                Text("Click a notification to open its ticket or alert. Reviews and approvals stay in Support.").font(.callout).foregroundStyle(.secondary)
            }
            Divider()
            Toggle("Launch at login", isOn: Binding(get: { model.login }, set: { value in Task { await model.setLogin(value) } }))
            Button("macOS login settings") { SMAppService.openSystemSettingsLoginItems() }.buttonStyle(.link)
            Button("macOS notification settings") { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!) }.buttonStyle(.link)
            Text("No service tokens or model tools run on this Mac. Notification credentials stay in Keychain.").font(.caption).foregroundStyle(.secondary)
        }.padding(28).frame(width: 460).textFieldStyle(.roundedBorder)
          .disabled(model.working && !model.paired)
    }
}

@main @MainActor struct SupportCompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model: Companion
    init() {
        let instance = Companion()
        _model = StateObject(wrappedValue: instance)
        AppDelegate.model = instance
    }
    @Environment(\.openWindow) private var openWindow
    var body: some Scene {
        Window("Support Companion", id: "companion") {
            CompanionView(model: model).onAppear { AppDelegate.model = model }
        }.windowResizability(.contentSize)
        Window("VM connection", id: "vm-connection") { ExistingVMView() }.windowResizability(.contentSize)
        MenuBarExtra("Support", systemImage: "bell.badge") {
            Text(model.status)
            Button("Open Support") { model.open() }
            Button("VM connection…") { openWindow(id: "vm-connection"); NSApp.activate(ignoringOtherApps: true) }
            Button("Companion settings…") { openWindow(id: "companion"); NSApp.activate(ignoringOtherApps: true) }
            Divider()
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
    }
}

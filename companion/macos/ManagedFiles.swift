import Foundation
import CryptoKit
import Darwin

struct ManagedImageManifest: Codable {
    let version: Int
    let architecture: String
    let sha256: [String: String]
}
struct ManagedEndpoint: Codable, Identifiable {
    var id = UUID()
    var host = ""
    var address = ""
    var port = 443
    var allowPrivate = false
    enum CodingKeys: String, CodingKey { case host, address, port, allowPrivate }
}
struct ManagedNetworkPolicy: Codable { var version = 1; var endpoints: [ManagedEndpoint] = [] }
struct ManagedPreferences: Codable { var cpu = 2; var memoryMiB = 2048; var port = 4173 }

enum ManagedFiles {
    static var root: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Support Host", isDirectory: true) }
    static var vm: URL { root.appendingPathComponent("ManagedVM", isDirectory: true) }
    static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }
    static func directory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard url.resolvingSymlinksInPath().path == url.path, attrs[.type] as? FileAttributeType == .typeDirectory,
              (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 511) & 0o077 == 0 else {
            throw CompanionError(message: "Managed VM storage must be a private, host-owned directory without symlinks.")
        }
    }
    static func regular(_ url: URL, maxBytes: UInt64, privateFile: Bool = false) throws {
        var st = stat()
        guard lstat(url.path, &st) == 0, st.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), st.st_nlink == 1,
              st.st_size > 0, UInt64(st.st_size) <= maxBytes, url.resolvingSymlinksInPath().path == url.path else {
            throw CompanionError(message: "Use a bounded regular file, without symlinks or hard links: \(url.lastPathComponent)")
        }
        if privateFile && (st.st_uid != getuid() || st.st_mode & 0o077 != 0) { throw CompanionError(message: "Managed VM files must remain private to the Mac user.") }
    }
    static func digest(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 4 * 1024 * 1024), !data.isEmpty { hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    static func manifest(_ folder: URL) throws -> ManagedImageManifest {
        let file = folder.appendingPathComponent("manifest.json"); try regular(file, maxBytes: 65536)
        let value = try JSONDecoder().decode(ManagedImageManifest.self, from: Data(contentsOf: file))
        guard value.version == 1, value.architecture == architecture, Set(value.sha256.keys) == Set(["vmlinuz", "initrd", "rootfs.raw"]),
              value.sha256.values.allSatisfy({ $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }) else {
            throw CompanionError(message: "Choose a version-1 Linux bundle for \(architecture), with kernel, initrd and rootfs hashes.")
        }
        return value
    }
    // Import is additive and transactional. It never replaces an existing guest disk.
    static func importImage(_ source: URL) throws {
        try directory(root)
        guard !FileManager.default.fileExists(atPath: vm.path) else { throw CompanionError(message: "A managed VM already exists. Its data will not be replaced.") }
        let definition = try manifest(source), stage = root.appendingPathComponent("import-" + UUID().uuidString, isDirectory: true)
        try directory(stage)
        do {
            for (name, limit) in [("vmlinuz", UInt64(128 << 20)), ("initrd", UInt64(512 << 20)), ("rootfs.raw", UInt64(32) << 30)] {
                let input = source.appendingPathComponent(name), output = stage.appendingPathComponent(name)
                try regular(input, maxBytes: limit)
                try FileManager.default.copyItem(at: input, to: output)
                try FileManager.default.setAttributes([.posixPermissions: name == "rootfs.raw" ? 0o600 : 0o400], ofItemAtPath: output.path)
                try regular(output, maxBytes: limit, privateFile: true)
                guard try digest(output) == definition.sha256[name] else { throw CompanionError(message: "Runtime integrity check failed for \(name).") }
            }
            try JSONEncoder().encode(definition).write(to: stage.appendingPathComponent("manifest.json"), options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stage.appendingPathComponent("manifest.json").path)
            try FileManager.default.moveItem(at: stage, to: vm)
        } catch { try? FileManager.default.removeItem(at: stage); throw error }
    }
    static func verifyBoot() throws {
        try directory(root); try directory(vm)
        let definition = try manifest(vm)
        for (name, limit) in [("vmlinuz", UInt64(128 << 20)), ("initrd", UInt64(512 << 20))] {
            let file = vm.appendingPathComponent(name); try regular(file, maxBytes: limit, privateFile: true)
            guard try digest(file) == definition.sha256[name] else { throw CompanionError(message: "The managed boot files changed. Start was refused.") }
        }
        // Guest writes persist here; its initial digest is checked at import, not after every boot.
        try regular(vm.appendingPathComponent("rootfs.raw"), maxBytes: UInt64(32) << 30, privateFile: true)
        if FileManager.default.fileExists(atPath: vm.appendingPathComponent("inputs.iso").path) { try regular(vm.appendingPathComponent("inputs.iso"), maxBytes: UInt64(512) << 20, privateFile: true) }
    }
    static func importInput(_ source: URL) throws {
        try directory(vm); let output = vm.appendingPathComponent("inputs.iso")
        guard !FileManager.default.fileExists(atPath: output.path) else { throw CompanionError(message: "An input disk is already attached. Preserve it; clone new repositories inside the guest.") }
        try regular(source, maxBytes: UInt64(512) << 20)
        let stage = vm.appendingPathComponent("input-" + UUID().uuidString)
        do { try FileManager.default.copyItem(at: source, to: stage); try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: stage.path); try regular(stage, maxBytes: UInt64(512) << 20, privateFile: true); try FileManager.default.moveItem(at: stage, to: output) }
        catch { try? FileManager.default.removeItem(at: stage); throw error }
    }
    static func save<T: Encodable>(_ value: T, name: String) throws {
        try directory(root); let file = root.appendingPathComponent(name)
        try JSONEncoder().encode(value).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

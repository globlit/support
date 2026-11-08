import Foundation
import Virtualization
import Darwin

// The app owns both local socket paths. No path, command or destination comes from guest bytes.
private func unixAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw CompanionError(message: "Managed socket path is too long.") }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    return address
}
private func unixSocket(_ path: String, listening: Bool) throws -> Int32 {
    var address = try unixAddress(path)
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw CompanionError(message: "Could not create a private managed socket.") }
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            listening ? Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) : Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard result == 0 else { Darwin.close(fd); throw CompanionError(message: "Managed socket is unavailable or already exists.") }
    if listening {
        guard Darwin.listen(fd, 8) == 0 else { Darwin.close(fd); throw CompanionError(message: "Could not listen on the private managed socket.") }
        _ = chmod(path, 0o600)
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
    }
    return fd
}

final class ManagedRelays {
    private let lock = NSLock()
    private var descriptors = Set<Int32>()
    private var stopped = false
    let slots = DispatchSemaphore(value: 12)
    func stop() {
        lock.lock(); stopped = true
        for fd in descriptors { _ = Darwin.shutdown(fd, SHUT_RDWR) }
        lock.unlock()
    }
    // Caller reserves one slot; worker owns local FD and retains VZ connection until finished.
    func forward(_ local: Int32, _ connection: VZVirtioSocketConnection) {
        DispatchQueue.global(qos: .utility).async {
            let guest = Darwin.dup(connection.fileDescriptor)
            defer {
                self.lock.lock(); self.descriptors.remove(local); self.descriptors.remove(guest)
                Darwin.close(local); if guest >= 0 { Darwin.close(guest) }; self.lock.unlock()
                DispatchQueue.main.async { connection.close() }; self.slots.signal()
            }
            self.lock.lock()
            guard guest >= 0, !self.stopped else { self.lock.unlock(); return }
            self.descriptors.insert(local); self.descriptors.insert(guest); self.lock.unlock()
            for fd in [local, guest] {
                var noPipe: Int32 = 1; var timeout = timeval(tv_sec: 5, tv_usec: 0)
                _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noPipe, socklen_t(MemoryLayout.size(ofValue: noPipe)))
                _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
                _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
            }
            var polls = [pollfd(fd: local, events: Int16(POLLIN), revents: 0), pollfd(fd: guest, events: Int16(POLLIN), revents: 0)]
            var active = [true, true], buffer = [UInt8](repeating: 0, count: 32768), count = 0
            let deadline = ProcessInfo.processInfo.systemUptime + 600
            while active.contains(true), ProcessInfo.processInfo.systemUptime < deadline {
                for i in 0...1 { polls[i].fd = active[i] ? (i == 0 ? local : guest) : -1; polls[i].revents = 0 }
                let ready = Darwin.poll(&polls, 2, 1000)
                if ready < 0 { if errno == EINTR { continue }; return }
                for i in 0...1 where active[i] && polls[i].revents != 0 {
                    let from = i == 0 ? local : guest, to = i == 0 ? guest : local
                    let n = Darwin.recv(from, &buffer, buffer.count, 0)
                    if n <= 0 { active[i] = false; _ = Darwin.shutdown(to, SHUT_WR); continue }
                    count += n; if count > 64 * 1024 * 1024 { return }
                    var written = 0
                    while written < n {
                        let sent = buffer.withUnsafeBytes { Darwin.send(to, $0.baseAddress!.advanced(by: written), n - written, 0) }
                        if sent <= 0 { return }; written += sent
                    }
                }
            }
        }
    }
}

final class ManagedEgressListener: NSObject, VZVirtioSocketListenerDelegate {
    let path: String
    let relays: ManagedRelays
    init(path: String, relays: ManagedRelays) { self.path = path; self.relays = relays }
    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection, from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard connection.destinationPort == 4174, relays.slots.wait(timeout: .now()) == .success else { return false }
        DispatchQueue.global(qos: .utility).async {
            do { let fd = try unixSocket(self.path, listening: false); self.relays.forward(fd, connection) }
            catch { DispatchQueue.main.async { connection.close() }; self.relays.slots.signal() }
        }
        return true
    }
}

final class ManagedAPIListener {
    private let source: DispatchSourceRead
    private let relays: ManagedRelays
    init(path: String, device: VZVirtioSocketDevice, relays: ManagedRelays) throws {
        self.relays = relays
        let fd = try unixSocket(path, listening: true)
        source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        source.setEventHandler {
            // Bounded accept work on each callback; no generic host TCP listener exists.
            for _ in 0..<12 {
                let client = Darwin.accept(fd, nil, nil)
                if client < 0 { break }
                guard relays.slots.wait(timeout: .now()) == .success else { Darwin.close(client); continue }
                var finished = false
                let timeout = DispatchWorkItem {
                    if !finished { finished = true; Darwin.close(client); relays.slots.signal() }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: timeout)
                device.connect(toPort: 4173) { result in
                    guard !finished else { if case .success(let late) = result { late.close() }; return }
                    finished = true; timeout.cancel()
                    switch result {
                    case .success(let connection): relays.forward(client, connection)
                    case .failure: Darwin.close(client); relays.slots.signal()
                    }
                }
            }
        }
        source.setCancelHandler { Darwin.close(fd) }
        source.resume()
    }
    func stop() { source.cancel(); relays.stop() }
    deinit { source.cancel() }
}

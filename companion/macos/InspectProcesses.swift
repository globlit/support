// Host-only helper. Reads kernel argv, never shell-formatted command lines or VM data.
import Foundation
import Darwin

@_silgen_name("proc_pidpath") private func pidPath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer, _ size: UInt32) -> Int32
struct ProcessInfo: Codable { let pid: Int32; let ppid: Int32; let executable: String; let args: [String]? }
func arguments(_ pid: Int32) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4, size <= 262144 else { return nil }
    var bytes = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { return nil }
    let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    guard argc > 0, argc <= 512 else { return nil }
    var offset = 4
    while offset < size && bytes[offset] != 0 { offset += 1 } // kernel executable path
    while offset < size && bytes[offset] == 0 { offset += 1 }
    var result: [String] = []
    for _ in 0..<Int(argc) {
        let start = offset
        while offset < size && bytes[offset] != 0 { offset += 1 }
        guard offset < size, offset - start <= 16384,
              let arg = String(bytes: bytes[start..<offset], encoding: .utf8) else { return nil }
        result.append(arg); offset += 1
    }
    return result
}
let task = Process(), pipe = Pipe()
task.executableURL = URL(fileURLWithPath: "/bin/ps")
task.arguments = ["-axo", "pid=,ppid=,comm="]
task.environment = ["PATH": "/usr/bin:/bin", "LANG": "C"]
task.standardOutput = pipe; task.standardError = FileHandle.nullDevice; task.standardInput = FileHandle.nullDevice
try task.run()
DispatchQueue.global().asyncAfter(deadline: .now() + 5) { if task.isRunning { task.terminate() } }
var data = Data()
while let chunk = try pipe.fileHandleForReading.read(upToCount: 16384), !chunk.isEmpty {
    data.append(chunk)
    if data.count > 262144 { task.terminate(); exit(1) }
}
task.waitUntilExit()
guard task.terminationStatus == 0 else { exit(1) }
var result: [ProcessInfo] = []
for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
    let fields = line.split(maxSplits: 2, whereSeparator: { $0.isWhitespace })
    guard fields.count == 3, let pid = Int32(fields[0]), let ppid = Int32(fields[1]) else { exit(1) }
    var path = [CChar](repeating: 0, count: 4096)
    let count = pidPath(pid, &path, UInt32(path.count))
    let executable = count > 0 ? String(cString: path) : String(fields[2])
    let name = URL(fileURLWithPath: executable).lastPathComponent
    // Retain parent IDs for ancestry; do not collect other applications' arguments.
    result.append(ProcessInfo(pid: pid, ppid: ppid, executable: executable, args: ["tart", "softnet"].contains(name) ? arguments(pid) : nil))
    if result.count > 4096 { exit(1) }
}
FileHandle.standardOutput.write(try JSONEncoder().encode(result))

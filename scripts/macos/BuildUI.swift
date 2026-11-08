import AppKit

final class Builder: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let label = NSTextField(labelWithString: "Preparing the Support installer…")
    let progress = NSProgressIndicator()
    let log = NSTextView()
    let openButton = NSButton(title: "Open installer", target: nil, action: nil)
    var task: Process?
    let repo = CommandLine.arguments[1]
    var output = ""
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 410), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Build Support"; window.delegate = self; window.center()
        let view = NSView(frame: window.contentView!.bounds); window.contentView = view
        label.frame = NSRect(x: 24, y: 350, width: 572, height: 30); label.font = .systemFont(ofSize: 17, weight: .semibold); view.addSubview(label)
        progress.frame = NSRect(x: 24, y: 324, width: 572, height: 14); progress.isIndeterminate = false; progress.minValue = 0; progress.maxValue = 6; view.addSubview(progress)
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 70, width: 572, height: 238)); scroll.hasVerticalScroller = true
        log.isEditable = false; log.isSelectable = true; log.font = .monospacedSystemFont(ofSize: 11, weight: .regular); log.autoresizingMask = [.width]; scroll.documentView = log; view.addSubview(scroll)
        openButton.frame = NSRect(x: 425, y: 22, width: 172, height: 32); openButton.bezelStyle = .rounded; openButton.target = self; openButton.action = #selector(openDMG); openButton.isEnabled = false; view.addSubview(openButton)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let process = Process(), pipe = Pipe(); task = process
        process.executableURL = URL(fileURLWithPath: "/bin/bash"); process.arguments = [repo + "/scripts/macos/build-dmg.sh"]
        process.environment = ["PATH":"/usr/bin:/bin:/usr/sbin:/sbin", "HOME":NSHomeDirectory(), "LANG":"en_US.UTF-8"]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = pipe; process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                self.output = String((self.output + String(decoding: data, as: UTF8.self)).suffix(64000))
                self.log.string = self.output; self.log.scrollToEndOfDocument(nil)
                if let line = self.output.split(separator: "\n").last(where: { $0.hasPrefix("STEP ") }) {
                    let parts = line.split(separator: " ", maxSplits: 2)
                    if parts.count == 3 { self.progress.doubleValue = Double(parts[1]) ?? 0; self.label.stringValue = String(parts[2]) }
                }
            }
        }
        process.terminationHandler = { p in DispatchQueue.main.async {
            pipe.fileHandleForReading.readabilityHandler = nil
            self.openButton.isEnabled = p.terminationStatus == 0
            self.label.stringValue = p.terminationStatus == 0 ? "Ready — drag Support Companion into Applications" : "Build failed — details below"
            self.task = nil
        } }
        do { try process.run() } catch { label.stringValue = error.localizedDescription; task = nil }
    }
    @objc func openDMG() {
        #if arch(arm64)
        let name = "Support-arm64.dmg"
        #else
        let name = "Support-x64.dmg"
        #endif
        NSWorkspace.shared.open(URL(fileURLWithPath: repo + "/release/" + name))
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if task?.isRunning == true { let alert = NSAlert(); alert.messageText = "The installer is still building"; alert.informativeText = "Leave this window open until the build finishes. Your existing app and workspace are unchanged."; alert.runModal(); return .terminateCancel }
        return .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { task == nil }
    func windowShouldClose(_ sender: NSWindow) -> Bool { applicationShouldTerminate(NSApplication.shared) == .terminateNow }
}
let delegate = Builder()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()

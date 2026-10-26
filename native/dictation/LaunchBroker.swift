import AppKit
import Darwin
import Foundation

// LaunchServices makes the recording app responsible for its own privacy
// prompts, even when Electron was launched by an IDE without speech permission.
// The directly spawned broker only relays text over a private local socket.
func writeDescriptor(_ descriptor: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return false }
            offset += count
        }
        return true
    }
}

private func readHandshake(_ descriptor: Int32) -> String? {
    var bytes = [UInt8]()
    var byte: UInt8 = 0
    while bytes.count < 256 {
        let count = Darwin.read(descriptor, &byte, 1)
        if count < 0 && errno == EINTR { continue }
        guard count == 1 else { return nil }
        if byte == 10 { return String(bytes: bytes, encoding: .utf8) }
        bytes.append(byte)
    }
    return nil
}

private func socketAddress(_ path: String) -> sockaddr_un? {
    var address = sockaddr_un()
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return nil }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    return address
}

private func socketPeer(_ descriptor: Int32) -> pid_t? {
    var user: uid_t = 0
    var group: gid_t = 0
    var pid: pid_t = -1
    var size = socklen_t(MemoryLayout.size(ofValue: pid))
    guard getpeereid(descriptor, &user, &group) == 0, user == geteuid(),
          getsockopt(descriptor, 0, LOCAL_PEERPID, &pid, &size) == 0,
          size == MemoryLayout.size(ofValue: pid), pid > 0 else { return nil }
    return pid
}

private func handshakeTimeout(_ descriptor: Int32, seconds: Int) {
    var timeout = timeval(tv_sec: seconds, tv_usec: 0)
    setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
    setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
}

// No permission checks or recording happen until the exact launching broker
// acknowledges us. A cancelled or killed broker therefore cannot start audio later.
func connectDictationWorker(path: String, nonce: String, brokerPID: pid_t) -> Bool {
    guard var address = socketAddress(path) else { return false }
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return false }
    defer { close(descriptor) }
    handshakeTimeout(descriptor, seconds: 15)
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0, socketPeer(descriptor) == brokerPID,
          writeDescriptor(descriptor, Data((nonce + "\n").utf8)),
          readHandshake(descriptor) == "ready" else { return false }
    handshakeTimeout(descriptor, seconds: 0)
    return dup2(descriptor, STDIN_FILENO) >= 0 && dup2(descriptor, STDOUT_FILENO) >= 0
}

final class DictationLaunchBroker {
    private let workerArguments: [String]
    private let checkOnly: Bool
    private let nonce = UUID().uuidString
    private var directory: String?
    private var listener: DispatchSourceRead?
    private var connection: Int32 = -1
    private var peerPID: pid_t?
    private var authenticated = false
    private var reading = false
    private var running = false
    private var closing = false
    private var receivedOutput = false
    private var application: NSRunningApplication?
    private var observation: NSKeyValueObservation?
    private var signals: [DispatchSourceSignal] = []

    init(arguments: [String], checkOnly: Bool) {
        workerArguments = arguments
        self.checkOnly = checkOnly
    }

    func start() {
        // A short path also respects sockaddr_un's 104-byte path limit.
        var template = Array("/tmp/stark-dictation.XXXXXX".utf8CString)
        guard let created = mkdtemp(&template) else { fail(); return }
        let directory = String(cString: created)
        self.directory = directory
        guard chmod(directory, 0o700) == 0,
              var address = socketAddress(directory + "/channel") else { fail(); return }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { fail(); return }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(descriptor, 1) == 0,
              fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0 else {
            close(descriptor)
            fail()
            return
        }
        let listener = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: .main)
        listener.setEventHandler { [weak self] in self?.acceptWorker(descriptor) }
        listener.setCancelHandler { close(descriptor) }
        self.listener = listener
        listener.resume()
        signals = [SIGTERM, SIGINT].map { code in
            signal(code, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
            source.setEventHandler { [weak self] in self?.finish(cancelled: true) }
            source.resume()
            return source
        }
        if !checkOnly { monitorParent() }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        configuration.arguments = workerArguments + [
            "--socket", directory + "/channel", "--nonce", nonce, "--broker-pid", String(getpid()),
        ]
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { app, _ in
            DispatchQueue.main.async {
                guard let app else { self.fail(); return }
                self.application = app
                self.observation = app.observe(\.isTerminated, options: [.new]) { _, change in
                    guard change.newValue == true else { return }
                    DispatchQueue.main.async {
                        // Drain a worker's final text before closing the broker.
                        if self.closing { self.exitBroker() }
                        else if !self.reading { self.fail() }
                    }
                }
                if self.closing {
                    app.forceTerminate()
                    if app.isTerminated { self.exitBroker() }
                } else { self.startRelayIfReady() }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            if !self.running && !self.closing { self.fail() }
        }
    }

    private func acceptWorker(_ listenerDescriptor: Int32) {
        guard connection < 0, !closing else { return }
        let descriptor = accept(listenerDescriptor, nil, nil)
        guard descriptor >= 0 else { return }
        connection = descriptor
        listener?.cancel()
        listener = nil
        // Accept inherits O_NONBLOCK on macOS; the bounded handshake is blocking.
        guard fcntl(descriptor, F_SETFL, 0) == 0 else {
            closeConnection()
            fail()
            return
        }
        handshakeTimeout(descriptor, seconds: 5)
        let peer = socketPeer(descriptor)
        DispatchQueue.global(qos: .userInitiated).async {
            let response = readHandshake(descriptor)
            DispatchQueue.main.async {
                if self.closing {
                    self.closeConnection()
                    return
                }
                guard response == self.nonce, let peer else {
                    self.closeConnection()
                    self.fail()
                    return
                }
                self.authenticated = true
                self.peerPID = peer
                self.startRelayIfReady()
            }
        }
    }

    private func startRelayIfReady() {
        guard !closing, !running, authenticated, let application else { return }
        guard peerPID == application.processIdentifier, !application.isTerminated,
              writeDescriptor(connection, Data("ready\n".utf8)) else { fail(); return }
        running = true
        reading = true
        handshakeTimeout(connection, seconds: 0)
        let descriptor = connection
        DispatchQueue.global(qos: .userInitiated).async {
            var bytes = [UInt8](repeating: 0, count: 4096)
            var total = 0
            while true {
                let count = Darwin.read(descriptor, &bytes, bytes.count)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { break }
                total += count
                guard total <= 256 * 1024,
                      writeDescriptor(STDOUT_FILENO, Data(bytes.prefix(count))) else { break }
            }
            DispatchQueue.main.async {
                self.receivedOutput = total > 0
                self.closeConnection()
                if !self.closing {
                    if total > 0 { self.finish(cancelled: false) }
                    else { self.fail() }
                }
            }
        }
    }

    private func monitorParent() {
        DispatchQueue.global(qos: .userInitiated).async {
            // Parent commands are tiny and bounded, including before a newline.
            while let line = readHandshake(STDIN_FILENO) {
                guard let data = line.data(using: .utf8),
                      let command = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                      let type = command["type"], type == "stop" || type == "cancel" else { break }
                DispatchQueue.main.async {
                    guard !self.closing else { return }
                    if type == "cancel" || !self.running { self.finish(cancelled: true) }
                    else if !writeDescriptor(self.connection, Data((line + "\n").utf8)) { self.fail() }
                }
            }
            DispatchQueue.main.async { self.finish(cancelled: true) }
        }
    }

    private func fail() {
        guard !closing else { return }
        emit(["type": "error", "message": "Dictation could not start its Mac helper. Try again or restart Stark Code."])
        finish(cancelled: false)
    }

    private func finish(cancelled: Bool) {
        guard !closing else { return }
        closing = true
        if cancelled && !receivedOutput { emit(["type": "cancelled"]) }
        listener?.cancel()
        listener = nil
        // shutdown wakes the active reader; it owns the final close, so another
        // thread cannot accidentally read a reused descriptor.
        if connection >= 0 { shutdown(connection, SHUT_RDWR) }
        cleanupDirectory()
        if let application {
            if application.isTerminated { exitBroker() }
            application.forceTerminate()
        }
        // A late LaunchServices completion still terminates its exact app. If it
        // arrives after exit, the unacknowledged worker has no live socket and exits.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.exitBroker() }
    }

    private func closeConnection() {
        guard connection >= 0 else { return }
        close(connection)
        connection = -1
    }

    private func cleanupDirectory() {
        guard let directory else { return }
        unlink(directory + "/channel")
        rmdir(directory)
        self.directory = nil
    }

    private func exitBroker() -> Never {
        cleanupDirectory()
        exit(0)
    }
}

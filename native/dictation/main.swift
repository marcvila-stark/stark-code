import AppKit
import AVFoundation
import Darwin
import Foundation
import Speech

// This helper owns one recording. It never writes audio to disk or permits
// server recognition; its parent receives only levels and the final transcript.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    _ = writeDescriptor(STDOUT_FILENO, data + Data([0x0a]))
}

// AVAudioEngine supplies float PCM. Sample only when the level is due; no audio
// is copied or retained, and interleaved buffers use the documented channel stride.
func microphoneLevelPercent(_ buffer: AVAudioPCMBuffer) -> Int? {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0,
          buffer.format.channelCount > 0 else { return nil }
    let frames = Int(buffer.frameLength)
    let channelCount = Int(buffer.format.channelCount)
    var squares = 0.0
    for channel in 0..<channelCount {
        for frame in 0..<frames {
            let sample = Double(channels[channel][frame * buffer.stride])
            if sample.isFinite { squares += sample * sample }
        }
    }
    let rms = sqrt(squares / Double(frames * channelCount))
    let normalized = (20 * log10(max(rms, 0.001)) + 60) / 60
    return Int((min(1, max(0, normalized)) * 100).rounded())
}

func emitMicrophoneLevel(_ percent: Int) {
    // A fixed numeric representation bounds every level line to 39 bytes.
    // 1,200 levels plus even a maximally escaped 32 KiB transcript fit below
    // the broker/desktop's 256 KiB cumulative output cap.
    let number = percent == 100 ? "1" : "0.\(percent < 10 ? "0" : "")\(percent)"
    _ = writeDescriptor(STDOUT_FILENO, Data("{\"type\":\"recording\",\"audioLevel\":\(number)}\n".utf8))
}

final class Dictation {
    private let locale: Locale
    private var recognizer: SFSpeechRecognizer?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var finished = false
    private var stopping = false
    private var text = ""

    init(locale: Locale) { self.locale = locale }

    func start() {
        guard !finished else { return }
        // Inspect language support before prompting for permissions. Missing
        // system language assets cannot be fixed by a microphone grant.
        guard SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true else {
            unavailableLanguage()
            return
        }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard !self.finished else { return }
                guard status == .authorized else {
                    self.fail("Allow Speech Recognition for Stark Code Dictation in System Settings → Privacy & Security, then try again.")
                    return
                }
                self.authorizeMicrophone()
            }
        }
    }

    private func authorizeMicrophone() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            beginRecording()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { allowed in
                DispatchQueue.main.async {
                    guard !self.finished else { return }
                    if allowed { self.beginRecording() }
                    else { self.microphoneDenied() }
                }
            }
        default:
            microphoneDenied()
        }
    }

    private func microphoneDenied() {
        fail("Allow Microphone access for Stark Code Dictation in System Settings → Privacy & Security, then try again.")
    }

    private func unavailableLanguage() {
        fail("On-device dictation is unavailable for \(locale.identifier). Enable this language in macOS System Settings → Keyboard → Dictation, wait for its download, then try again.")
    }

    private func beginRecording() {
        guard !finished else { return }
        guard let recognizer = SFSpeechRecognizer(locale: locale),
              recognizer.supportsOnDeviceRecognition else {
            unavailableLanguage()
            return
        }
        guard recognizer.isAvailable else {
            fail("On-device speech recognition is unavailable right now. Try again shortly.")
            return
        }
        self.recognizer = recognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        // Apple only honors requiresOnDeviceRecognition when the capability
        // check above succeeds. There must never be a cloud fallback.
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        self.request = request
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("No microphone input is available. Check your Mac's Sound settings and try again.")
            return
        }
        // These counters belong exclusively to the serial audio tap callback.
        var nextLevelAt: UInt64 = 0
        var remainingLevels = 1_200
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            request.append(buffer)
            let now = DispatchTime.now().uptimeNanoseconds
            guard remainingLevels > 0, now >= nextLevelAt else { return }
            nextLevelAt = now + 250_000_000 // At most 4 Hz for a five-minute recording.
            guard let percent = microphoneLevelPercent(buffer) else { return }
            remainingLevels -= 1
            // JSON/text I/O stays off the audio callback. Queued samples cannot
            // restart the indicator after Stop or after a completed recording.
            DispatchQueue.main.async {
                guard let self, !self.finished, !self.stopping else { return }
                emitMicrophoneLevel(percent)
            }
        }
        tapInstalled = true
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                guard !self.finished else { return }
                if let result {
                    // Bound output even if recognition produces a pathological result.
                    self.text = String(decoding: result.bestTranscription.formattedString.utf8.prefix(32_000), as: UTF8.self)
                    if result.isFinal {
                        self.complete()
                        return
                    }
                }
                if error != nil {
                    if !self.text.isEmpty || self.stopping { self.complete() }
                    else { self.fail("No speech was recognized. Check your microphone and try again.") }
                }
            }
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            fail("The microphone could not start. Check your Mac's Sound settings and try again.")
            return
        }
        emit(["type": "recording"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 300) { self.stop() }
    }

    private func endAudio() {
        engine?.stop()
        if tapInstalled {
            engine?.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        request?.endAudio()
    }

    func stop() {
        guard !finished, !stopping else { return }
        // A click while permission is pending must not start a recording later.
        guard task != nil else { cancel(); return }
        stopping = true
        emit(["type": "recording", "finalizing": true])
        endAudio()
        // Some devices never deliver a final result after endAudio. Preserve
        // the most recent recognition instead of leaving the composer busy.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.complete() }
    }

    func cancel() { finish(["type": "cancelled"]) }

    private func complete() {
        guard !finished else { return }
        let transcript = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if transcript.isEmpty { fail("No speech was recognized. Try again when you're ready.") }
        else { finish(["type": "transcript", "text": transcript]) }
    }

    private func fail(_ message: String) { finish(["type": "error", "message": message]) }

    private func finish(_ event: [String: Any]) {
        guard !finished else { return }
        finished = true
        endAudio()
        task?.cancel()
        task = nil
        request = nil
        engine = nil
        emit(event)
        exit(0)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
var localeIdentifier = Locale.current.identifier
var checkOnly = false
var launch = false
var transportCheck = false
var socketPath: String?
var nonce: String?
var brokerPID: pid_t?
var index = 0
while index < arguments.count {
    switch arguments[index] {
    case "--locale" where index + 1 < arguments.count:
        index += 1
        localeIdentifier = arguments[index]
    case "--check":
        checkOnly = true
    case "--launch":
        launch = true
    case "--transport-check":
        transportCheck = true
    case "--socket" where index + 1 < arguments.count:
        index += 1
        socketPath = arguments[index]
    case "--nonce" where index + 1 < arguments.count:
        index += 1
        nonce = arguments[index]
    case "--broker-pid" where index + 1 < arguments.count:
        index += 1
        brokerPID = pid_t(arguments[index])
    default:
        emit(["type": "error", "message": "Invalid dictation helper arguments."])
        exit(64)
    }
    index += 1
}

let locale = Locale(identifier: localeIdentifier)
signal(SIGPIPE, SIG_IGN)
guard (socketPath == nil && nonce == nil && brokerPID == nil) ||
      (!launch && socketPath != nil && nonce != nil && brokerPID != nil) else {
    emit(["type": "error", "message": "Invalid dictation helper arguments."])
    exit(64)
}
if launch {
    var workerArguments = ["--locale", localeIdentifier]
    if checkOnly { workerArguments.append("--check") }
    if transportCheck { workerArguments.append("--transport-check") }
    let broker = DictationLaunchBroker(arguments: workerArguments, checkOnly: checkOnly)
    broker.start()
    withExtendedLifetime(broker) { RunLoop.main.run() }
    exit(0)
}
var authenticatedWorker = false
if let socketPath, let nonce, let brokerPID {
    // Register the native app with LaunchServices before completing the socket
    // handshake. The broker receives its exact NSRunningApplication identity.
    NSApplication.shared.finishLaunching()
    guard connectDictationWorker(path: socketPath, nonce: nonce, brokerPID: brokerPID) else { exit(1) }
    authenticatedWorker = true
}
// Finder or direct executable launches must never request permissions or begin
// recording. Only the authenticated worker can enter the speech path.
guard checkOnly || transportCheck || authenticatedWorker else {
    emit(["type": "error", "message": "Start dictation from Stark Code."])
    exit(64)
}
if checkOnly {
    // Capability inspection never requests TCC permission or opens an audio device.
    let supported = SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true
    emit(["supported": supported, "locale": locale.identifier])
    exit(0)
}

let dictation = Dictation(locale: locale)
func cancelRecording() {
    DispatchQueue.main.async {
        if transportCheck { emit(["type": "cancelled"]); exit(0) }
        dictation.cancel()
    }
    // The broker may be SIGKILLed at app quit. Even a stalled audio/main queue
    // must not leave its separately launched worker holding the microphone.
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1) { _exit(0) }
}
let signals = [SIGTERM, SIGINT].map { code -> DispatchSourceSignal in
    signal(code, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
    source.setEventHandler { cancelRecording() }
    source.resume()
    return source
}
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard line.utf8.count <= 256,
              let data = line.data(using: .utf8),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let type = command["type"], type == "stop" || type == "cancel" else {
            cancelRecording()
            return
        }
        DispatchQueue.main.async {
            if transportCheck { emit(["type": "cancelled"]); exit(0) }
            else if type == "stop" { dictation.stop() }
            else { dictation.cancel() }
        }
    }
    // Losing the parent closes stdin and must release the microphone.
    cancelRecording()
}
if transportCheck {
    // Exercises the real LaunchServices transport and lifecycle without TCC or audio.
    emit(["type": "ready", "pid": getpid()])
} else { DispatchQueue.main.async { dictation.start() } }
RunLoop.main.run()

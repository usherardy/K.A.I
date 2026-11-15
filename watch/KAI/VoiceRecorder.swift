import AVFoundation
import Observation

/// Records a spoken question and stops by itself when you pause.
/// (watchOS has no speech-recognition API, so the audio is transcribed by the backend.)
@MainActor
@Observable
final class VoiceRecorder {
    /// Smoothed input level from 0 to 1, which drives the orb while listening.
    private(set) var level: Double = 0

    @ObservationIgnored private var stopRequested = false

    enum RecordingError: LocalizedError {
        case microphoneDenied
        case couldNotStart

        var errorDescription: String? {
            switch self {
            case .microphoneDenied: "Kai needs the microphone. Turn it on in Settings → Privacy & Security → Microphone."
            case .couldNotStart: "Couldn't start the microphone. Try again."
            }
        }
    }

    private static let tick: Duration = .milliseconds(50)
    /// Silence after speech that counts as "done talking".
    private static let endOfSpeechSilence: TimeInterval = 1.2
    private static let maxWaitForSpeech: TimeInterval = 7
    private static let maxDuration: TimeInterval = 15

    /// Records until you stop talking, `finish()` is called, or the time limit.
    /// Returns nil when nothing that sounded like speech was heard.
    func recordQuestion() async throws -> URL? {
        guard await AVAudioApplication.requestRecordPermission() else { throw RecordingError.microphoneDenied }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        defer {
            level = 0
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
        }

        let url = FileManager.default.temporaryDirectory.appending(path: "kai-question.m4a")
        try? FileManager.default.removeItem(at: url)
        let recorder = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32_000,
        ])
        recorder.isMeteringEnabled = true
        guard recorder.record() else { throw RecordingError.couldNotStart }
        defer { recorder.stop() }

        stopRequested = false
        let start = Date()
        var noiseFloor: Float = -55
        var heardSpeech = false
        var lastSpeech = start

        while !stopRequested {
            try await Task.sleep(for: Self.tick)
            recorder.updateMeters()
            let power = recorder.averagePower(forChannel: 0) // dBFS: about -60 when quiet, 0 at full scale
            noiseFloor = max(-60, min(noiseFloor + 0.1, power)) // follows background noise, rising slowly
            let now = Date()
            if power > max(noiseFloor + 12, -45) {
                heardSpeech = true
                lastSpeech = now
            }
            level = level * 0.6 + Double(max(0, min(1, (power + 50) / 40))) * 0.4

            let elapsed = now.timeIntervalSince(start)
            if heardSpeech, now.timeIntervalSince(lastSpeech) > Self.endOfSpeechSilence { break }
            if !heardSpeech, elapsed > Self.maxWaitForSpeech { break }
            if elapsed > Self.maxDuration { break }
        }
        recorder.stop()
        return heardSpeech || stopRequested ? url : nil
    }

    /// Stop now and send what's been recorded (tapping the orb while talking).
    func finish() {
        stopRequested = true
    }

    #if DEBUG
    /// Testing aid: animates the level like someone talking, without the microphone.
    func simulateSpeech(for duration: TimeInterval) async throws {
        let start = Date()
        defer { level = 0 }
        while Date().timeIntervalSince(start) < duration {
            try await Task.sleep(for: Self.tick)
            let t = Date().timeIntervalSince(start)
            let syllables = abs(sin(t * 9)) * (0.6 + 0.4 * sin(t * 2.3))
            level = level * 0.6 + max(0, syllables) * 0.4
        }
    }
    #endif
}

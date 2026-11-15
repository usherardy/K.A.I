import AVFoundation
import Observation

/// Reads Kai's replies aloud with on-device text-to-speech, and reports each word
/// so the orb can pulse in time with the voice.
@MainActor
@Observable
final class Speaker: NSObject {
    static let shared = Speaker()

    private(set) var isSpeaking = false
    /// When the word currently being spoken started.
    private(set) var lastWordAt: Date = .distantPast

    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var currentUtterance: ObjectIdentifier?

    override private init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) {
        stop()
        let session = AVAudioSession.sharedInstance()
        // Duck (rather than stop) any music while Kai talks.
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
        try? session.setActive(true)

        // No explicit voice: the system default for the watch's language. Listing voices to pick a
        // "better" one (AVSpeechSynthesisVoice.speechVoices()) hung the app in testing, on and off the main thread.
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        currentUtterance = ObjectIdentifier(utterance)
        isSpeaking = true
        synthesizer.speak(utterance)
    }

    func stop() {
        guard currentUtterance != nil || synthesizer.isSpeaking else { return }
        currentUtterance = nil
        isSpeaking = false
        synthesizer.stopSpeaking(at: .immediate)
        Self.releaseAudioSession()
    }

    fileprivate func wordStarted(in utterance: ObjectIdentifier) {
        if utterance == currentUtterance { lastWordAt = .now }
    }

    fileprivate func finished(_ utterance: ObjectIdentifier) {
        guard utterance == currentUtterance else { return }
        currentUtterance = nil
        isSpeaking = false
        Self.releaseAudioSession()
    }

    /// Let other audio return to full volume once Kai stops talking.
    private static func releaseAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

extension Speaker: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.wordStarted(in: id) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.finished(id) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.finished(id) }
    }
}

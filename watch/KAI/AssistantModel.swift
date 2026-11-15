import Foundation
import Observation
import WatchKit

struct Turn: Identifiable, Equatable {
    enum Role { case user, kai }

    let id = UUID()
    let role: Role
    let text: String
}

enum AssistantPhase: Equatable {
    case idle, listening, thinking, speaking
}

/// The assistant's state: listen → think → speak, plus the conversation so far.
/// Follow-ups reuse the backend's conversation id, so "what are those errors?" knows what "those" means.
@MainActor
@Observable
final class AssistantModel {
    private(set) var turns: [Turn] = []
    /// What Kai heard you say this time.
    private(set) var heard: String?
    private(set) var reply: String?
    private(set) var errorMessage: String?

    let recorder = VoiceRecorder()

    /// Listening and thinking are tracked here; speaking comes from the Speaker.
    private var activity: AssistantPhase = .idle
    @ObservationIgnored private var conversationId: String?
    @ObservationIgnored private var task: Task<Void, Never>?

    var phase: AssistantPhase {
        activity == .idle && Speaker.shared.isSpeaking ? .speaking : activity
    }

    var statusText: String {
        switch phase {
        case .listening: "Listening…"
        case .thinking: "Thinking…"
        case .speaking: ""
        case .idle: reply == nil && errorMessage == nil ? "Tap to talk" : "Tap to ask a follow-up"
        }
    }

    /// Questions and answers, newest first.
    var exchanges: [(question: Turn?, answer: Turn)] {
        var result: [(question: Turn?, answer: Turn)] = []
        var pendingQuestion: Turn?
        for turn in turns {
            switch turn.role {
            case .user: pendingQuestion = turn
            case .kai:
                result.append((pendingQuestion, turn))
                pendingQuestion = nil
            }
        }
        return result.reversed()
    }

    /// What tapping the orb does right now.
    func orbTapped(speakReplies: Bool) {
        switch phase {
        case .idle: listen(speakReplies: speakReplies)
        case .listening: recorder.finish()
        case .thinking: break
        case .speaking: Speaker.shared.stop()
        }
    }

    func listen(speakReplies: Bool) {
        guard activity == .idle else { return }
        begin(.listening)
        WKInterfaceDevice.current().play(.start)

        task = Task {
            do {
                guard let audio = try await recordQuestion() else {
                    fail("I didn't hear anything. Tap to try again.")
                    return
                }
                WKInterfaceDevice.current().play(.click)
                activity = .thinking
                let response = try await KaiClient.fromBundle().ask(audioFile: audio, conversationId: conversationId)
                try Task.checkCancellation()
                deliver(response, question: nil, speak: speakReplies)
            } catch is CancellationError {
                activity = .idle
            } catch {
                fail(error.localizedDescription)
            }
        }
    }

    func ask(_ text: String, speakReplies: Bool) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, activity == .idle else { return }
        begin(.thinking)
        heard = question

        task = Task {
            do {
                let response = try await KaiClient.fromBundle().ask(question, conversationId: conversationId)
                try Task.checkCancellation()
                deliver(response, question: question, speak: speakReplies)
            } catch is CancellationError {
                activity = .idle
            } catch {
                fail(error.localizedDescription)
            }
        }
    }

    /// Stop listening, thinking and talking (the assistant screen was closed).
    func cancel() {
        task?.cancel()
        task = nil
        Speaker.shared.stop()
        activity = .idle
    }

    func startOver() {
        cancel()
        turns = []
        conversationId = nil
        heard = nil
        reply = nil
        errorMessage = nil
    }

    private func begin(_ phase: AssistantPhase) {
        task?.cancel()
        Speaker.shared.stop()
        heard = nil
        reply = nil
        errorMessage = nil
        activity = phase
    }

    private func deliver(_ response: AskResponse, question: String?, speak: Bool) {
        conversationId = response.conversationId ?? conversationId
        let said = (response.transcript ?? question ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !said.isEmpty {
            heard = said
            turns.append(Turn(role: .user, text: said))
        }
        reply = response.reply
        turns.append(Turn(role: .kai, text: response.reply))
        activity = .idle
        WKInterfaceDevice.current().play(.success)
        if speak { Speaker.shared.speak(response.reply) }
    }

    private func fail(_ message: String) {
        errorMessage = message
        activity = .idle
        WKInterfaceDevice.current().play(.failure)
    }

    private func recordQuestion() async throws -> URL? {
        #if DEBUG
        // Testing aid: `-KAITestAudioFile /path/question.m4a` pretends to listen, then sends that file.
        if let path = UserDefaults.standard.string(forKey: "KAITestAudioFile") {
            try await recorder.simulateSpeech(for: 2.5)
            return URL(fileURLWithPath: path)
        }
        #endif
        return try await recorder.recordQuestion()
    }
}

import Foundation
import Observation
import WatchKit

struct Turn: Identifiable, Equatable {
    enum Role { case user, kai, error }

    let id = UUID()
    let role: Role
    let text: String
}

/// One on-screen conversation with Kai. Follow-up questions reuse the backend's
/// conversation id so "what are those errors?" knows what "those" means.
@MainActor
@Observable
final class ConversationModel {
    private(set) var turns: [Turn] = []
    private(set) var isThinking = false
    private var conversationId: String?

    func ask(_ text: String, speakReply: Bool) async {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !isThinking else { return }

        Speaker.shared.stop()
        turns.append(Turn(role: .user, text: question))
        isThinking = true
        defer { isThinking = false }

        do {
            let response = try await KaiClient.fromBundle().ask(question, conversationId: conversationId)
            conversationId = response.conversationId
            turns.append(Turn(role: .kai, text: response.reply))
            WKInterfaceDevice.current().play(.success)
            if speakReply { Speaker.shared.speak(response.reply) }
        } catch {
            turns.append(Turn(role: .error, text: error.localizedDescription))
            WKInterfaceDevice.current().play(.failure)
        }
    }

    func startOver() {
        Speaker.shared.stop()
        turns = []
        conversationId = nil
    }
}

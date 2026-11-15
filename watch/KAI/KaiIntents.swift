import AppIntents

/// "Hey Siri, ask Kai" → Siri asks what you want to know, then speaks Kai's answer.
/// (A third-party app can't register its own always-listening wake word, so Siri is the hands-free entry point.)
struct AskKaiIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Kai"
    static let description = IntentDescription("Ask Kai about your projects' traffic, errors and priorities.")
    static let openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: IntentDialog("What do you want to know?"))
    var question: String

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let reply = try await KaiClient.fromBundle().ask(question).reply
        return .result(value: reply, dialog: "\(reply)")
    }
}

/// "Hey Siri, Kai briefing" → a spoken status update across all projects, no follow-up prompt.
struct KaiBriefingIntent: AppIntent {
    static let title: LocalizedStringResource = "Kai Briefing"
    static let description = IntentDescription("A quick spoken briefing across all your projects.")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let reply = try await KaiClient.fromBundle()
            .ask("Give me a quick briefing across all my projects: traffic, errors, and the one thing I should focus on.")
            .reply
        return .result(value: reply, dialog: "\(reply)")
    }
}

struct KaiShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: KaiBriefingIntent(),
            phrases: [
                "\(.applicationName) briefing",
                "Brief me with \(.applicationName)",
                "What's happening in \(.applicationName)",
            ],
            shortTitle: "Briefing",
            systemImageName: "chart.line.uptrend.xyaxis"
        )
        AppShortcut(
            intent: AskKaiIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
                "Talk to \(.applicationName)",
            ],
            shortTitle: "Ask Kai",
            systemImageName: "waveform"
        )
    }
}

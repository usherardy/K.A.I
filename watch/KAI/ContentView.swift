import SwiftUI

struct ContentView: View {
    @State private var model = ConversationModel()
    @AppStorage("speakReplies") private var speakReplies = true

    private static let suggestions = [
        "Give me a briefing",
        "Any new errors?",
        "What should I focus on?",
    ]

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        if model.turns.isEmpty {
                            Text("Ask about traffic, errors or what to work on next.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }

                        ForEach(model.turns) { turn in
                            TurnView(turn: turn).id(turn.id)
                        }

                        if model.isThinking {
                            HStack(spacing: 6) {
                                ProgressView().frame(width: 20, height: 20)
                                Text("Checking…").font(.footnote).foregroundStyle(.secondary)
                            }
                            .id("thinking")
                        }

                        askButton.id("ask")

                        if model.turns.isEmpty {
                            ForEach(Self.suggestions, id: \.self) { suggestion in
                                Button(suggestion) { send(suggestion) }
                                    .font(.footnote)
                                    .disabled(model.isThinking)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: model.turns) {
                    withAnimation { proxy.scrollTo("ask", anchor: .bottom) }
                }
                .onChange(of: model.isThinking) {
                    if model.isThinking { withAnimation { proxy.scrollTo("thinking", anchor: .bottom) } }
                }
            }
            .navigationTitle("Kai")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        model.startOver()
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                    }
                    .accessibilityLabel("New conversation")
                    .disabled(model.turns.isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        speakReplies.toggle()
                        if !speakReplies { Speaker.shared.stop() }
                    } label: {
                        Image(systemName: speakReplies ? "speaker.wave.2.fill" : "speaker.slash.fill")
                    }
                    .accessibilityLabel(speakReplies ? "Mute spoken replies" : "Speak replies")
                }
            }
        }
    }

    /// Opens the system input sheet (dictation, Scribble or keyboard) and sends what you say.
    private var askButton: some View {
        TextFieldLink(prompt: Text("Ask Kai")) {
            Label(model.turns.isEmpty ? "Ask Kai" : "Follow up", systemImage: "mic.fill")
                .frame(maxWidth: .infinity)
        } onSubmit: { text in
            send(text)
        }
        .tint(.accentColor)
        .disabled(model.isThinking)
        .modifier(DoubleTapToAsk())
    }

    private func send(_ text: String) {
        Task { await model.ask(text, speakReply: speakReplies) }
    }
}

private struct TurnView: View {
    let turn: Turn

    var body: some View {
        switch turn.role {
        case .user:
            Text(turn.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .multilineTextAlignment(.trailing)
        case .kai:
            Text(turn.text)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .error:
            Label(turn.text, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.orange)
        }
    }
}

/// On Apple Watch Series 9 / Ultra 2 and later, double-tap your fingers to start asking.
private struct DoubleTapToAsk: ViewModifier {
    func body(content: Content) -> some View {
        if #available(watchOS 11.0, *) {
            content.handGestureShortcut(.primaryAction)
        } else {
            content
        }
    }
}

#Preview {
    ContentView()
}

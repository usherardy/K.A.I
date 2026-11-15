import SwiftUI

/// Home: the orb button that opens the assistant, quick questions, and recent answers.
struct ContentView: View {
    @State private var assistant = AssistantModel()
    @State private var showingAssistant = false
    @AppStorage("speakReplies") private var speakReplies = true

    private static let suggestions = [
        "Give me a briefing",
        "Any new errors?",
        "What should I focus on?",
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 10) {
                    Button(action: openAndListen) {
                        VStack(spacing: 0) {
                            OrbView(phase: .idle)
                                .frame(width: 96, height: 96)
                            Text("Ask Kai")
                                .font(.headline)
                                .foregroundStyle(Color.kaiGold)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Ask Kai")
                    .modifier(DoubleTapShortcut())

                    if assistant.turns.isEmpty {
                        ForEach(Self.suggestions, id: \.self) { suggestion in
                            Button(suggestion) { open(asking: suggestion) }
                                .font(.footnote)
                        }
                    } else {
                        ForEach(assistant.exchanges, id: \.answer.id) { exchange in
                            VStack(alignment: .leading, spacing: 3) {
                                if let question = exchange.question {
                                    Text(question.text)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                                Text(exchange.answer.text)
                                    .font(.footnote)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 2)
                        }
                    }
                }
            }
            .navigationTitle("Kai")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        assistant.startOver()
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                    }
                    .accessibilityLabel("New conversation")
                    .disabled(assistant.turns.isEmpty)
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
        .sheet(isPresented: $showingAssistant) {
            AssistantView(model: assistant, speakReplies: speakReplies)
        }
        #if DEBUG
        // Testing aids for the simulator:
        //   -KAIAskOnLaunch "question"   open the assistant and ask a typed question
        //   -KAIListenOnLaunch YES       open the assistant and start listening
        .task {
            let defaults = UserDefaults.standard
            if let question = defaults.string(forKey: "KAIAskOnLaunch") {
                open(asking: question)
            } else if defaults.bool(forKey: "KAIListenOnLaunch") {
                openAndListen()
            }
        }
        #endif
    }

    private func openAndListen() {
        assistant.listen(speakReplies: speakReplies)
        showingAssistant = true
    }

    private func open(asking question: String) {
        assistant.ask(question, speakReplies: speakReplies)
        showingAssistant = true
    }
}

#Preview {
    ContentView()
}

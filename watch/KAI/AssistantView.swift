import SwiftUI
import WatchKit

/// The full-screen assistant: the orb listens, thinks and speaks; the answer appears below it.
struct AssistantView: View {
    let model: AssistantModel
    let speakReplies: Bool

    private var hasResult: Bool { model.reply != nil || model.errorMessage != nil }

    /// Big while listening and thinking, smaller once there's an answer to read (like Siri).
    private var orbSize: CGFloat {
        let width = WKInterfaceDevice.current().screenBounds.width
        return hasResult ? width * 0.42 : width * 0.78
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView { content }
                .onChange(of: hasResult) {
                    // Start the answer from the top, with the orb in view.
                    if hasResult { withAnimation { proxy.scrollTo("orb", anchor: .top) } }
                }
        }
        .onDisappear { model.cancel() }
    }

    private var content: some View {
        VStack(spacing: 6) {
            Button {
                model.orbTapped(speakReplies: speakReplies)
            } label: {
                OrbView(phase: model.phase, micLevel: model.recorder.level, lastWordAt: Speaker.shared.lastWordAt)
                    .frame(width: orbSize, height: orbSize)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(orbLabel)
            .modifier(DoubleTapShortcut())
            .id("orb")

            if !model.statusText.isEmpty {
                Text(model.statusText)
                    .font(.footnote)
                    .foregroundStyle(Color.kaiGold)
                    .contentTransition(.opacity)
            }

            if let heard = model.heard {
                Text("“\(heard)”")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            if let reply = model.reply {
                Text(reply)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
            }

            if let error = model.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            if model.phase == .idle {
                // For when you can't talk out loud.
                TextFieldLink(prompt: Text("Ask Kai")) {
                    Label("Type instead", systemImage: "keyboard")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } onSubmit: { text in
                    model.ask(text, speakReplies: speakReplies)
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(.spring(duration: 0.45), value: hasResult)
        .animation(.easeInOut(duration: 0.25), value: model.phase)
    }

    private var orbLabel: String {
        switch model.phase {
        case .idle: "Talk to Kai"
        case .listening: "Stop listening and send"
        case .thinking: "Kai is thinking"
        case .speaking: "Stop speaking"
        }
    }
}

/// On Apple Watch Series 9 / Ultra 2 and later, double-tap your fingers to press the main button.
struct DoubleTapShortcut: ViewModifier {
    func body(content: Content) -> some View {
        if #available(watchOS 11.0, *) {
            content.handGestureShortcut(.primaryAction)
        } else {
            content
        }
    }
}

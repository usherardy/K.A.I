import SwiftUI

extension Color {
    static let kaiPale = Color(red: 1.0, green: 0.96, blue: 0.78)
    static let kaiGold = Color(red: 1.0, green: 0.84, blue: 0.30)
    static let kaiAmber = Color(red: 1.0, green: 0.62, blue: 0.10)
    static let kaiEmber = Color(red: 1.0, green: 0.38, blue: 0.05)
}

/// Kai's animated presence: a glowing gold plasma core (Siri) inside rotating HUD rings (JARVIS).
///
/// - idle: slow breathing, rings drifting
/// - listening: a ring of bars reacts to your voice
/// - thinking: bright arcs race around the ring
/// - speaking: the core and bars pulse with each spoken word
struct OrbView: View {
    var phase: AssistantPhase
    /// Microphone level from 0 to 1 while listening.
    var micLevel: Double = 0
    /// When the word being spoken started, while speaking.
    var lastWordAt: Date = .distantPast

    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: isLuminanceReduced)) { context in
            GeometryReader { geometry in
                let d = min(geometry.size.width, geometry.size.height)
                let t = context.date.timeIntervalSinceReferenceDate
                let energy = energy(at: context.date)

                ZStack {
                    glow(d, energy)
                    plasma(d, t, energy)
                    core(d, energy)
                    voiceBars(d, t, energy)
                        .opacity(phase == .listening || phase == .speaking ? 1 : 0)
                    rings(d, t, energy)
                }
                .frame(width: geometry.size.width, height: geometry.size.height)
                .drawingGroup()
            }
        }
        .animation(.easeInOut(duration: 0.5), value: phase)
        .accessibilityHidden(true)
    }

    /// How lively the orb is right now, from 0 to 1.
    private func energy(at date: Date) -> Double {
        let t = date.timeIntervalSinceReferenceDate
        switch phase {
        case .idle: return 0.12 + 0.06 * (sin(t * 1.6) + 1) / 2
        case .listening: return 0.3 + 0.7 * micLevel
        case .thinking: return 0.45 + 0.1 * sin(t * 7)
        case .speaking: return 0.35 + 0.65 * exp(-date.timeIntervalSince(lastWordAt) * 4)
        }
    }

    private func glow(_ d: CGFloat, _ energy: Double) -> some View {
        Circle()
            .fill(RadialGradient(
                colors: [Color.kaiAmber.opacity(0.55), Color.kaiEmber.opacity(0.18), .clear],
                center: .center, startRadius: 0, endRadius: d * 0.5
            ))
            .frame(width: d, height: d)
            .scaleEffect(0.85 + 0.3 * energy)
    }

    /// Three soft, overlapping gradient blobs drifting around each other.
    private func plasma(_ d: CGFloat, _ t: Double, _ energy: Double) -> some View {
        let speeds = [0.9, -0.7, 0.55]
        return ZStack {
            ForEach(0..<3, id: \.self) { i in
                let n = Double(i)
                let wobble = d * 0.035 * (1 + 2 * energy)
                Ellipse()
                    .fill(AngularGradient(
                        colors: [.kaiGold, .kaiAmber, .kaiEmber, .kaiGold, Color.kaiPale.opacity(0.8), .kaiGold],
                        center: .center
                    ))
                    .frame(width: d * (0.50 + 0.12 * energy), height: d * (0.40 + 0.10 * energy))
                    .rotationEffect(.radians(t * speeds[i] + n * 2.1))
                    .offset(
                        x: cos(t * (1.1 + n * 0.37) + n) * wobble,
                        y: sin(t * (0.9 + n * 0.41) + n * 1.7) * wobble
                    )
                    .blur(radius: d * 0.05)
                    // Screen (not additive) blending keeps overlapping blobs gold instead of washing out to white.
                    .blendMode(.screen)
                    .opacity(0.7)
            }
        }
    }

    private func core(_ d: CGFloat, _ energy: Double) -> some View {
        Circle()
            .fill(RadialGradient(
                colors: [Color.kaiPale.opacity(0.95), Color.kaiGold.opacity(0.85), Color.kaiAmber.opacity(0)],
                center: .center, startRadius: 0, endRadius: d * 0.17
            ))
            .frame(width: d * 0.34, height: d * 0.34)
            .scaleEffect(0.9 + 0.25 * energy)
            .blendMode(.screen)
    }

    /// A circle of short bars around the core, like an audio meter.
    private func voiceBars(_ d: CGFloat, _ t: Double, _ energy: Double) -> some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let count = 44
            let inner = d * 0.31
            for i in 0..<count {
                let angle = Double(i) / Double(count) * 2 * .pi
                let wave = (sin(angle * 3 + t * 5) + sin(angle * 5 - t * 3.3) + 2) / 4
                let length = d * (0.015 + 0.10 * energy * wave)
                var bar = Path()
                bar.move(to: CGPoint(x: center.x + cos(angle) * inner, y: center.y + sin(angle) * inner))
                bar.addLine(to: CGPoint(x: center.x + cos(angle) * (inner + length), y: center.y + sin(angle) * (inner + length)))
                context.stroke(
                    bar,
                    with: .color(Color.kaiGold.opacity(0.85)),
                    style: StrokeStyle(lineWidth: max(1, d * 0.012), lineCap: .round)
                )
            }
        }
        .frame(width: d, height: d)
        .blendMode(.plusLighter)
    }

    private func rings(_ d: CGFloat, _ t: Double, _ energy: Double) -> some View {
        let line = max(1, d * 0.012)
        let comet = AngularGradient(colors: [Color.kaiGold.opacity(0.05), .kaiGold, .kaiPale], center: .center)
        let busy = phase == .listening || phase == .speaking
        return ZStack {
            // Outer tick marks.
            Circle()
                .stroke(Color.kaiGold.opacity(0.35), style: StrokeStyle(lineWidth: d * 0.025, dash: [0.6, 4.4]))
                .frame(width: d * 0.95, height: d * 0.95)
                .rotationEffect(.radians(-t * 0.12))

            // Main HUD ring: two arcs with comet-tail gradients.
            Group {
                Circle().trim(from: 0.02, to: 0.60)
                    .stroke(comet, style: StrokeStyle(lineWidth: line, lineCap: .round))
                Circle().trim(from: 0.68, to: 0.93)
                    .stroke(Color.kaiAmber.opacity(0.7), style: StrokeStyle(lineWidth: line, lineCap: .round))
            }
            .frame(width: d * 0.86, height: d * 0.86)
            .rotationEffect(.radians(t * 0.45))

            // Inner dashed ring, faded while the voice bars are showing.
            Circle()
                .stroke(Color.kaiGold.opacity(busy ? 0.12 : 0.45), style: StrokeStyle(lineWidth: line * 0.8, dash: [d * 0.01, d * 0.03]))
                .frame(width: d * 0.72, height: d * 0.72)
                .rotationEffect(.radians(-t * 0.8))

            // Thinking: two bright arcs racing around the main ring.
            ForEach(0..<2, id: \.self) { i in
                Circle().trim(from: 0, to: 0.09)
                    .stroke(Color.kaiPale, style: StrokeStyle(lineWidth: line * 1.6, lineCap: .round))
                    .frame(width: d * 0.86, height: d * 0.86)
                    .rotationEffect(.radians(t * 3.2 + Double(i) * .pi))
            }
            .opacity(phase == .thinking ? 1 : 0)
        }
        .scaleEffect(1 + 0.04 * energy)
    }
}

#Preview("Idle") { OrbView(phase: .idle).frame(width: 150, height: 150) }
#Preview("Thinking") { OrbView(phase: .thinking).frame(width: 150, height: 150) }

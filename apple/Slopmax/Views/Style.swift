// How the daemon's decisions look: tones as the system's colors, windows as
// gauges, times as live countdowns that cost the app no wakeups.
import SlopmaxKit
import SwiftUI

extension Tone {
    var color: Color {
        switch self {
        case .good: .green
        case .muted: .secondary
        case .accent: .accentColor
        case .warn: .orange
        case .bad: .red
        }
    }
}

extension Condition {
    /// What the status column says.
    var label: String {
        switch self {
        case .signInNeeded: "Sign in again"
        case .disabled: "Disabled"
        case .limited: "Limited"
        case .throttled: "Throttled"
        case .active(let sessions): sessions == 1 ? "1 session" : "\(sessions) sessions"
        case .ready: "Ready"
        }
    }

    var symbol: String {
        switch self {
        case .signInNeeded: "exclamationmark.triangle.fill"
        case .disabled: "pause.circle"
        case .limited, .throttled: "hourglass"
        case .active: "bolt.fill"
        case .ready: "checkmark.circle"
        }
    }
}

extension Note {
    var label: String {
        switch self {
        case .pinned: "Pinned"
        case .priority(let value): "Priority \(value)"
        case .follows(let tool): "Follows \(tool)"
        case .resets(let count): count == 1 ? "1 limit reset" : "\(count) limit resets"
        case .served(let requests, let tokens):
            "\(requests.formatted()) requests · \(tokens.formatted(.number.notation(.compactName))) tokens"
        case .lastError(let text): text
        }
    }
}

extension Span {
    var label: String {
        switch self {
        case .fiveHours: "5 hours"
        case .week: "Week"
        case .month: "Month"
        }
    }
}

/// One window's use, with when it resets counting down by itself.
struct WindowGauge: View {
    let title: String
    let used: Double
    let resetsAt: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("\(Int(used.rounded()))%").font(.caption.monospacedDigit())
            }
            Gauge(value: min(used, 100), in: 0...100) { EmptyView() }
                .gaugeStyle(.accessoryLinearCapacity)
                .tint(toneOfUse(used).color)
            if let resetsAt, resetsAt > .now {
                Text("resets in \(Text(timerInterval: Date.now...resetsAt, countsDown: true))")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }
}

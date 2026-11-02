// The names the API uses for providers, strategies and the like. Each
// enum's raw values are the wire's, and an unknown one fails to decode, so
// a name the daemon adds shows up in the contract tests, not as a crash.
import Foundation

public enum Provider: String, Codable, Sendable, CaseIterable, Identifiable {
    case claude, codex, anthropic, openai, xai, compat

    public var id: String { rawValue }

    /// For people.
    public var title: String {
        switch self {
        case .claude: "Claude"
        case .codex: "ChatGPT"
        case .anthropic: "Anthropic"
        case .openai: "OpenAI"
        case .xai: "xAI"
        case .compat: "Compatible"
        }
    }

    /// A plan's quota, rather than a key billed by the token.
    public var isSubscription: Bool { self == .claude || self == .codex }
}

public enum AgentId: String, Codable, Sendable, CaseIterable {
    case claudeCode = "claude-code"
    case codex
}

public enum Strategy: String, Codable, Sendable, CaseIterable {
    case resetFirst = "reset-first"
    case fillFirst = "fill-first"
    case leastUsed = "least-used"
    case roundRobin = "round-robin"
}

public enum Dialect: String, Codable, Sendable {
    case messages, responses, chat
}

public enum Span: String, Codable, Sendable {
    case fiveHours = "5h"
    case week = "7d"
    case month = "30d"
}

public enum NoticeKind: String, Codable, Sendable {
    case limited, available, exhausted, recovered
    case signedOut = "signed-out"
    case resetExpiring = "reset-expiring"
    case quotaUnused = "quota-unused"
    case test
}

/// How a front end colors something, decided by the daemon.
public enum Tone: String, Codable, Sendable {
    case good, muted, accent, warn, bad
}

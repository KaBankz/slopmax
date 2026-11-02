// The status report, as the daemon decides it: every account's condition,
// the notes beside it and their tones, each pool and which account a new
// session would get. The app only formats it.
import Foundation

public struct Report: Codable, Sendable, Equatable {
    public var version: String
    /// From a running proxy, with its live sessions.
    public var live: Bool
    public var generatedAt: Date
    public var strategy: Strategy
    public var accounts: [AccountView]
    public var pools: [PoolView]
    /// What is worth doing before it is lost.
    public var nudges: [Notice]
}

public struct AccountView: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var provider: Provider
    /// Its label, else its email, else its id.
    public var name: String
    public var email: String?
    public var plan: String?
    public var disabled: Bool
    public var priority: Int
    public var pinned: Bool
    public var follows: String?
    public var tokenExpiresAt: Date?
    public var endpoint: String?
    public var models: [String]
    public var sessions: Int
    public var condition: Condition
    public var notes: [Note]
    public var windows: [Window]
    public var resets: [LimitReset]
    public var lastUsed: Date?
    public var served: Usage
}

/// Where an account stands, most pressing first.
public enum Condition: Codable, Sendable, Equatable {
    case signInNeeded(error: String)
    case disabled
    case limited(until: Date)
    case throttled(until: Date?)
    case active(sessions: Int)
    case ready

    private enum Keys: String, CodingKey { case error, until, sessions }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: Keys.self)
        switch try decoder.tag() {
        case "SignInNeeded": self = .signInNeeded(error: try fields.decode(String.self, forKey: .error))
        case "Disabled": self = .disabled
        case "Limited": self = .limited(until: try fields.decode(Date.self, forKey: .until))
        case "Throttled": self = .throttled(until: try fields.decodeIfPresent(Date.self, forKey: .until))
        case "Active": self = .active(sessions: try fields.decode(Int.self, forKey: .sessions))
        case "Ready": self = .ready
        case let other: throw UnknownTag(tag: other, union: "Condition")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: Keys.self)
        switch self {
        case .signInNeeded(let error):
            try encoder.tag("SignInNeeded")
            try fields.encode(error, forKey: .error)
        case .disabled: try encoder.tag("Disabled")
        case .limited(let until):
            try encoder.tag("Limited")
            try fields.encode(until, forKey: .until)
        case .throttled(let until):
            try encoder.tag("Throttled")
            try fields.encodeIfPresent(until, forKey: .until)
        case .active(let sessions):
            try encoder.tag("Active")
            try fields.encode(sessions, forKey: .sessions)
        case .ready: try encoder.tag("Ready")
        }
    }

    public var tone: Tone {
        switch self {
        case .signInNeeded: .bad
        case .disabled: .muted
        case .limited, .throttled: .warn
        case .active, .ready: .good
        }
    }
}

/// A note beside an account's condition.
public enum Note: Codable, Sendable, Equatable {
    case pinned
    case priority(value: Int)
    case follows(tool: String)
    case resets(count: Int)
    case served(requests: Int, tokens: Int)
    case lastError(text: String)

    private enum Keys: String, CodingKey { case value, tool, count, requests, tokens, text }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: Keys.self)
        switch try decoder.tag() {
        case "Pinned": self = .pinned
        case "Priority": self = .priority(value: try fields.decode(Int.self, forKey: .value))
        case "Follows": self = .follows(tool: try fields.decode(String.self, forKey: .tool))
        case "Resets": self = .resets(count: try fields.decode(Int.self, forKey: .count))
        case "Served":
            self = .served(
                requests: try fields.decode(Int.self, forKey: .requests),
                tokens: try fields.decode(Int.self, forKey: .tokens))
        case "LastError": self = .lastError(text: try fields.decode(String.self, forKey: .text))
        case let other: throw UnknownTag(tag: other, union: "Note")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: Keys.self)
        switch self {
        case .pinned: try encoder.tag("Pinned")
        case .priority(let value):
            try encoder.tag("Priority")
            try fields.encode(value, forKey: .value)
        case .follows(let tool):
            try encoder.tag("Follows")
            try fields.encode(tool, forKey: .tool)
        case .resets(let count):
            try encoder.tag("Resets")
            try fields.encode(count, forKey: .count)
        case .served(let requests, let tokens):
            try encoder.tag("Served")
            try fields.encode(requests, forKey: .requests)
            try fields.encode(tokens, forKey: .tokens)
        case .lastError(let text):
            try encoder.tag("LastError")
            try fields.encode(text, forKey: .text)
        }
    }

    public var tone: Tone {
        switch self {
        case .pinned, .resets: .accent
        default: .muted
        }
    }
}

/// A window's use: a warning from 70%, bad from 90%.
public func toneOfUse(_ used: Double) -> Tone {
    used >= 90 ? .bad : used >= 70 ? .warn : .good
}

public struct Window: Codable, Sendable, Equatable {
    public var span: Span
    /// The model it caps, for a window on one model.
    public var model: String?
    /// Percent used, 0 to 100.
    public var used: Double
    public var resetsAt: Date?
}

public struct PoolWindow: Codable, Sendable, Equatable {
    public var span: Span
    public var used: Double
    public var resetsAt: Date?
    public var weighted: Bool
}

public struct LimitReset: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String?
    public var grantedAt: Date?
    public var expiresAt: Date?
}

public struct Usage: Codable, Sendable, Equatable {
    public var requests: Int
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite: Int

    public var tokens: Int { input + output + cacheRead + cacheWrite }
}

public enum NextReason: String, Codable, Sendable {
    case pinned
    case onlyOne = "only-one"
    case weekEnding = "week-ending"
    case resetsFirst = "resets-first"
    case fillsFirst = "fills-first"
    case mostRoom = "most-room"
    case turn
}

public struct NextView: Codable, Sendable, Equatable {
    public var account: String
    public var reason: NextReason
    /// Why, worded for people.
    public var why: String
}

public struct PoolView: Codable, Sendable, Equatable {
    public var provider: Provider
    public var accounts: Int
    public var windows: [PoolWindow]
    public var scoped: [Window]
    public var shares: [String: Double]
    public var next: NextView?
}

public struct Notice: Codable, Sendable, Equatable, Identifiable {
    public var kind: NoticeKind
    /// The same for the same occasion, so a notice is told once.
    public var key: String
    public var provider: Provider?
    public var account: String?
    public var until: Date?
    public var message: String
    public var at: Date
    public var worth: Double?

    public var id: String { key }
}

public enum RedeemOutcome: String, Codable, Sendable {
    case reset
    case nothingToReset = "nothing-to-reset"
    case noCredit = "no-credit"
    case alreadyRedeemed = "already-redeemed"
    case declined
}

public struct RedeemResult: Codable, Sendable, Equatable {
    public var outcome: RedeemOutcome
    public var report: Report
}

public enum Level: String, Codable, Sendable, Comparable {
    case ok, info, warn, fail

    public static func < (a: Level, b: Level) -> Bool {
        let order: [Level] = [.ok, .info, .warn, .fail]
        return order.firstIndex(of: a)! < order.firstIndex(of: b)!
    }
}

public struct Finding: Codable, Sendable, Equatable {
    public var level: Level
    public var text: String
    public var fix: String?
}

public struct Section: Codable, Sendable, Equatable {
    public var title: String
    public var findings: [Finding]
}

public struct AgentWiring: Codable, Sendable, Equatable, Identifiable {
    public var id: AgentId
    public var title: String
    public var installed: Bool
    public var configPath: String
    public var wiredTo: String?
    public var wired: Bool
    public var backedUp: Bool
}

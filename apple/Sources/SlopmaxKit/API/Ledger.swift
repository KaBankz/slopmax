// Usage: requests summed by day, model or account, and the analytics the
// window charts.
import Foundation

public enum Sender: String, Codable, Sendable {
    case claudeCode = "claude-code"
    case codex, slopmax
}

public enum Via: String, Codable, Sendable { case http, socket }

/// One request slopmax answered, or failed to.
public struct RequestRecord: Codable, Sendable, Equatable {
    public var at: Date
    public var account: String?
    public var provider: Provider
    public var model: String?
    public var status: Int
    public var usage: Usage
    public var ms: Int
    public var firstByteMs: Int?
    public var attempts: Int
    public var agent: Sender?
    public var session: String?
    public var via: Via

    public var failed: Bool { status >= 400 }
}

/// A record of the usage ledger: `{"_tag": "Request", …}`.
public enum LedgerRecord: Codable, Sendable, Equatable {
    case request(RequestRecord)

    public init(from decoder: Decoder) throws {
        switch try decoder.tag() {
        case "Request": self = .request(try RequestRecord(from: decoder))
        case let other: throw UnknownTag(tag: other, union: "LedgerRecord")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .request(let record):
            try encoder.tag("Request")
            try record.encode(to: encoder)
        }
    }
}

public enum SummaryRange: String, Codable, Sendable { case today, week = "7d", month = "30d", all }
public enum SummaryBy: String, Codable, Sendable { case day, model, account }
public enum HistoryRange: String, Codable, Sendable, CaseIterable { case today, week = "7d", month = "30d" }

public struct Totals: Codable, Sendable, Equatable {
    public var requests: Int
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite: Int
    /// Dollars at API prices.
    public var cost: Double
    public var unpriced: Int
    public var failed: Int

    public var tokens: Int { input + output + cacheRead + cacheWrite }
}

public struct SummaryRow: Codable, Sendable, Equatable {
    public var key: String
    public var totals: Totals
}

public struct Summary: Codable, Sendable, Equatable {
    public var range: SummaryRange
    public var by: SummaryBy
    public var since: Date
    public var rows: [SummaryRow]
    public var total: Totals
}

public struct LeftAccount: Codable, Sendable, Equatable {
    public var name: String
    public var provider: Provider
    public var windows: Int
    public var unused: Double
    public var dollars: Double
}

public struct LeftOnTheTable: Codable, Sendable, Equatable {
    public var windows: Int
    public var unused: Double
    public var dollars: Double
    public var unpriced: Int
    public var accounts: [LeftAccount]
}

public struct HistoryBucket: Codable, Sendable, Equatable {
    public var label: String
    public var tokens: [Double]
    public var requests: Int
    public var failed: Int
    public var rescued: Int
    public var sessions: Int
    public var cost: Double
    public var cached: Double?
    /// Median and 90th percentile time to first byte, in ms.
    public var firstByte: [Double]?
}

public struct NamedTotals: Codable, Sendable, Equatable {
    public var name: String
    public var totals: Totals
}

public struct AccountTotals: Codable, Sendable, Equatable {
    public var name: String
    public var provider: Provider
    public var totals: Totals
}

public struct Speed: Codable, Sendable, Equatable {
    public var model: String
    public var provider: Provider
    public var tokensPerSecond: Double
}

public struct History: Codable, Sendable, Equatable {
    public var range: HistoryRange
    public var buckets: [HistoryBucket]
    public var providers: [Provider]
    public var total: Totals
    public var rescued: Int
    public var unplaced: Int
    public var billed: Double
    public var left: LeftOnTheTable
    public var cacheSaved: Double
    public var cached: Double?
    public var sessions: Int
    public var firstByte: Double?
    public var monthly: Double?
    /// Requests by weekday (Monday first) and hour.
    public var activity: [[Int]]
    public var models: [NamedTotals]
    public var accounts: [AccountTotals]
    public var agents: [NamedTotals]
    public var speeds: [Speed]
}

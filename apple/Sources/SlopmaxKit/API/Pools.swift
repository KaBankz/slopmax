// A subscription pool over time (`GET /pools/{provider}`): its windows' use
// as recorded and as projected, what each account's current windows have
// served, and how its requests fared by half hour.
import Foundation

public struct TrendPoint: Codable, Sendable, Equatable {
    public var at: Date
    public var used: Double
}

public struct ResetMark: Codable, Sendable, Equatable {
    public var at: Date
    public var account: String
    public var givesBack: Double
}

public struct Burn: Codable, Sendable, Equatable {
    public var hours: Int
    public var rate: Double
}

public struct FirstOut: Codable, Sendable, Equatable {
    public var account: String
    public var at: Date
}

public struct Trend: Codable, Sendable, Equatable {
    public var span: Span
    public var used: Double
    public var recorded: [TrendPoint]
    public var projected: [TrendPoint]
    public var resets: [ResetMark]
    public var burn: Double?
    public var burns: [Burn]
    public var sustainable: Double?
    public var runsOutAt: Date?
    public var dryUntil: Date?
    public var firstOut: FirstOut?
}

public struct WindowSpend: Codable, Sendable, Equatable {
    public var span: Span
    public var since: Date
    public var resetsAt: Date
    public var used: Double
    public var requests: Int
    public var tokens: Int
    public var cost: Double
    public var perPercent: Double?
}

public struct HealthCell: Codable, Sendable, Equatable {
    public var answered: Int
    public var failed: Int
}

public struct AccountDetail: Codable, Sendable, Equatable {
    public var id: String
    public var windows: [WindowSpend]
    public var health: [HealthCell]
}

public struct PoolDetail: Codable, Sendable, Equatable {
    public var provider: Provider
    public var generatedAt: Date
    public var trends: [Trend]
    public var accounts: [AccountDetail]
    public var healthSince: Date
    public var cellMinutes: Int
}

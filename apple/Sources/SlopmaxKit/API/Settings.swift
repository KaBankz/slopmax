// Settings as the API shows them, and the live ones the app changes.
import Foundation

public enum LiveKind: String, Codable, Sendable { case `switch`, minutes, choice }

/// The settings that apply while the proxy runs, by their API names.
public struct LiveSettings: Codable, Sendable, Equatable {
    public var strategy: Strategy
    public var sessionAffinity: Bool
    public var sessionMinutes: Int
    public var redeemExpiring: Bool
    public var redeemWhenExhausted: Bool
    public var warmWindows: Bool
    public var paidOverflow: Bool
    public var pollMinutes: Int
    public var refreshTokens: Bool
    public var websockets: Bool
}

/// Changes to live settings; each left `nil` stays as it is.
public struct LivePatch: Codable, Sendable, Equatable {
    public var strategy: Strategy?
    public var sessionAffinity: Bool?
    public var sessionMinutes: Int?
    public var redeemExpiring: Bool?
    public var redeemWhenExhausted: Bool?
    public var warmWindows: Bool?
    public var paidOverflow: Bool?
    public var pollMinutes: Int?
    public var refreshTokens: Bool?
    public var websockets: Bool?

    public init() {}
}

public struct Price: Codable, Sendable, Equatable {
    public var input: Double
    public var output: Double
    public var cacheRead: Double?
    public var cacheWrite: Double?
}

public struct NotifySettings: Codable, Sendable, Equatable {
    public var webhook: String?
    public var command: String?
    public var events: [NoticeKind]
}

public struct KeyInfo: Codable, Sendable, Equatable, Identifiable {
    public var name: String
    public var models: [String]
    public var id: String { name }
}

/// A key just made: the only time its secret is shown.
public struct NewKey: Codable, Sendable, Equatable {
    public var name: String
    public var key: String
    public var models: [String]
}

/// The settings with no secrets: the live ones beside the rest, flat, as
/// the daemon sends them.
public struct PublicSettings: Codable, Sendable, Equatable {
    public var listen: String
    public var upstreamProxy: String?
    public var live: LiveSettings
    public var aliases: [String: String]
    public var fallbacks: [String: [String]]
    public var prices: [String: Price]
    public var planPrices: [String: Double]
    public var notify: NotifySettings
    public var keys: [KeyInfo]

    private enum Keys: String, CodingKey {
        case listen, upstreamProxy, aliases, fallbacks, prices, planPrices, notify, keys
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: Keys.self)
        listen = try fields.decode(String.self, forKey: .listen)
        upstreamProxy = try fields.decodeIfPresent(String.self, forKey: .upstreamProxy)
        live = try LiveSettings(from: decoder)
        aliases = try fields.decode([String: String].self, forKey: .aliases)
        fallbacks = try fields.decode([String: [String]].self, forKey: .fallbacks)
        prices = try fields.decode([String: Price].self, forKey: .prices)
        planPrices = try fields.decode([String: Double].self, forKey: .planPrices)
        notify = try fields.decode(NotifySettings.self, forKey: .notify)
        keys = try fields.decode([KeyInfo].self, forKey: .keys)
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: Keys.self)
        try fields.encode(listen, forKey: .listen)
        try fields.encodeIfPresent(upstreamProxy, forKey: .upstreamProxy)
        try live.encode(to: encoder)
        try fields.encode(aliases, forKey: .aliases)
        try fields.encode(fallbacks, forKey: .fallbacks)
        try fields.encode(prices, forKey: .prices)
        try fields.encode(planPrices, forKey: .planPrices)
        try fields.encode(notify, forKey: .notify)
        try fields.encode(keys, forKey: .keys)
    }
}

public struct LiveInfo: Codable, Sendable, Equatable {
    public var name: String
    public var summary: String
    public var kind: LiveKind
}

public struct StrategyInfo: Codable, Sendable, Equatable {
    public var id: Strategy
    public var summary: String
}

public struct SettingsView: Codable, Sendable, Equatable {
    public var settings: PublicSettings
    public var live: [LiveInfo]
    public var strategies: [StrategyInfo]
    /// Changed in the file, applied only after a restart.
    public var restartNeeded: [String]
}

// What the app sends, and what comes back from actions.
import Foundation

/// An API key or a compatible endpoint; subscriptions sign in instead.
public enum AddAccount: Encodable, Sendable {
    case key(provider: Provider, key: String, label: String?)
    case endpoint(url: String, dialect: Dialect, models: [String], key: String?, label: String?)

    private enum Keys: String, CodingKey { case provider, key, label, url, dialect, models }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: Keys.self)
        switch self {
        case .key(let provider, let key, let label):
            try encoder.tag("Key")
            try fields.encode(provider, forKey: .provider)
            try fields.encode(key, forKey: .key)
            try fields.encodeIfPresent(label, forKey: .label)
        case .endpoint(let url, let dialect, let models, let key, let label):
            try encoder.tag("Endpoint")
            try fields.encode(url, forKey: .url)
            try fields.encode(dialect, forKey: .dialect)
            try fields.encode(models, forKey: .models)
            try fields.encodeIfPresent(key, forKey: .key)
            try fields.encodeIfPresent(label, forKey: .label)
        }
    }
}

public struct AccountAdded: Codable, Sendable, Equatable {
    public var account: AccountView
    public var report: Report
}

/// Changes to an account. `label: .some(nil)` clears the label.
public struct AccountPatch: Encodable, Sendable {
    public var label: String??
    public var priority: Int?
    public var disabled: Bool?

    public init(label: String?? = nil, priority: Int? = nil, disabled: Bool? = nil) {
        self.label = label
        self.priority = priority
        self.disabled = disabled
    }

    private enum Keys: String, CodingKey { case label, priority, disabled }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: Keys.self)
        if let label {
            switch label {
            case .some(let text): try fields.encode(text, forKey: .label)
            case .none: try fields.encodeNil(forKey: .label)
            }
        }
        try fields.encodeIfPresent(priority, forKey: .priority)
        try fields.encodeIfPresent(disabled, forKey: .disabled)
    }
}

public struct RedeemRequest: Encodable, Sendable {
    public var reset: String?
    public init(reset: String? = nil) { self.reset = reset }
}

public struct StartLogin: Encodable, Sendable {
    public var provider: Provider
    public var device: Bool
    public init(provider: Provider, device: Bool = false) {
        self.provider = provider
        self.device = device
    }
}

public struct LoginStarted: Codable, Sendable, Equatable { public var id: String }

public struct PasteAddress: Encodable, Sendable { public var address: String }

public struct MakeKey: Encodable, Sendable {
    public var name: String
    public var models: [String]
    public init(name: String, models: [String] = []) {
        self.name = name
        self.models = models
    }
}

public struct AgentConnected: Codable, Sendable, Equatable {
    public var path: String
    public var note: String
}

public struct AgentDisconnected: Codable, Sendable, Equatable { public var path: String }

public struct Stopping: Codable, Sendable, Equatable { public var status: String }

public struct Shutdown: Encodable, Sendable {
    public var restart: Bool
    public init(restart: Bool) { self.restart = restart }
}

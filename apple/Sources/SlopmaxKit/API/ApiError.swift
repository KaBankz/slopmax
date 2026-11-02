// The API's errors, each a `_tag`ged body with a message for people.
import Foundation

public enum ApiError: Error, Codable, Sendable, Equatable, CustomStringConvertible {
    case unauthorized(String)
    case notFound(what: String, message: String)
    case badRequest(String)
    case conflict(String)
    case upstreamFailed(String)
    case `internal`(String)
    /// Not one of the API's answers: the daemon is down, or answered
    /// something else.
    case transport(String)

    private enum Keys: String, CodingKey { case message, what }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: Keys.self)
        let message = try fields.decode(String.self, forKey: .message)
        switch try decoder.tag() {
        case "Unauthorized": self = .unauthorized(message)
        case "NotFound": self = .notFound(what: try fields.decode(String.self, forKey: .what), message: message)
        case "BadRequest": self = .badRequest(message)
        case "Conflict": self = .conflict(message)
        case "UpstreamFailed": self = .upstreamFailed(message)
        case "Internal": self = .internal(message)
        case let other: throw UnknownTag(tag: other, union: "ApiError")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: Keys.self)
        switch self {
        case .unauthorized(let message):
            try encoder.tag("Unauthorized")
            try fields.encode(message, forKey: .message)
        case .notFound(let what, let message):
            try encoder.tag("NotFound")
            try fields.encode(what, forKey: .what)
            try fields.encode(message, forKey: .message)
        case .badRequest(let message):
            try encoder.tag("BadRequest")
            try fields.encode(message, forKey: .message)
        case .conflict(let message):
            try encoder.tag("Conflict")
            try fields.encode(message, forKey: .message)
        case .upstreamFailed(let message):
            try encoder.tag("UpstreamFailed")
            try fields.encode(message, forKey: .message)
        case .internal(let message):
            try encoder.tag("Internal")
            try fields.encode(message, forKey: .message)
        case .transport(let message):
            try encoder.tag("Transport")
            try fields.encode(message, forKey: .message)
        }
    }

    public var description: String {
        switch self {
        case .unauthorized(let m), .badRequest(let m), .conflict(let m), .upstreamFailed(let m),
            .internal(let m), .transport(let m):
            m
        case .notFound(_, let message): message
        }
    }
}

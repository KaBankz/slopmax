// How the API's JSON reads and writes: RFC 3339 instants with or without a
// fraction, and tagged unions as `{"_tag": …}`.
import Foundation

public enum Wire {
    /// A decoder for the API's answers.
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = parseInstant(text) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "not an RFC 3339 instant: \(text)"))
            }
            return date
        }
        return decoder
    }

    /// An encoder for what the app sends.
    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatInstant(date))
        }
        return encoder
    }

    /// Reads `2026-11-01T12:00:00Z` and `2026-11-01T12:00:00.213Z` alike.
    public static func parseInstant(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: text) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }

    public static func formatInstant(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

/// The key every tagged union carries.
enum TagKey: String, CodingKey {
    case tag = "_tag"
}

extension Decoder {
    /// The `_tag` of the union being decoded.
    func tag() throws -> String {
        try container(keyedBy: TagKey.self).decode(String.self, forKey: .tag)
    }
}

extension Encoder {
    /// Writes `_tag`, for a union's case to add its fields beside.
    func tag(_ tag: String) throws {
        var container = container(keyedBy: TagKey.self)
        try container.encode(tag, forKey: .tag)
    }
}

/// A union case with no fields, or one whose fields decode as `T`.
struct UnknownTag: Error, CustomStringConvertible {
    let tag: String
    let union: String
    var description: String { "\(union) has no case \(tag)" }
}

// The Rust daemon's answers (contract/fixtures, written by
// crates/slopmax-core/tests/contract.rs), decoded with the app's types.
// Codable passes over keys it does not know, so each answer is also encoded
// again and its keys compared with the fixture's: a field the daemon adds,
// renames or drops fails here instead of going quietly missing.
import Foundation
import Testing
@testable import SlopmaxKit

let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("contract/fixtures")

/// Each endpoint's success, by `group.endpoint`.
let successes: [String: @Sendable (Data) throws -> Data] = [
    "system.status": roundTrip(Report.self),
    "system.sync": roundTrip(Report.self),
    "accounts.update": roundTrip(Report.self),
    "accounts.pin": roundTrip(Report.self),
    "accounts.unpinAll": roundTrip(Report.self),
    "accounts.own": roundTrip(Report.self),
    "accounts.remove": roundTrip(Report.self),
    "config.settings": roundTrip(SettingsView.self),
    "config.change": roundTrip(SettingsView.self),
    "config.keys": roundTrip([KeyInfo].self),
    "config.makeKey": roundTrip(NewKey.self),
    "config.removeKey": roundTrip([KeyInfo].self),
    "usage.summary": roundTrip(Summary.self),
    "usage.history": roundTrip(History.self),
    "events.watch": roundTrip([Event].self),
]

func roundTrip<T: Codable>(_ type: T.Type) -> @Sendable (Data) throws -> Data {
    { data in try Wire.encoder().encode(try Wire.decoder().decode(T.self, from: data)) }
}

/// Every key path in a JSON document: `accounts[].condition._tag`.
func paths(_ value: Any, _ prefix: String = "") -> Set<String> {
    switch value {
    case let object as [String: Any]:
        object.reduce(into: Set<String>()) { all, field in
            let path = prefix.isEmpty ? field.key : "\(prefix).\(field.key)"
            all.insert(path)
            // Maps keyed by data (account ids, model names) are not schema.
            if ["shares", "aliases", "fallbacks", "prices", "planPrices"].contains(field.key) { return }
            all.formUnion(paths(field.value, path))
        }
    case let array as [Any]:
        array.reduce(into: Set<String>()) { all, item in all.formUnion(paths(item, prefix + "[]")) }
    default:
        []
    }
}

struct Fixture: CustomStringConvertible, Sendable {
    let name: String
    var description: String { name }
}

let names: [Fixture] = (try? FileManager.default.contentsOfDirectory(atPath: fixtures.path))?
    .filter { $0.hasSuffix(".json") }.sorted().map { Fixture(name: $0) } ?? []

@Test func everyFixtureIsHere() {
    #expect(names.count > 20)
}

@Test(arguments: names)
func decodesStrictly(_ fixture: Fixture) throws {
    let parts = fixture.name.replacingOccurrences(of: ".json", with: "").split(separator: ".").map(String.init)
    let whole = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent(fixture.name)))
    let file = try #require(whole as? [String: Any])
    let body = try JSONSerialization.data(withJSONObject: file["body"]!, options: [.fragmentsAllowed])
    let again: Data
    if parts[2] == "ok" {
        let decode = try #require(successes["\(parts[0]).\(parts[1])"], "no type for \(fixture)")
        again = try decode(body)
    } else {
        let error = try Wire.decoder().decode(ApiError.self, from: body)
        #expect("\(error)".isEmpty == false)
        again = try Wire.encoder().encode(error)
    }
    let held = paths(try JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]))
    let read = paths(try JSONSerialization.jsonObject(with: again, options: [.fragmentsAllowed]))
    #expect(held == read, "only in the fixture: \(held.subtracting(read).sorted()); only in Swift: \(read.subtracting(held).sorted())")
}

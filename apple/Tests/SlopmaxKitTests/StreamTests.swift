import Foundation
import Testing
@testable import SlopmaxKit

@Test func eventsSplitAcrossChunksComeOutWhole() {
    var reader = SSEReader()
    let stream = "data: {\"_tag\":\"Ping\"}\r\n\r\n: a comment\n\ndata: one\ndata: two\n\nevent: x\ndata: last\n\n"
    let bytes = Array(stream.utf8)
    // Every way of cutting it in two gives the same events.
    for cut in 0...bytes.count {
        var reader = SSEReader()
        let events = reader.feed(Data(bytes[..<cut])) + reader.feed(Data(bytes[cut...]))
        #expect(events == ["{\"_tag\":\"Ping\"}", "one\ntwo", "last"], "cut at \(cut)")
    }
    #expect(reader.feed(Data("data: open".utf8)).isEmpty)
}

@MainActor
@Test func theStoreFollowsTheStream() throws {
    let store = Store()
    #expect(store.menuTitle == "–")
    let status = try Wire.decoder().decode(
        Report.self,
        from: Data("""
            {"version":"0.4.0","live":true,"generatedAt":"2026-11-01T12:00:00Z","strategy":"reset-first",
             "accounts":[{"id":"a","provider":"claude","name":"a@x","disabled":false,"priority":0,"pinned":false,
               "models":[],"sessions":0,"condition":{"_tag":"SignInNeeded","error":"revoked"},"notes":[],
               "windows":[],"resets":[],"served":{"requests":0,"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}],
             "pools":[{"provider":"claude","accounts":1,"windows":[{"span":"5h","used":41.6,"weighted":false},
               {"span":"7d","used":72.4,"weighted":false}],"scoped":[],"shares":{}}],"nudges":[]}
            """.utf8))
    store.apply(.event(.hello(version: "0.4.0", exe: "/Applications/Slopmax.app/Contents/MacOS/slopmax")))
    store.apply(.event(.status(status)))
    #expect(store.connected)
    #expect(store.menuTitle == "72%")
    #expect(store.attention.map(\.id) == ["a"])
    #expect(store.daemonVersion == "0.4.0")
    let record = RequestRecord(
        at: .now, account: "a", provider: .claude, model: "claude-opus-5-5", status: 200,
        usage: .init(requests: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0), ms: 10, firstByteMs: 5,
        attempts: 1, agent: .claudeCode, session: nil, via: .http)
    for _ in 0..<(Store.recentRequests + 5) { store.apply(.event(.request(record))) }
    #expect(store.requests.count == Store.recentRequests)
    store.apply(.disconnected(retryIn: 2))
    #expect(!store.connected && store.retryIn == 2)
    #expect(store.menuTitle == "–")
}

@Test func onlyTheBundledDaemonIsManaged() {
    let cli = URL(fileURLWithPath: "/Applications/Slopmax.app/Contents/MacOS/slopmax")
    #expect(DaemonLocator.manages(exe: "/Applications/Slopmax.app/Contents/MacOS/slopmax", cli: cli))
    #expect(!DaemonLocator.manages(exe: "/opt/homebrew/bin/slopmax", cli: cli))
    #expect(!DaemonLocator.manages(exe: nil, cli: cli))
}

/// Against a running daemon, when told where: the client reads every
/// answer it asks for, and the stream says hello and reports.
@Test(.enabled(if: ProcessInfo.processInfo.environment["SLOPMAX_LOOPBACK_BASE"] != nil))
func talksToARunningDaemon() async throws {
    let environment = ProcessInfo.processInfo.environment
    let daemon = Daemon(base: URL(string: environment["SLOPMAX_LOOPBACK_BASE"]!)!, key: environment["SLOPMAX_LOOPBACK_KEY"] ?? "")
    let client = Client(daemon)
    let report = try await client.status()
    #expect(!report.accounts.isEmpty)
    _ = try await client.settings()
    _ = try await client.keys()
    _ = try await client.history(.week)
    _ = try await client.usage(.month, by: .model)
    do {
        _ = try await client.update("no-such-account", AccountPatch(label: .some(nil)))
        Issue.record("an unknown account was updated")
    } catch {
        #expect(error == .notFound(what: "account", message: "no such account"))
    }
    let stream = EventStream(daemon)
    var seen: [String] = []
    for await followed in stream.follow() {
        guard case .event(let event) = followed else { continue }
        switch event {
        case .hello: seen.append("hello")
        case .status: seen.append("status")
        default: break
        }
        if seen.count == 2 { break }
    }
    stream.stop()
    #expect(seen == ["hello", "status"])
}

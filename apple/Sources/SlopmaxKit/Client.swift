// The daemon's API, one method per endpoint. Every call carries the owner
// key; every failure is an ApiError worded for people.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Where the daemon listens and the key it takes.
public struct Daemon: Sendable, Equatable {
    public var base: URL
    public var key: String

    public init(base: URL, key: String) {
        self.base = base
        self.key = key
    }

    /// `path` under the API's prefix.
    func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = "/slopmax/api" + path
        if !query.isEmpty { components.queryItems = query }
        return components.url!
    }
}

public final class Client: Sendable {
    public let daemon: Daemon
    let session: URLSession

    public init(_ daemon: Daemon, session: URLSession = .shared) {
        self.daemon = daemon
        self.session = session
    }

    // MARK: System

    public func status() async throws(ApiError) -> Report { try await call("GET", "/status") }
    public func refresh() async throws(ApiError) -> Report { try await call("POST", "/refresh") }
    public func sync() async throws(ApiError) -> Report { try await call("POST", "/sync") }
    public func doctor() async throws(ApiError) -> [Section] { try await call("GET", "/doctor") }

    /// Stops the daemon; with `restart`, so its service manager starts it
    /// again (after an update).
    public func shutdown(restart: Bool = false) async throws(ApiError) -> Stopping {
        try await call("POST", "/shutdown", body: Shutdown(restart: restart))
    }

    // MARK: Accounts

    public func add(_ account: AddAccount) async throws(ApiError) -> AccountAdded {
        try await call("POST", "/accounts", body: account)
    }

    public func update(_ id: String, _ patch: AccountPatch) async throws(ApiError) -> Report {
        try await call("PATCH", "/accounts/\(escaped(id))", body: patch)
    }

    public func pin(_ id: String) async throws(ApiError) -> Report { try await call("POST", "/accounts/\(escaped(id))/pin") }
    public func unpinAll() async throws(ApiError) -> Report { try await call("DELETE", "/pins") }
    public func own(_ id: String) async throws(ApiError) -> Report { try await call("POST", "/accounts/\(escaped(id))/own") }
    public func remove(_ id: String) async throws(ApiError) -> Report { try await call("DELETE", "/accounts/\(escaped(id))") }

    public func redeem(_ id: String, reset: String? = nil) async throws(ApiError) -> RedeemResult {
        try await call("POST", "/accounts/\(escaped(id))/redeem", body: RedeemRequest(reset: reset))
    }

    // MARK: Sign-ins

    /// Starts a sign-in; its progress arrives as `.login` events.
    public func startLogin(_ provider: Provider, device: Bool = false) async throws(ApiError) -> LoginStarted {
        try await call("POST", "/logins", body: StartLogin(provider: provider, device: device))
    }

    public func paste(login id: String, address: String) async throws(ApiError) {
        let _: Empty = try await call("POST", "/logins/\(escaped(id))/paste", body: PasteAddress(address: address))
    }

    public func cancel(login id: String) async throws(ApiError) {
        let _: Empty = try await call("DELETE", "/logins/\(escaped(id))")
    }

    // MARK: Settings and keys

    public func settings() async throws(ApiError) -> SettingsView { try await call("GET", "/settings") }

    public func change(_ patch: LivePatch) async throws(ApiError) -> SettingsView {
        try await call("PATCH", "/settings", body: patch)
    }

    public func keys() async throws(ApiError) -> [KeyInfo] { try await call("GET", "/keys") }

    public func makeKey(_ name: String, models: [String] = []) async throws(ApiError) -> NewKey {
        try await call("POST", "/keys", body: MakeKey(name: name, models: models))
    }

    public func removeKey(_ name: String) async throws(ApiError) -> [KeyInfo] {
        try await call("DELETE", "/keys/\(escaped(name))")
    }

    // MARK: Agents, usage, notifications

    public func agents() async throws(ApiError) -> [AgentWiring] { try await call("GET", "/agents") }

    public func connect(_ agent: AgentId) async throws(ApiError) -> AgentConnected {
        try await call("POST", "/agents/\(agent.rawValue)/connect")
    }

    public func disconnect(_ agent: AgentId) async throws(ApiError) -> AgentDisconnected {
        try await call("POST", "/agents/\(agent.rawValue)/disconnect")
    }

    public func usage(_ range: SummaryRange = .week, by: SummaryBy = .day) async throws(ApiError) -> Summary {
        try await call("GET", "/usage", query: [.init(name: "range", value: range.rawValue), .init(name: "by", value: by.rawValue)])
    }

    public func history(_ range: HistoryRange = .week) async throws(ApiError) -> History {
        try await call("GET", "/history", query: [.init(name: "range", value: range.rawValue)])
    }

    public func testNotification() async throws(ApiError) {
        let _: Empty = try await call("POST", "/notify/test")
    }

    // MARK: Plumbing

    /// An answer with no body.
    struct Empty: Decodable {}

    private struct Nothing: Encodable {}

    func call<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = []) async throws(ApiError) -> T {
        try await call(method, path, query: query, body: Nothing?.none)
    }

    func call<T: Decodable, B: Encodable>(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: B?
    ) async throws(ApiError) -> T {
        var request = URLRequest(url: daemon.url(path, query: query))
        request.httpMethod = method
        request.setValue("Bearer \(daemon.key)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30
        if let body {
            do {
                request.httpBody = try Wire.encoder().encode(body)
            } catch {
                throw .transport("encoding the request: \(error)")
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw .transport("slopmax is not answering at \(daemon.base.absoluteString)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let decoder = Wire.decoder()
        guard (200..<300).contains(status) else {
            throw (try? decoder.decode(ApiError.self, from: data)) ?? .transport("slopmax answered \(status)")
        }
        if T.self == Empty.self, let empty = Empty() as? T { return empty }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw .transport("an answer this app cannot read (\(error)); is the app older than the daemon?")
        }
    }

    private func escaped(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(.init(charactersIn: "/"))) ?? segment
    }
}

// The app's state, fed by the event stream: views read it, actions go
// through the client, and the next Status event brings their effect.
import Foundation
import Observation

@MainActor
@Observable
public final class Store {
    public private(set) var report: Report?
    public private(set) var connected = false
    /// When the stream dropped, and when it tries again.
    public private(set) var retryIn: Double?
    public private(set) var daemonVersion: String?
    public private(set) var daemonExe: String?
    /// The latest requests, newest first.
    public private(set) var requests: [RequestRecord] = []
    /// Notices told on this connection, newest first.
    public private(set) var notices: [Notice] = []
    /// Sign-ins in progress, by id: their latest step.
    public private(set) var logins: [String: LoginEvent] = [:]
    /// What the last action said went wrong, for the window to show.
    public var problem: String?

    /// How many recent requests are kept.
    public static let recentRequests = 50

    public init() {}

    /// Folds one event in.
    public func apply(_ followed: Followed) {
        switch followed {
        case .disconnected(let wait):
            connected = false
            retryIn = wait
        case .event(let event):
            connected = true
            retryIn = nil
            switch event {
            case .hello(let version, let exe):
                daemonVersion = version
                daemonExe = exe
            case .status(let report): self.report = report
            case .request(let record):
                requests.insert(record, at: 0)
                if requests.count > Self.recentRequests { requests.removeLast() }
            case .notice(let notice):
                if !notices.contains(where: { $0.key == notice.key }) { notices.insert(notice, at: 0) }
            case .login(let id, let event):
                logins[id] = event
            case .ping: break
            }
        }
    }

    /// The report an action answered with, until the stream's next one.
    public func adopt(_ report: Report) {
        self.report = report
    }

    public func forget(login id: String) {
        logins[id] = nil
    }

    // MARK: What the menu bar shows

    /// The fullest shared window across the subscription pools, for the
    /// menu bar's title.
    public var fullest: (provider: Provider, window: PoolWindow)? {
        let windows = (report?.pools ?? []).flatMap { pool in pool.windows.map { (pool.provider, $0) } }
        return windows.max { $0.1.used < $1.1.used }.map { (provider: $0.0, window: $0.1) }
    }

    /// The menu bar's text: the fullest pool window's use, or a dash while
    /// the daemon is away.
    public var menuTitle: String {
        guard connected, let fullest else { return "–" }
        return "\(Int(fullest.window.used.rounded()))%"
    }

    /// Accounts that need a person: signed out, the worst first.
    public var attention: [AccountView] {
        (report?.accounts ?? []).filter {
            if case .signInNeeded = $0.condition { return true }
            return false
        }
    }
}

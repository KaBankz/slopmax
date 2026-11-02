// The app's side of the daemon: where it is, keeping it running, following
// its events, and the actions the views take.
import Foundation
import Observation
import SlopmaxKit

@MainActor
@Observable
final class AppModel {
    let store = Store()
    private(set) var info: DaemonInfo?
    private(set) var client: Client?
    /// Why the daemon cannot be reached, when it cannot.
    private(set) var unreachable: String?
    private var stream: EventStream?
    private var following: Task<Void, Never>?

    /// The CLI inside the bundle, which is the daemon too.
    let cli = Bundle.main.url(forAuxiliaryExecutable: "slopmax")
        ?? URL(fileURLWithPath: "/usr/local/bin/slopmax")

    init() {
        Task { await start() }
    }

    /// Finds the daemon, starts it at login if it is not yet, and follows it.
    func start() async {
        do {
            LoginItems.registerDaemon()
            let info = try DaemonLocator.locate(cli: cli)
            self.info = info
            let client = Client(info.daemon)
            self.client = client
            follow(info.daemon)
            unreachable = nil
        } catch {
            unreachable = "The bundled slopmax could not be run: \(error.localizedDescription)"
        }
    }

    private func follow(_ daemon: Daemon) {
        following?.cancel()
        stream?.stop()
        let stream = EventStream(daemon)
        self.stream = stream
        following = Task { [store, cli] in
            for await followed in stream.follow() {
                store.apply(followed)
                if case .event(.notice(let notice)) = followed { Notifier.post(notice) }
                if case .event(.hello(let version, let exe)) = followed,
                    let bundled = self.info?.version, version != bundled,
                    DaemonLocator.manages(exe: exe, cli: cli)
                {
                    // An update brought a new daemon: restart the old one,
                    // which launchd starts again at once from the new binary.
                    _ = try? await self.client?.shutdown(restart: true)
                }
            }
        }
    }

    /// Runs an action, keeping its report and saying what went wrong.
    func act(_ action: @escaping @Sendable (Client) async throws -> Report) async {
        guard let client else { return }
        do {
            store.adopt(try await action(client))
            store.problem = nil
        } catch let error as ApiError {
            store.problem = error.description
        } catch {
            store.problem = "\(error)"
        }
    }

    func refresh() async { await act { try await $0.refresh() } }
}

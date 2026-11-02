// The menu bar's window: each pool at a glance, who needs attention, and
// the way into the main window.
import SlopmaxKit
import SwiftUI

struct MenuView: View {
    @Environment(AppModel.self) private var model
    @Environment(Store.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !store.connected {
                Label(
                    store.retryIn.map { "slopmax is not answering; trying again in \(Int($0))s" }
                        ?? (model.unreachable ?? "Connecting to slopmax…"),
                    systemImage: "bolt.horizontal.circle")
                .foregroundStyle(.secondary)
            }
            ForEach(store.report?.pools ?? [], id: \.provider) { pool in
                PoolSummary(pool: pool, accounts: store.report?.accounts ?? [])
            }
            if !store.attention.isEmpty {
                Divider()
                ForEach(store.attention) { account in
                    Label("\(account.name) needs signing in again", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                }
            }
            if let problem = store.problem {
                Text(problem).font(.caption).foregroundStyle(.red)
            }
            Divider()
            HStack {
                Button("Open slopmax") {
                    openWindow(id: "main")
                    NSApp.activate()
                }
                Spacer()
                Button("Refresh") { Task { await model.refresh() } }
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .padding(14)
        .frame(width: 320)
    }
}

/// A pool's windows, and the account a new session would get.
struct PoolSummary: View {
    let pool: PoolView
    let accounts: [AccountView]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(pool.provider.title).font(.headline)
                Spacer()
                Text(pool.accounts == 1 ? "1 account" : "\(pool.accounts) accounts")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(pool.windows, id: \.span) { window in
                WindowGauge(title: window.span.label, used: window.used, resetsAt: window.resetsAt)
            }
            if let next = pool.next, let account = accounts.first(where: { $0.id == next.account }) {
                Text("Next session: \(account.name) — \(next.why)")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

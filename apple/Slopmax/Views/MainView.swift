// The main window: a sidebar of sections, each a view over the store.
import SlopmaxKit
import SwiftUI

enum Page: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case accounts = "Accounts"
    case usage = "Usage"
    case requests = "Requests"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .overview: "gauge.with.dots.needle.50percent"
        case .accounts: "person.2"
        case .usage: "chart.bar"
        case .requests: "list.bullet.rectangle"
        }
    }
}

struct MainView: View {
    @Environment(Store.self) private var store
    @State private var page: Page = .overview

    var body: some View {
        NavigationSplitView {
            List(Page.allCases, selection: $page) { page in
                Label(page.rawValue, systemImage: page.symbol).tag(page)
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
        } detail: {
            Group {
                switch page {
                case .overview: OverviewView()
                case .accounts: AccountsView()
                case .usage: UsageView()
                case .requests: RequestsView()
                }
            }
            .navigationTitle(page.rawValue)
        }
    }
}

struct OverviewView: View {
    @Environment(Store.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let report = store.report {
                    ForEach(report.pools, id: \.provider) { pool in
                        GroupBox { PoolSummary(pool: pool, accounts: report.accounts).padding(4) }
                    }
                    if !report.nudges.isEmpty {
                        GroupBox("Worth doing") {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(report.nudges) { nudge in
                                    Label(nudge.message, systemImage: "lightbulb").font(.callout)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                } else {
                    ContentUnavailableView("Connecting to slopmax", systemImage: "bolt.horizontal.circle")
                }
            }
            .padding(20)
        }
    }
}

struct RequestsView: View {
    @Environment(Store.self) private var store

    var body: some View {
        Table(store.requests.enumerated().map { RequestRow(index: $0.offset, record: $0.element) }) {
            TableColumn("When") { row in Text(row.record.at, style: .time) }
            TableColumn("Model") { row in Text(row.record.model ?? "–") }
            TableColumn("Status") { row in
                Text("\(row.record.status)").foregroundStyle(row.record.failed ? .red : .primary)
            }
            TableColumn("Tokens") { row in Text(row.record.usage.tokens.formatted(.number.notation(.compactName))) }
            TableColumn("Time") { row in Text(Duration.milliseconds(row.record.ms).formatted(.units(width: .narrow))) }
        }
        .overlay {
            if store.requests.isEmpty {
                ContentUnavailableView("No requests yet", systemImage: "tray", description: Text("Requests show here as they are answered."))
            }
        }
    }
}

struct RequestRow: Identifiable {
    let index: Int
    let record: RequestRecord
    var id: Int { index }
}

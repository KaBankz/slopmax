// What went through slopmax: tokens by day and provider, with Swift Charts.
import Charts
import SlopmaxKit
import SwiftUI

struct UsageView: View {
    @Environment(AppModel.self) private var model
    @Environment(Store.self) private var store
    @State private var range: HistoryRange = .week
    @State private var history: History?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Picker("Range", selection: $range) {
                    Text("Today").tag(HistoryRange.today)
                    Text("7 days").tag(HistoryRange.week)
                    Text("30 days").tag(HistoryRange.month)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 320)
                if let history {
                    HStack(spacing: 28) {
                        Figure(title: "Requests", value: history.total.requests.formatted())
                        Figure(title: "Tokens", value: history.total.tokens.formatted(.number.notation(.compactName)))
                        Figure(title: "API value", value: history.total.cost.formatted(.currency(code: "USD")))
                        Figure(title: "Saved by failover", value: history.rescued.formatted())
                    }
                    Chart {
                        ForEach(Array(history.buckets.enumerated()), id: \.offset) { _, bucket in
                            ForEach(Array(history.providers.enumerated()), id: \.offset) { index, provider in
                                BarMark(
                                    x: .value("When", bucket.label),
                                    y: .value("Tokens", index < bucket.tokens.count ? bucket.tokens[index] : 0)
                                )
                                .foregroundStyle(by: .value("Provider", provider.title))
                            }
                        }
                    }
                    .frame(height: 240)
                } else {
                    ProgressView()
                }
            }
            .padding(20)
        }
        // Reloaded on a new range, and as requests are answered.
        .task(id: "\(range.rawValue)-\(store.requests.count / 10)") {
            history = try? await model.client?.history(range)
        }
    }
}

struct Figure: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title2.monospacedDigit())
        }
    }
}

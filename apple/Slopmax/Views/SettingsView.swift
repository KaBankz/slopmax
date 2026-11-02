// The live settings, as the daemon lists them: each change is written to
// config.toml (keeping its comments) and applies at once.
import SlopmaxKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var view: SlopmaxKit.SettingsView?
    @State private var problem: String?
    @State private var opensAtLogin = LoginItems.appOpensAtLogin

    var body: some View {
        Form {
            if let live = view?.settings.live {
                Picker("Strategy", selection: binding(live.strategy) { $0.strategy = $1 }) {
                    ForEach(view?.strategies ?? [], id: \.id) { strategy in
                        Text(strategy.id.rawValue).tag(strategy.id)
                    }
                }
                Toggle("Keep a session on its account", isOn: binding(live.sessionAffinity) { $0.sessionAffinity = $1 })
                Stepper(
                    "Forget a session after \(live.sessionMinutes) idle minutes",
                    value: binding(live.sessionMinutes) { $0.sessionMinutes = $1 }, in: 1...1440, step: 5)
                Toggle("Redeem limit resets before they expire", isOn: binding(live.redeemExpiring) { $0.redeemExpiring = $1 })
                Toggle("Redeem one when every account is spent", isOn: binding(live.redeemWhenExhausted) { $0.redeemWhenExhausted = $1 })
                Toggle("Let API keys take over once subscriptions are limited", isOn: binding(live.paidOverflow) { $0.paidOverflow = $1 })
                Toggle("Refresh sign-ins before they expire", isOn: binding(live.refreshTokens) { $0.refreshTokens = $1 })
                Toggle("Relay Codex's WebSockets", isOn: binding(live.websockets) { $0.websockets = $1 })
            } else {
                ProgressView()
            }
            Toggle("Open slopmax at login", isOn: $opensAtLogin)
                .onChange(of: opensAtLogin) { _, on in LoginItems.appOpensAtLogin = on }
            if let problem { Text(problem).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .task { view = try? await model.client?.settings() }
    }

    /// A control's value, sent to the daemon as a one-setting patch when it
    /// changes.
    private func binding<T>(_ value: T, _ set: @escaping (inout LivePatch, T) -> Void) -> Binding<T> {
        Binding(
            get: { value },
            set: { new in
                var patch = LivePatch()
                set(&patch, new)
                Task {
                    do {
                        view = try await model.client?.change(patch)
                        problem = nil
                    } catch {
                        problem = "\(error)"
                    }
                }
            })
    }
}

// Every account: its condition and notes as the daemon decided them, its
// windows, and what can be done to it.
import SlopmaxKit
import SwiftUI

struct AccountsView: View {
    @Environment(AppModel.self) private var model
    @Environment(Store.self) private var store
    @State private var signingIn: Provider?

    var body: some View {
        List {
            ForEach(Provider.allCases, id: \.self) { provider in
                let accounts = (store.report?.accounts ?? []).filter { $0.provider == provider }
                if !accounts.isEmpty {
                    Section(provider.title) {
                        ForEach(accounts) { account in AccountRow(account: account) }
                    }
                }
            }
        }
        .toolbar {
            Menu("Add Account", systemImage: "plus") {
                Button("Claude") { signingIn = .claude }
                Button("ChatGPT") { signingIn = .codex }
            }
        }
        .sheet(item: $signingIn) { provider in SignInSheet(provider: provider) }
    }
}

struct AccountRow: View {
    @Environment(AppModel.self) private var model
    let account: AccountView

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(account.name).font(.headline)
                if let plan = account.plan { Text(plan).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Label(account.condition.label, systemImage: account.condition.symbol)
                    .foregroundStyle(account.condition.tone.color)
            }
            HStack(spacing: 16) {
                ForEach(Array(account.windows.enumerated()), id: \.offset) { _, window in
                    WindowGauge(
                        title: window.model.map { "\(window.span.label) · \($0)" } ?? window.span.label,
                        used: window.used, resetsAt: window.resetsAt
                    )
                    .frame(maxWidth: 180)
                }
            }
            if !account.notes.isEmpty {
                HStack(spacing: 10) {
                    ForEach(Array(account.notes.enumerated()), id: \.offset) { _, note in
                        Text(note.label).font(.caption).foregroundStyle(note.tone.color)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .contextMenu {
            let id = account.id
            Button(account.pinned ? "Unpin" : "Use for New Sessions") {
                Task { await model.act { account.pinned ? try await $0.unpinAll() : try await $0.pin(id) } }
            }
            Button(account.disabled ? "Enable" : "Disable") {
                let disabled = !account.disabled
                Task { await model.act { try await $0.update(id, AccountPatch(disabled: disabled)) } }
            }
            if !account.resets.isEmpty {
                Button("Redeem a Limit Reset") { Task { await model.act { try await $0.redeem(id).report } } }
            }
            if account.follows != nil {
                Button("Refresh It Here Instead") { Task { await model.act { try await $0.own(id) } } }
            }
            Divider()
            Button("Remove", role: .destructive) { Task { await model.act { try await $0.remove(id) } } }
        }
    }
}

/// Signing in to a subscription: the daemon runs the sign-in and its
/// progress arrives on the event stream.
struct SignInSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let provider: Provider
    @State private var login: String?
    @State private var pasted = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Sign in to \(provider.title)").font(.title2)
            switch login.flatMap({ store.logins[$0] }) {
            case .authorize(_, let url, _, let opened)?:
                Text(opened ? "Finish signing in in your browser." : "Open this address to sign in:")
                Link(url.absoluteString, destination: url).lineLimit(2)
                TextField("Or paste the address the browser ended on", text: $pasted)
                    .onSubmit {
                        guard let login else { return }
                        Task { try? await model.client?.paste(login: login, address: pasted) }
                    }
            case .deviceCode(let url, let code)?:
                Text("Enter this code at \(url.absoluteString)")
                Text(code).font(.system(.largeTitle, design: .monospaced)).textSelection(.enabled)
            case .note(let text)?: Text(text)
            case .done(let account, _)?:
                Label("\(account.name) is signed in.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            case .failed(let message)?:
                Label(message, systemImage: "xmark.octagon").foregroundStyle(.red)
            case nil:
                ProgressView("Starting…")
            }
            HStack {
                Spacer()
                Button(isDone ? "Done" : "Cancel") {
                    if let login, !isDone { Task { try? await model.client?.cancel(login: login) } }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 440)
        .task {
            login = try? await model.client?.startLogin(provider).id
        }
    }

    private var isDone: Bool {
        switch login.flatMap({ store.logins[$0] }) {
        case .done?, .failed?: true
        default: false
        }
    }
}

// slopmax for macOS: a menu bar item and a window over the daemon, which
// is the bundled CLI run as a login agent. Everything the app shows comes
// from the daemon's event stream; everything it does is an API call.
import SlopmaxKit
import SwiftUI

@main
struct SlopmaxApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuView()
                .environment(model)
                .environment(model.store)
        } label: {
            MenuLabel(store: model.store)
        }
        .menuBarExtraStyle(.window)

        Window("slopmax", id: "main") {
            MainView()
                .environment(model)
                .environment(model.store)
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 960, height: 640)
        .commands { SlopmaxCommands(model: model) }

        Settings {
            SettingsView()
                .environment(model)
                .environment(model.store)
                .frame(width: 520)
        }
    }
}

/// The menu bar's item: the fullest pool window's use, colored by the
/// daemon's tone for it.
struct MenuLabel: View {
    let store: Store

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: store.connected ? "gauge.with.dots.needle.50percent" : "gauge.with.dots.needle.0percent")
            Text(store.menuTitle).monospacedDigit()
        }
    }
}

struct SlopmaxCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Refresh Usage") { Task { await model.refresh() } }
                .keyboardShortcut("r")
        }
    }
}

# slopmax for macOS

A menu bar item and a window over the slopmax daemon. The daemon is the CLI inside the bundle,
run at login as a launch agent (`SMAppService`); the app is only a client of its API
(`/slopmax/api`): it shows what the event stream says and calls the API to act. Every decision it
shows (an account's condition, its tone, which account a new session would get) is the daemon's;
the app formats it.

- `Sources/SlopmaxKit` — everything but drawing, on Foundation alone: the API's types, the client,
  the event stream (with reconnects), the store the views read, finding the daemon. It builds and
  its tests run on Linux too.
- `Tests/SlopmaxKitTests` — the contract (every fixture in `../contract/fixtures` decoded, encoded
  again and its keys compared, so a field the daemon adds or drops fails here), the stream reader,
  the store, and with `SLOPMAX_LOOPBACK_BASE`/`SLOPMAX_LOOPBACK_KEY` set, a running daemon.
- `Slopmax` — the SwiftUI app: `MenuBarExtra`, the main window, settings, sign-in, notifications.
- `LaunchAgents/dev.slopmax.agent.plist` — the daemon's agent: `Contents/MacOS/slopmax serve`,
  started again after it exits 75 (`/shutdown {"restart": true}`, after an update).

```sh
swift test                                      # SlopmaxKit, on macOS or Linux
cargo build --release -p slopmax                # the CLI the app bundles (from the repository root)
mise x xcodegen -- xcodegen                     # Slopmax.xcodeproj
xcodebuild -scheme Slopmax -configuration Release build
```

Releases sign the CLI and then the app with a Developer ID (hardened runtime, no entitlements, not
sandboxed), notarize with `notarytool submit --wait`, and staple.

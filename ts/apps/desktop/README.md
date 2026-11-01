# slopmax-desktop

The desktop app: an Electron shell around the proxy. The daemon is the app's
engine, so the app holds no engine of its own. Its main process starts the
proxy with the CLI it ships, follows it over the daemon's event stream, and
serves the window from `app://slopmax/`. The window is the same React app as the
web dashboard (`apps/ui`, desktop build), and its calls to `/slopmax/api/*`
are passed to the daemon with the owner key, which only main holds. Closing
the window leaves the tray running, and the proxy outlives the app.

```
renderer (apps/ui desktop build, app://slopmax/)
   │  fetch /slopmax/api/* (same origin)          window.slopmaxDesktop (src/preload.ts)
   ▼                                                 ▼
Electron main: protocol, window, panel, tray, menus, notifications, prefs
   │  HTTP + SSE to the daemon (key added here)      the bundled CLI: start/stop --json, status/doctor --json, service …
   ▼
slopmax serve (the AOT Bun binary in resources/bin), or the login service running it
```

## Layout

| File                        | What it does                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/main.ts`          | Lifecycle: one instance (a second launch shows the window, or with `--panel` the panel), no GPU process, the network service in process, the `app://` scheme, quitting only on Quit. The only module that loads `electron`; the rest is layers. |
| `src/main/cli.ts`           | `Cli`: finds the CLI (`resources/bin`, beside the executable, `PATH`, or `SLOPMAX_CLI`) and runs it, decoding what `--json` prints with the domain's schemas.                                                                                   |
| `src/main/engine.ts`        | `Engine`: the proxy's state (`ProxyState` in a `SubscriptionRef`), where it runs and its key, launch, start/stop/restart, the login service, the release check, the offline view.                                                               |
| `src/main/events.ts`        | `Follower`: the daemon's event stream through `HttpApiClient`, with the reconnect schedule; reports for the tray, notices for notifications.                                                                                                    |
| `src/main/protocol.ts`      | `app://slopmax/`: the UI's files with a CSP, and `/slopmax/api/*` passed to the daemon with `net.fetch`, streaming, the key added; 503 while it is down.                                                                                        |
| `src/main/window.ts`        | `MainWindow`: 1160 × 800 (at least 880 × 560), where it was last, pinned to the app's origin, destroyed on close.                                                                                                                               |
| `src/main/panel.ts`         | `Panel`: the 340-wide frameless panel at `#/panel`, placed under the tray icon, fitted to its content, closed on Escape, on blur and when the window comes forward.                                                                             |
| `src/main/tray.ts`          | `AppTray`: the title (macOS), tooltip, and the Linux menu.                                                                                                                                                                                      |
| `src/main/menus.ts`         | The application menu and its keys, Cmd on macOS and Ctrl elsewhere.                                                                                                                                                                             |
| `src/main/notifications.ts` | `Notifications`: notices posted as the system's notifications, one per key.                                                                                                                                                                     |
| `src/main/prefs.ts`         | `Prefs`: `userData/prefs.json` (window bounds, sidebar, appearance, notifications), defaults on any error.                                                                                                                                      |
| `src/main/bridge.ts`        | The preload API's handlers; every argument is decoded with `@slopmax/domain/desktop`'s schemas, and only the app's own pages are heard.                                                                                                         |
| `src/preload.ts`            | `window.slopmaxDesktop`, built as CommonJS for the sandbox.                                                                                                                                                                                     |
| `build.ts`                  | `Bun.build`: `out/main.js` (ESM), `out/preload.cjs`, `out/ui/` (the UI's desktop build), `out/icons/` (copied from slopmax's icon set, `ts/assets/icon`).                                                                                       |
| `package.ts`                | `@electron/packager`: asar, en-US only, no Vulkan or SwiftShader, the CLI in `resources/bin`, `icon.icns` / `icon.ico` as the app's icon; `--archive` adds a `.tar.xz` (a `.zip` on Windows).                                                   |
| `shots.ts`                  | Every page and the panel, light and dark, to PNGs (playwright-core's `_electron`).                                                                                                                                                              |
| `drive.ts`                  | Starts the app under playwright-core, for `shots.ts` and the smoke test.                                                                                                                                                                        |

## Running it

```sh
cd ts
bun install
node apps/desktop/node_modules/electron/install.js   # Bun runs no install scripts; fetches Electron's binary once
mise run demo                                        # a throwaway proxy with fake accounts; prints exports
# in another shell, with the demo's exports and a CLI to run:
SLOPMAX_CLI=$PWD/apps/cli/dist/slopmax bun run --cwd apps/desktop start
```

- `bun apps/desktop/build.ts`: builds `out/`; `electron apps/desktop` runs it.
- `bun apps/desktop/package.ts [--cli <binary>] [--archive]`: packages for this
  platform into `apps/desktop/pkg/`. Without `--cli` it ships
  `apps/cli/dist/slopmax`, building it if missing (run under Bun canary for
  the AOT build).
- `bun apps/desktop/shots.ts <dir> [--app <packaged executable>]`: screenshots
  against the proxy the environment names.
- `SLOPMAX_DESKTOP_SMOKE=1 xvfb-run -a bun test apps/desktop/test/smoke.test.ts`:
  the smoke test, on the built app or the packaged one (`SLOPMAX_DESKTOP_APP`).

## Measured

Measured 2026-11-01 on linux-x64 (a shared 8-core host, load average 5–10),
Electron 45.2.1, the packaged app from `package.ts`, with the AOT CLI
(70,674,664 bytes, `1.4.4-canary.1`) in `resources/bin`. That CLI was built
without the web dashboard embedded, which adds about 0.6 MB to the shipped one.

**On disk** (`slopmax-linux-x64/`):

| What                                                                              |       Bytes |
| --------------------------------------------------------------------------------- | ----------: |
| The whole app, unpacked                                                           | 343,633,020 |
| As `tar.xz` (`tar -cJf`, xz's default level)                                      | 113,123,028 |
| `slopmax-desktop` (Electron's executable)                                         | 234,466,632 |
| `resources/bin/slopmax` (the CLI and daemon)                                      |  70,674,664 |
| `resources/app.asar` (main 327 KB, preload 2 KB, the UI 945 KB, icons 6 KB)       |   1,284,279 |
| `resources.pak`, `icudtl.dat`, `LICENSES.chromium.html`, `libffmpeg.so`, the rest |    ≈ 37.1 M |

Since this was measured the app carries slopmax's own icon set instead of
icons drawn at build time: `app.asar` grows by about 0.9 MB (the 1024 px
`icon.png`, the Linux window's icon), and the macOS and Windows bundles embed
`icon.icns` and `icon.ico`.

One locale (`en-US.pak`) is kept and the Vulkan and SwiftShader files are
gone, and the app runs without them.

**Memory** (`/proc/<pid>/smaps_rollup`, MB) against a daemon the app started on
a fresh home with no accounts, 15–20 s after each state settled. PSS is the
real cost: Chromium's processes share most pages, so RSS counts them again for
each. The network service runs inside main (`NetworkServiceInProcess2`), so
there is no network process.

| Process                    |                 Window open, RSS / PSS | Window closed (tray only), RSS / PSS |     Panel open, RSS / PSS |
| -------------------------- | -------------------------------------: | -----------------------------------: | ------------------------: |
| main (browser)             |                          226.7 / 137.3 |                        222.9 / 151.1 |             228.7 / 138.9 |
| zygotes                    | 93.2 + 93.7 + 22.6 / 21.2 + 21.3 + 7.1 |            92.6 + 93.0 / 25.6 + 35.3 | 92.6 + 93.0 / 24.7 + 25.1 |
| GPU (software compositing) |                            77.7 / 27.5 |                          61.6 / 26.7 |               63.9 / 23.9 |
| sandbox broker             |                             24.1 / 7.8 |                                    — |                         — |
| renderer                   |                           135.0 / 78.4 |                                    — |              131.7 / 81.8 |
| daemon (`slopmax serve`)   |                            55.9 / 53.6 |                          56.0 / 53.7 |               57.1 / 54.8 |
| **Total**                  |                      **728.8 / 354.2** |                    **526.1 / 292.3** |         **666.9 / 349.2** |

The window-open column is the app started directly. The other two were taken
under playwright-core (which turns the sandbox off, so there is no broker or
third zygote, and attaches an inspector to main); with it, the window-open
total read 679.1 / 357.6. Closing the window frees its renderer, about 65 MB
of PSS; the panel costs about the same while it is open, and is destroyed a
minute after it closes.

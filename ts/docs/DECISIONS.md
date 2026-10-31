# Decisions

What the TypeScript port is built with, and why. The evidence is in
`RUNTIME.md`, `AOT.md`, and `STYLING.md`; each was checked by independent
judges, whose corrections are folded in below.

## Stack

| Piece                                      | Choice                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                                   | TypeScript 7 (strict), Effect 4.1 (4.1.1, with `@effect/platform-bun` and `@effect/atom-react` at the same version)                                                              |
| Runtime: CLI, daemon, and the app's engine | Bun (the CLI binary). The daemon is the desktop app's engine (no app-host).                                                                                                      |
| CLI binary                                 | `bun compile --trim` (ahead of time, Bun canary); `--no-aot --minify --bytecode` as the fallback build                                                                           |
| Package manager                            | `bun install`, workspaces                                                                                                                                                        |
| Types                                      | `bun check -b`; `@effect/tsgo` for Effect's diagnostics in CI (with `unstableApiUsage` lowered to a message, since `effect/http` and friends are tagged unstable)                |
| CLI                                        | `effect/cli`; the admin API client is `HttpApiClient`                                                                                                                            |
| Tests                                      | `bun test` with `@slopmax/test` (`it.effect`, `it.live`, `it.layer` over `bun:test` and `effect/testing`)                                                                        |
| Format                                     | `bun fmt` (`printWidth = 120`, `semi = false`)                                                                                                                                   |
| Lint                                       | oxlint, with `@shadcn/lint` and `eslint-plugin-better-tailwindcss` as JS plugins for the renderer                                                                                |
| Desktop                                    | Electron 45; main and preload bundled by `Bun.build`; the renderer is `@slopmax/ui`'s desktop build on `app://slopmax/`; packaged with `@electron/packager` (asar, `en-US` only) |
| UI                                         | React 19, Tailwind CSS v4, shadcn/ui on Base UI; one app (`apps/ui`) for the web dashboard and the desktop window; state through `AtomHttpApi` atoms                             |
| Proxy hot path                             | `Bun.serve` front door, native `fetch` in `Effect.callback`, native `ReadableStream` relays over pure `wire` taps; Effect makes every decision (below)                           |

## Where the code runs (revised 2026-10-31)

```
renderer (@slopmax/ui, app://slopmax/)  ──same-origin fetch──  Electron main (Node)  ──HTTP + SSE──  slopmax serve (Bun)
   AtomHttpApi atoms, view model          preload bridge          window, tray, panel,     key added     the daemon
                                                                  notifications, prefs,    here          (or the login service)
                                                                  runs the bundled CLI
```

- **The engine runs on Bun only, in the daemon.** The sketch's `slopmax
app-host` child and its stdio Rpc group are dropped. The renderer uses the
  daemon's `SlopmaxApi` and event stream, the same contract as the web
  dashboard. That is one process (about 40 MB PSS), one protocol, and one view
  model fewer. Electron main holds only `effect` (Schema, `HttpApiClient`) and
  `@effect/platform-node`'s child-process spawner for running the CLI.
- **Main forwards `app://slopmax/slopmax/api/*` to the daemon** and adds the
  owner key there, so the key never enters the renderer and no CORS is needed.
  The renderer is bundled with the app, so a program squatting on the port
  never gets the preload, and the window can render an offline mode.
- **While the proxy is stopped**, main runs `slopmax status --json` and
  `slopmax doctor --json` for the offline report and the doctor. Changes need
  the proxy running (declared in `parity/NOT-PORTED.md`). A daemon on another
  version is restarted, or flagged with DOC-004 when a login service runs it.
- **The proxy outlives the window**, as in Rust: main runs the bundled CLI's
  `start --json` at launch, and the login service runs the same binary.
- **Electron is started lean:** `app.disableHardwareAcceleration()` plus
  `--enable-features=NetworkServiceInProcess2` (about 40 MB less), the Vulkan
  and SwiftShader files are dropped, and the window's renderer is destroyed on
  close (about 100 MB less).
- This replaces CONVENTIONS' row "App ⇄ engine: `effect/rpc` over NDJSON". The
  app talks to the engine through the typed `HttpApi`. The renderer-to-main
  bridge is a small preload API whose arguments main decodes with Schema.

## Effect-native, not Rust-shaped (2026-10-31)

The first port mirrored the Rust's modules, types, test names, and byte-level
output. That is not the goal and was replaced; it survives only as a behavior
reference on `ts-reference/rust-shaped`. Settled with the user:

- **Parity is features only.** Architecture, outputs, files, URLs, settings,
  and APIs are all free to change; breaking changes are fine
  (`CONVENTIONS.md`, "What parity means").
- **Settings are `config.json`**, defined by an Effect `Schema` that also
  generates `config.schema.json` for editor completion and validation.
- **The CLI is `effect/cli`**, with its help, completions, and error wording.
- **`slopmax run`** spawns the agent with inherited stdio through
  `effect/process`, forwards signals, and exits with the agent's code (a
  process cannot replace itself on Bun).
- **The admin API is an `HttpApi`**, so the daemon, the CLI, and the app share
  one typed definition and client.
- **The desktop protocol** was `effect/rpc` over the app host's stdio. It
  is replaced by the daemon's `HttpApi` (see "Where the code runs").
- **Locks** (revised): a `Semaphore` within a process; across processes, an
  exclusive-create lock file holding the holder's pid and process start time,
  behind the `Lock` service. A holder whose pid is gone or whose start time
  differs (pid reuse) is stale. `flock` through `bun:ffi` was dropped: it
  costs about 9 MB of `--trim` savings (`AOT.md`), and its reason, sharing
  lock files with the Rust build, is gone because no files are shared.
- **Outbound SOCKS5** goes through a small local CONNECT-to-SOCKS5 bridge
  inside the `Upstream` layer, since Bun's `fetch` takes only HTTP proxies.
- **Compressed upstream bodies pass through untouched** (`decompress: false`).

## The final architecture (2026-10-31)

Three designs were judged; `ARCHITECTURE.md` is the result. Decisions it
adds or changes:

- **The proxy's hot path is a native byte lane with Effect making every
  decision.** `Bun.serve` classifies a request with a pure function. One
  Effect per request runs on a context built once (`Effect.runCallbackWith`),
  and the request's abort signal interrupts it. Upstream inference is native
  `fetch` inside `Effect.callback`. Response bodies are native
  `ReadableStream`s driven by pure `wire` taps and transcoders. Measured under
  AOT on this host (32 concurrent): raw Bun 6854 req/s small and 2541 for
  300 KB; `HttpRouter` + `HttpClient` + `Stream` 2375 and 1233, with 193 MB
  against 121 MB peak RSS; Effect owning the attempt with `fetch` in
  `Effect.callback` 4924 small (5708–5907 in the design's own runs). This replaces CONVENTIONS' rows "HTTP
  server: `HttpRouter`", "HTTP client: `HttpClient`" and "Streams: `Stream`"
  inside `core/src/proxy/**` only. The admin API, hub and UI stay on
  `HttpRouter`/`HttpApi`, cold calls on `HttpClient`, and translation on
  `effect/encoding`'s `Sse`. Every exception is listed in `ARCHITECTURE.md`
  §1.3, and oxlint bans `HttpClient` and `Stream` in the proxy directory.
- **No trace headers reach providers.** `HttpClient` sends `traceparent` and
  `b3` by default. Every client sets `TracerPropagationEnabled = false` and
  `TracerDisabledWhen = () => true`. Inference uses native `fetch` with exact
  headers. `SLOPMAX_TRACE=1` enables local spans only.
- **Stream ends settle through a queue.** A once-guard calls
  `Queue.offerUnsafe`, and one `Settler` fiber applies pool, ledger and event
  updates. `Effect.runSyncWith` (which throws if anything goes async) and a
  fiber per stream are both avoided. One 10 s sweeper handles the 600 s stall
  timeout for every stream.
- **Token refresh** is single-flight through `FiberMap.run(..., { onlyIfMissing: true })`
  in the `Accounts` layer's scope, with only the token POST to save
  uninterruptible, and a `RateLimiter` on forced refreshes.
- **Files are watched** (`FileSystem.watch`, debounced, plus a 30 s rescan)
  instead of re-read every 2 s. Status reports are pushed on change.
- **Packages:** `domain`, `wire`, `core`; apps `cli`, `ui`, `desktop`; tools
  `test`, `bench`. `@slopmax/app` is removed. The UI is one React app built for
  the web dashboard (embedded in the CLI) and the desktop window.
- **`ProviderId` and `AgentId` are literal unions**, and the registries are
  typed records, so a new provider fails the type check until every part of it
  exists.
- **Pins and told notices live in `state.json`**, which only the daemon writes
  while it runs. The daemon holds a `serve` lock for its life, and offline CLI
  writes take the same lock, so they cannot race a starting daemon.
- **The detached `serve`** uses `effect/process` (`detached: true`, then
  `handle.unref`), and the daemon writes its own log (`serve --log`). No
  `node:child_process`.
- **The Codex WebSocket relay works through an upstream proxy.** Under Bun,
  `ws` takes `{ proxy }` and still shows the 101's headers (probed).
- **Outbound TLS trusts the system's roots plus Bun's bundled ones**
  (`tls.getCACertificates`), so TLS-intercepting corporate proxies keep
  working.
- **Settings carry a `live` annotation** that drives `PATCH /settings`,
  `slopmax config` and the UI, checked against `LiveSettings` by a test.
  `listen` and `upstreamProxy` need a restart.
- **Performance is gated in CI** on the AOT binary (`ARCHITECTURE.md` §16):
  ≤ 70 MiB, `--version` ≤ 30 ms, idle ≤ 45 MB, peak ≤ 120 MB under 32 × 300 KB,
  and at least 70% (small) and 80% (300 KB) of a raw Bun probe's throughput.
- **Not adopted:** a second contract for UIs (an `RpcGroup` over WebSocket),
  OTLP and Prometheus exporters, the build-time Schema compiler,
  `KeyValueStore` for the small files, and a hand-written RFC 6455 client.
  None of them adds a feature.

## Styling, with the judges' corrections

Tailwind v4 + shadcn/ui, checked by `@shadcn/lint` 0.2.3 (pinned) and
`eslint-plugin-better-tailwindcss` under oxlint, and by TypeScript through
`cva` variant types. Both judges kept the decision; their corrections:

- `no-raw-colors` must be configured as `{ "allow": [], "deny": ["*-white", "*-black"] }`.
  `deny` alone stops checking every other raw color.
- Conflicting and duplicate classes (`p-2 p-4`) are caught by
  `better-tailwindcss/no-conflicting-classes` and `no-duplicate-classes`.
- Off-design steps that are valid Tailwind (`m-13`) are caught by resetting the
  spacing scale in `@theme` and declaring only the steps the design (and
  shadcn's components) use; `no-unknown-classes` then reports the rest.
- Custom tokens stay colors only, or `cn` is built with `cn/vite`, because the
  default `cn` misclassifies custom non-color scales.
- StyleX's real advantages (override limits in component types, rename-safe
  tokens, per-property merging) were confirmed. They are not worth giving up
  shadcn's components and agent fluency for a one-window app. Components that
  should not be restyled omit `className` and `style` from their props, which
  gives the same type-level guarantee.

# Not ported, or changed on purpose

Every feature in this inventory is delivered unless it is listed here. Each
entry names the parity IDs it touches, what the TypeScript slopmax does
instead, and why. An omission that is not declared here is a failure
(`../ARCHITECTURE.md` §17). Seeded from `../ARCHITECTURE.md` §18; each chunk
adds what it changes.

## From the architecture (§18)

- **CLI parser texts** (CLI-011..038). `effect/cli`'s help, errors, exit codes
  and completions replace the old parser's exact bytes. The features remain:
  aliases, rest arguments, `--help` anywhere, completions for three shells,
  exit 2 on usage errors. Its unit tests (`args.rs`: flags and defaults,
  negative numbers and verbatim rest, mistakes, help, completions, edit
  distance) have no TypeScript counterpart; the CLI's parse tests cover every
  typical invocation instead.
- **`config.toml`** (CFG-021..025, the template, comment-preserving edits).
  Replaced by `config.json`, defined by a Schema that also generates
  `config.schema.json` with every description, for editor completion and
  validation. Codex's `config.toml` is still edited in place, keeping comments.
- **Form-encoded admin bodies** (ADM-021, NET-020). Admin endpoints take JSON
  bodies validated by Schema.
- **URL layout** (ADM-\*, PRX paths). The admin API is at `/slopmax/api/*`, the
  dashboard at `/slopmax/`, and Claude Code's base URL is `<base>/claude`.
- **The admin API's shape** (ADM-004..020). Typed endpoints of `SlopmaxApi`
  replace the action paths: account actions are `PATCH /accounts/:id`,
  `POST /accounts/:id/pin`, `DELETE /pins`, `POST /accounts/:id/own`,
  `DELETE /accounts/:id` and `POST /accounts/:id/redeem`; keys are
  `GET/POST /keys` and `DELETE /keys/:name`; settings are `PATCH /settings`.
  Errors are the API's tagged errors (`{ _tag, message }`) with their status.
  A rejected API key is 502 (the provider refused it), not 400.
- **The event stream** (ADM-012). `GET /events` sends a `Hello` event, then the
  current report, then `Request`, `Status`, `Notice` and `Login` events, with a
  `Ping` event every 15 s, in place of the `: connected` and `: keepalive`
  comments and bare ledger lines.
- **`exec` in `run`** (CLI-082, CLI-215). Bun cannot replace its own process.
  slopmax spawns the agent with inherited stdio, forwards SIGINT, SIGTERM and
  SIGHUP, and exits with the agent's code, or 128+n when a signal ended it.
- **Locks** (FS-012). Lock files holding the holder's pid and process start
  time, not `flock`. They do not interoperate with the Rust build, and no files
  are shared with it.
- **WebSocket framing and the raw HTTP client** (NET-040..042, NET-011). Bun
  frames inbound sockets and `ws` frames upstream ones. The accept-key and
  frame unit tests do not apply; the relay's round trips (plain, through a
  CONNECT proxy, and `wss` through it) cover the behavior.
- **Inference connect timeout** (PRX-025, NET-001). `fetch` has no separate
  connect timeout. A refused connection fails at once; a black-holed one is
  bounded by the OS, then by the 600 s wait for headers.
- **TLS roots** (NET-007). The system's roots plus Bun's bundled ones, so
  "no system CA certificates found" can never happen. An inference `fetch`
  is handed no list of roots on Linux, where Bun's own TLS context already
  verifies against the system store (OpenSSL's default bundle and hashed
  directory) beside its bundled roots; elsewhere it is handed one only when
  the system trusts a root Bun does not bundle. Bun builds a context from a
  `tls.ca` list on every call (about 1 ms for 260 roots), and plain-HTTP
  providers never need one.
- **Pins, nudged and windows files** (FS-004; `pins.json`, `nudged.json`,
  `windows.jsonl`). Folded into `state.json` (pins, notices already told) and
  the ledger (`WindowEnded` records).
- **The desktop's told file and `desktop.json`** (APP-061/062, DESK-150). The
  set of notices already told is the daemon's (`state.json`). Window
  preferences live in Electron's `userData/prefs.json`. Notifications are
  posted on every platform Electron supports, not only macOS (DESK-122 widened).
- **The desktop with the proxy stopped** (APP-015..044). The window shows the
  offline report and the doctor. Signing in, account and setting changes, and
  usage history need the proxy running; the app starts it at launch, and the
  terminal commands work offline.
- **Two daemons on one home**. Refused (`AlreadyServing`), since both would
  write `state.json`.
- **The bench rig** (CLI-220..225). Moved out of the binary into `tools/bench`,
  with the same mock provider, request bodies and runs.
- **Build and size features** (CLI-010 `mimalloc`, DIST-002..004). Bun's
  allocator, and the size and speed budgets of `../ARCHITECTURE.md` §16.
- **Native desktop specifics** (DESK-160, slide animations). The screenshot
  mode becomes a `webContents.capturePage()` script in `tools/bench`. Slide
  animations become CSS transitions that honor `prefers-reduced-motion`.
- **Time precision** (COM-001/002). `DateTime` is in milliseconds, so the
  nanosecond round trips do not apply.

## Foundations (C0)

- **The task runner's tasks** (DIST-005). mise stays the single task runner,
  for development and CI, in `ts/mise.toml`: `deps`, `fmt`, `test`,
  `map-check`, `check` (format check, `bun check -b`, Effect's diagnostics
  through `@effect/tsgo`, oxlint, the test map, every test), `compile` (AOT
  with Bun canary), `build` (the `--no-aot` fallback), `budget`, `bench`
  (with oha 1.16, jq 1.8, hyperfine 1.20), `gates`, `demo` and `install`
  (into `$SLOPMAX_INSTALL_DIR`, default `~/.local/bin`). Changed on purpose:
  - the minimum-toolchain check becomes `canary`: types and tests on Bun
    canary, the runtime the binary is compiled with, since Bun 1.4.4 is the
    one supported development runtime and there is no older one to hold to;
  - formatting is `bun fmt` with `bunfig.toml` (`printWidth = 120`,
    `semi = false`) instead of a formatter config file;
  - `install` copies the AOT binary instead of building from source in place.
- **Test temp directories** (FS-015). `TestHome` keeps the
  `<os tmp>/slopmax-<name>-<random>` naming and adds removal when the test's
  scope closes, a resolved real path, and the environment (`HOME`,
  `SLOPMAX_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`) that
  points a child process at it. Most store tests use `MemoryFileSystem`
  instead of a real directory.

## Domain and contract (C1)

- **The first-run template** (CFG-030, CFG-031). The commented TOML template
  becomes `config.schema.json`, written beside `config.json` from the
  `Settings` schema. It carries every setting's description and default, so
  editors show them on hover and complete them; the test that the template
  lists every setting at its default checks the JSON Schema instead.
- **Live settings** (CFG-011..016, ADM-010/011). Named as in `config.json`
  (`sessionMinutes`, `pollMinutes`, …). `refreshTokens` and `websockets` are
  live too, so the list has ten settings rather than eight. `PATCH /settings`
  takes typed JSON values; `slopmax config` still reads `on`/`off`, minutes
  and strategy names as typed.
- **Doctor levels** (DOC-001). `ok`, `info`, `warn`, `fail`; "note" reads
  `info`. A finding without a fix leaves `fix` out rather than writing `null`.
- **Randomness** (COM-010, COM-021). Tokens, keys, hex ids and UUIDs come from
  `effect/crypto`'s `SecureRandom` on Web Crypto, and hashes from its
  `Digest`; there is no separate message for a missing randomness source.

## Engine storage and outbound (C4)

- **Writing `config.json`** (CFG-021, CFG-023..025, CFG-034). A write changes
  only the settings it was asked to change, leaves the rest of the file as
  people wrote it, and is checked by loading the result before anything is
  written. On first run the key is added to the file as re-read under the
  `config` lock, not to the text of the first read, so a concurrent writer's
  other settings are kept (CFG-034's overwrite does not happen).
- **Account files** (ACC-001, ACC-002, ACC-005, ACC-012, ACC-015, ACC-019).
  Each file is the `Account` schema: camelCase keys, the credential as a
  tagged union (an OAuth sign-in's tokens, an API key, or a compatible
  endpoint with its own key), and who the account is in an `identity`
  object. There is no `Store` value: the `Accounts` service holds the files
  and an in-memory cache. An account's lock is `locks/account-<id>.lock`
  rather than `accounts/.<id>.lock`.
- **Account ids** (ACC-008, ACC-009). Still `<provider>-` and 8 hex digits
  of the SHA-256 of the identity, with the same ids as before; the hash comes
  from `effect/crypto`'s `Digest`, so assigning an id is an Effect.
- **Pins** (ACC-021..023). In `state.json`, with the pool (see "Pins,
  nudged and windows files" above); forgetting an account drops its pin there.
- **Error wording** (ACC-014, ACC-016, ACC-018, ACC-020, CFG-018, NET-002).
  Errors are typed values (`FileError` with the path and what was being
  done, `AccountNotFound`, `AccountAmbiguous`, `AccountGone`, `Unreachable`,
  `TimedOut`, `TooLarge`, `ProxyUrlInvalid`, `LockTimeout`), each with a
  message in slopmax's words, instead of the old context strings.
- **The outbound client's internals** (NET-001, NET-009..011). Bun's `fetch`
  pools keep-alive connections with its own timings. Requests are built with
  `Headers` and `HttpClientRequest`. Error bodies are read whole up to the
  caller's limit (`Upstream.readAll`) rather than a client-wide 64 MiB. A
  101 is the WebSocket relay's (`Upstream.dial`).
- **Reloading** (CFG-035, PRX-018). A changed `config.json` is applied
  within about 100 ms of the change (watched, with a 30 s rescan as a
  backup) rather than on a 2 s tick; `listen` and `upstreamProxy` still wait
  for a restart, and `restartNeeded` says so.
- **Log lines** (COM-011). Effect's `Logger` with slopmax's line format.
  `SLOPMAX_LOG` is read when the logger layer is built, and a failure's
  cause follows its line, pretty-printed.

## Providers, sign-in and refresh (C5)

- **The sign-in prompt** (AUTH-007, AUTH-008, AUTH-010). The person's side of
  a sign-in is the `LoginUi` service: `tell` takes the domain's `LoginEvent`
  (`Note` where the old prompt said `Notice`), `pasted` is a `Stream` of
  lines, and `openBrowser` replaces the `no_browser` option (the terminal
  opens browsers; the API leaves it to its caller's window). Sign-in options
  carry the key as a `Redacted` value and may carry the label, so nothing
  prints a key and `signIn` sets the label itself.
- **Refresh wording and errors** (AUTH-002..004, AUTH-018, PROV-007/008).
  `RefreshRevoked` reads `<reason>; sign in again`, matching the status
  report's "sign in again". A usage reading is the domain's `Limits`, which
  carries the plan; usage failures are `ProviderUnauthorized` and
  `ProviderFailed`.
- **The cold-path client** (AUTH-005). Sign-in, refresh, usage, resets and
  catalogs go through `Upstream.http`: slopmax's user agent, a 30 s limit per
  call and the upstream proxy. `fetch` has no separate 10 s connect timeout.
- **Refresh under lock** (AUTH-011..017). A refresh is single-flight in the
  process (a `FiberMap` in the `Accounts` layer's scope, joined by every
  caller) and across processes (the account's lock, then a re-read). Only
  the token request through the save is uninterruptible. Added: forced
  refreshes of one account are limited to three a minute, so a provider that
  refuses every new token cannot make slopmax spin. `ready` also applies the
  proxy's rules (PRX-020): a stored `authError` fails at once, with
  `refreshTokens` off a due token is used as it is, and a passing failure
  while the token still works hands back the current token with a warning.
- **Links to unknown tools** (AUTH-012, IMP-012). A link's tool is a schema
  literal (`cliproxyapi`), so an account file linked to anything else does
  not decode; "cannot follow logins from <tool>" can no longer happen.
- **The callback server** (AUTH-024, AUTH-028). Effect's `BunHttpServer` on
  `127.0.0.1:<port>`, scoped to the wait, instead of a hand-written server.
- **Limit reset outcomes** (PROV-034, PROV-059, PROV-060). The domain's
  `RedeemOutcome` and `LimitReset`: `reset`, `nothing-to-reset`,
  `no-credit`, `already-redeemed`, `declined`.
- **Codex's version header** (PROV-044). When the client sent no Codex user
  agent (a request translated from another agent), the newest Codex version
  slopmax has seen is sent, since the backend gates some models on it.
- **Import results** (IMP-003). `Found` and `Saved` carry an Effect `Result`
  whose failure is the reason in words. A Claude Code login's origin is its
  credentials file, or "the macOS keychain".

## The HTTP proxy (C9)

- **The front door's connection handling** (NET-030). `Bun.serve` owns
  accepting connections, keep-alive, upgrades and `TCP_NODELAY` (its
  default), so there is no accept loop to warn and retry after 100 ms. Its
  idle timeout is off (`idleTimeout: 0`), because an answer may be quiet for
  minutes and Bun's timer would cut it; the 600 s stall sweep decides when a
  stream is dead instead. So a client gets no separate 30 s limit for sending
  its request headers. Shutdown stops accepting, lets answers in flight
  finish for up to 10 s, then closes the rest, as before.

## Codex's socket relay (C10)

- **Backpressure** (WS-011). In place of a 64-message queue per side, reading
  from ChatGPT pauses while Codex's send buffer is full, and what ChatGPT
  already sent waits unsent, until Bun says it drained; a client more than
  64 MiB ahead of ChatGPT is closed with 1013 (try again later). Once either
  side closes, each gets 5 s to send what it has queued before it is cut.
- **A close without a code** (WS-014). Bun cannot send a close frame without
  a code, so a bare close from ChatGPT reaches Codex as 1000. A close Codex
  sends without a code still goes up bare, and so does a client that went
  away without closing (WS-012).
- **A throttled socket** (WS-017) logs
  `{id}: throttled inside a websocket; closing it`, as a spent one logs that
  it was limited.

## API and daemon (C11)

- **History on the request path** (ADM-009). The history view is worked out
  in the request's own fiber, not on a separate thread: the aggregation is
  one synchronous pass over the records, and a Bun worker would need its own
  entry in the compiled binary and a copy of every record. Each record is
  read once per view (whether it answered or failed, and its cost, with each
  model's prices looked up once), so a 30-day ledger of 50,000 requests takes
  about 0.09 s on a loaded 8-core host (0.23 s before), during which live
  streams wait.
- **Reset windows go through the ledger's queue** (DMN-019). Ended windows
  are queued for the ledger's one writer, like every other record, and taken
  from the pool in the same uninterruptible step, so a stop cannot lose
  them. A failed write is logged as `writing the usage ledger: …`.
- **Event streams end on stop** (ADM-012, DMN-013). An open event stream
  (the dashboard's, the desktop window's) ends as the daemon starts to stop,
  so the server's drain waits only for answers in flight, not its full 10 s.

## UI (C14)

- **One app for the dashboard and the window** (ADM-032, ADM-044, ADM-045,
  DESK-126). The web dashboard and the desktop window are the same React app
  with the desktop's layout, tokens and type scale: a sidebar of pages
  replaces the dashboard's section links and its two-column breakpoints,
  side-by-side charts stack by the width they get (container queries), and
  both hosts use the desktop's light and dark colors. The live requests
  (ADM-042) are a Requests page in both hosts.
- **Dialogs and confirmations** (ADM-048, DESK-057, DESK-058). The window
  gains the dashboard's Rename… and Remove… (both ask first), and redeeming
  a limit reset always asks in the dialog that lists the account's windows
  (ADM-050), in place of the window's inline "Redeem one now?". Tooltips are
  anchored to what they describe rather than following the pointer.
- **Charts** (ADM-053, DESK-063..071). Columns, meters and the heatmap are
  HTML boxes sized by CSS custom properties; only the lines are SVG. The
  axis, label and tooltip rules are the desktop's.
- **Timers** (ADM-043, DESK-009). Nothing polls the report: it arrives on
  the event stream. The shown history is read again every minute and 8 s
  after a request is answered. Countdowns tick every second.
- **Keys in the window** (DESK-003). The arrow keys move through the pages
  while the sidebar has focus, as before; the app's menus and their
  shortcuts belong to Electron main (C15), which sends them to the window.
  Single keys work in both hosts while no field has focus: a digit opens
  that page, R refreshes usage, \ shows or hides the sidebar, the comma
  opens Settings.
- **Narrow windows** (ADM-045). One container breakpoint replaces the
  dashboard's two viewport ones: below 720 px of content an account's name
  takes its own line, its windows wrap beneath with their names, and its
  menu stays at the top right; the overview's lines wrap the same way.
- **Many accounts** (APP-073, APP-103). Past 12 accounts a pool's bar is one meter
  filled to the pool's use rather than a segment per account.
- **A stream that drops** (ADM-042). The web dashboard never says the proxy
  stopped (the proxy serves it): it says slopmax is not answering and
  tries again. A refused key brings back the gate saying so.

## CLI (C13)

- **The command surface** (CLI-011..062). `effect/cli` parses, so its help
  layout, error wording and completion scripts are the CLI's: help is
  `--help`/`-h` anywhere (there is no `help <command>`), the version is
  `--version`/`-v` (`slopmax 0.4.0`), and completions are the
  `--completions bash|zsh|fish` flag rather than a `completions` command.
  A usage mistake prints `error: …` and ``See `slopmax <command> --help`.``
  on stderr and exits 2; this now includes a value outside a flag's choices
  (`--strategy`, `--affinity`, `--dialect`, `--by`, a negative `logs -n`),
  which the old CLI's commands refused with exit 1. `service` and `key` take
  their action as a subcommand (`service install`, `key add <name>`); a bare
  `service` shows the status and a bare `key` lists keys; `key add` and
  `key remove` without a name are usage mistakes. `label <account>` with no
  label clears it. `config` names settings as `config.json` does
  (`sessionAffinity`, `pollMinutes`), and `setup <agent>` and `run`/`env`
  take the program (`claude`, `codex`) or the agent's id (`claude-code`).
- **Questions at a terminal** (CLI-190..196). Yes-or-no questions, choices,
  text and secrets are `effect/cli`'s prompts (arrow keys and space, a
  hidden prompt for keys), not typed numbers and `[Y/n]` lines, and quitting
  one (Ctrl-C, Esc) ends the command with status 130. Without a terminal a
  yes-or-no question still reads one line (`y`/`yes`, else no; the end of
  input takes its default), other questions take their defaults, and a
  secret is the whole of stdin, so scripts work as before.
- **Words and layout** (CLI-079..185). The output says the same things in
  the new names (`Cleared …'s label`, `paid overflow` with `slopmax config
paidOverflow on`, prices under `prices` in `config.json`); `start --json`
  prints `{ url, dashboard, version, log }`, and `service status --json` and
  `doctor --json` print their shapes. The dashboard's address is
  `<base>/slopmax/#key=…`.
- **The doctor's CLIProxyAPI port** (DOC, CLI-230). `SLOPMAX_CLIPROXYAPI_PORT`
  tells the doctor (and a daemon's API doctor) where CLIProxyAPI listens
  when it is not 8317; the CLI's tests point it at a dead port.
- **Bun's budgets** (DIST-004). In place of the crate count and the 6 MiB
  release binary: the AOT binary at most 70 MiB and 26 MB as xz, carrying
  no third-party package beyond `effect`, `@effect/platform-bun`,
  `@effect/platform-node-shared`, `ws` and `@decimalturn/toml-patch`
  (`mise run budget`), with `--version` at most 30 ms. Measured on
  2026-10-31 (docs/AOT.md, "The slopmax binary"): 71,284,968 bytes, 23.9 MB
  as xz, `--version` 22 ms. The daemon's memory is over its budgets there
  (idle 58 MB against 45, peak 153 MB against 120), most of it the binary's
  own code paged in; that is the engine's to bring down, gated by
  `tools/bench gates`.

## Bench, gates and distribution (C16)

- **The bench rig** (CLI-220..225, DIST-012). `bun tools/bench` with
  `mock`, `bodies`, `rig`, `run` (`mise run bench`), `demo` and `gates`.
  The rig is the daemon over the same four bench accounts with provider
  origins rewritten to the mock, compiled with the CLI's AOT flags; the
  bodies are the same shapes from the same xorshift seed. Changed: ports
  are free ones the bench picks rather than 9100–9102, `run` prints the raw
  probe's row under each load, and figures come from Schema-decoded oha and
  hyperfine reports instead of jq.
- **The demo** (DIST-013). The seed is Effect's `Random` with seed 7 rather
  than Python's, so the month differs in detail but has the same shape
  (weekday-heavy sessions, model listings, daily warmups, 1% requests no
  account could take, 1% provider errors, 4% failovers, four weeks of ended
  windows). The files are the TypeScript slopmax's own (`state.json`, the
  `usage/*.ndjson` ledger), encoded with the engine's Schemas; no files are
  shared with the Rust slopmax.
- **Release targets** (DIST-008, DIST-009). Bun's runtime is linked against
  a C library, so Linux gets a glibc build (`*-unknown-linux-gnu`, new) and a
  musl one (`*-unknown-linux-musl`, built in the Dockerfile's Alpine stage);
  `install.sh` picks by the C library the machine runs and refuses an
  x86-64 CPU without AVX2, which Bun's runtime needs. Releases come from `v*`
  tags whose version is `slopmaxVersion`, checked by
  `bun tools/bench release-check` (a manual run reports missing notes
  without failing). Until the TypeScript slopmax is chosen to ship, the
  Rust slopmax's `release.yml` answers every `v*` tag and `ts-release.yml`
  runs only by hand, as a dry run, so no tag is released by both; shipping
  it means giving `ts-release.yml` the `v*` tags and narrowing
  `release.yml`'s to the ones before. The musl binaries are tried in the
  Alpine image, since the Ubuntu runners have no musl loader.
- **The performance budgets do not hold yet** (DIST-004, DIST-014). The
  gates (`mise run gates`) measure ARCHITECTURE.md §16 for real and fail
  six of its nine budgets: on 2026-11-01 (linux-x64, 8 shared vCPUs,
  1.4.4-canary.1+da867c60b) serve to the first `/healthz` 200 took
  90–126 ms (budget 60), idle RSS was 57.6–58.7 MB (45), peak RSS
  152–157 MB (120), small requests 32 at once ran at 9–10% of the raw
  probe's rate (70%), 300 KB requests at 15–18% (80%), and one at a time
  added 1.1–1.7 ms to the probe's p50 (0.15 ms). Size (71.4 MB, 23.9 MB as
  xz) and `--version` (12.5–14 ms) hold. The shortfall is the engine's,
  not the bench's; until it is closed the CI job `Performance gates` is
  marked `continue-on-error`, still red on every run, and the budgets stay
  as they are. After C17 (below) the same gates measure 27% and 46% of the
  probe and 0.37 ms over its p50.
- **Installing from source** (DIST-011). `cargo install --git` becomes a
  checkout: `cd ts && mise install && mise run install`. There is no
  `--features mimalloc` (CLI-010).
- **The container** (DIST-010). Built from `ts/` (`docker build -t slopmax
ts`) with Bun canary on Alpine, run on `alpine:3` with `libstdc++` for Bun's
  runtime, and `SLOPMAX_NO_SERVICE=1`, since a container has no login service.

## Desktop (C15)

- **The app's own watcher** (APP-010..012, APP-015..018). The app keeps no
  snapshot of its own and polls nothing: main follows the daemon's event
  stream (`Hello`, `Status`, `Notice`), reconnecting after a second and then
  backing off to every 15 s, and looks at the proxy's last address on the
  same schedule while it is stopped, so one started from a terminal is taken
  up. The window's state, notices (as toasts) and the agents' and service's
  status are the UI's atoms over the same API.
- **Starting the proxy** (APP-013, APP-014). Main runs the bundled CLI's
  `start --json` at launch, which starts the proxy or reports the running
  one, and takes the owner key from it; a start that fails leaves the proxy
  Stopped and posts `Could not start the proxy` as a notification. The CLI
  is looked for in `resources/bin`, beside the app's executable, then on
  `PATH`; `SLOPMAX_CLI` names one directly for development. A call from the
  window while the proxy starts waits for it (up to 20 s) instead of failing.
- **Actions** (APP-020..022). Changes go through the daemon's API, which
  answers the new report and tells every front end; there is no `sync` after
  each and no action of the window's own that reads account files.
- **The menus** (DESK-002, DESK-003, DESK-004). Sign In with Claude…, Sign In
  with ChatGPT…, Import Logins and Add an API Key… open the window at the
  Access page, where each flow lives. Hiding the sidebar is Ctrl+Cmd+S on
  macOS and Ctrl+Shift+S elsewhere (Ctrl+Ctrl does not exist).
- **The panel** (DESK-106, DESK-108, DESK-170). On macOS and Windows a click
  on the tray item opens it under the item. Linux trays (AppIndicator) send
  no clicks, so there the item carries a menu (the proxy's state, each pool,
  Open, Settings, Start or Stop, Quit), and a second launch with `--panel` (for a
  desktop shortcut) opens the panel at the top right of the screen. As
  ARCHITECTURE.md §13 says, the panel also closes when it loses focus, after
  a 150 ms guard; a click on the item that took the focus away leaves it
  closed. A panel hidden for a minute is destroyed.
- **Notifications** (DESK-120..122). Electron posts on every platform it
  supports, so there is no bundle-identifier check or "posts notifications on
  macOS" sentence. The kinds posted are the ones that ask someone to act
  (every account limited, accounts back, sign in again, a limit reset about to
  lapse, quota about to go unused), and the test notice; one account being
  limited or back is not.
- **Screenshots** (DESK-160). `apps/desktop/shots.ts` drives the app with
  playwright-core's `_electron` instead of a build flag: every page, then the
  panel, in light and dark (`nativeTheme`, not saved), at 1160 wide, with
  notifications turned off in the run's throwaway preferences.
- **Icons and the bundle** (DESK-165..167). The UI's icons are Lucide. The
  tray, window and app icons are slopmax's own set (`ts/assets/icon`): the
  macOS menu bar gets its template image of the ⌥ mark instead of the SF
  Symbol `chart.bar.fill`, and the bundles embed `icon.icns` and `icon.ico`.
  While the proxy is not running on this release, the macOS title says
  `Stopped` or `Restart needed` instead of the last usage, and the Linux menu
  drops the pools. `package.ts` (`@electron/packager`, asar) replaces
  `bundle.sh`: the bundle is `slopmax.app` (bundle id `dev.slopmax.desktop`,
  macOS 12 or later, Electron 45's floor), the executable `slopmax-desktop`,
  and the CLI sits in `Contents/Resources/bin`; both are signed ad hoc.

## Speed (C17)

- **A body read as JSON** (PRX-031). A body is read (for its model and
  session) when it is not compressed and is framed as one JSON object: `{`
  first and `}` last, whitespace aside. Every byte is checked only for a
  client key held to some models, where only a valid body proves it names
  one model and no other. Checking every byte costs about 1 ns a byte
  (0.3 ms for a 300 KB conversation, more than everything else the proxy
  does for it); the scanner walks only what lies before the fields it reads
  and finds nothing in anything malformed on the way. A body broken further
  on is routed by its model and forwarded as sent, and its provider refuses
  it, where it was forwarded with no model read before.
- **Readings renewed within 10 seconds** (POOL, LED). An answer whose
  rate-limit reading repeats its account's last one (nearly all do) leaves
  the account's health as it was; the kept reading is renewed once it is 10
  seconds old. So "fresh" (the 5 minutes after which a full window with no
  reset time stops counting) is measured from a reading at most 10 seconds
  older than the newest. An account's last use and the tokens it served
  live beside its health in the pool and join it when it is read whole or
  saved to `state.json`.
- **The ledger's month file stays open** (LED). The writer keeps the month
  file it appends to open between batches (opened to append, so the CLI's
  own appends still never interleave inside a line) and opens the next one
  when the month turns. A file removed while the daemon runs is written
  again only from the next month or the next start.
- **Request events only while someone watches** (ADM-012). The event feed
  hears of each request only while a front end is connected; nobody else
  reads those events.
- **The speed budgets do not hold** (§16). Measured with `tools/bench gates`
  on 2026-11-01 (linux-x64, 8 shared vCPUs, load about 2,
  1.4.4-canary.1+da867c60b, AOT binary and rig): small requests 32 at once
  at 27.4% of the raw probe (2,540 against 9,282 req/s; budget 70%, was
  9.1%), 300 KB requests at 46.4% (1,510 against 3,254; budget 80%, was
  14.5%), one at a time 0.37 ms over the probe's p50 (budget 0.15 ms, was
  1.7 ms); idle RSS 58.4 MB (45) and peak 154.4 MB (120) are as before. A
  CPU profile of the rig under the small load puts its main thread at about
  350 µs a request against the probe's 100 µs: Bun's HTTP server, `fetch`
  and stream plumbing, which the probe pays too, about 140 µs; Headers
  work (the agent's headers forwarded, the answer's readings and the
  pool's windows shown in its place) about 50 µs; the SSE tap about
  35 µs; Effect's fibers and Schema classes about 50 µs; the pool, the
  ledger and the request's log line about 35 µs. Every piece of it is a
  feature the probe does not have, and JavaScript on the proxy's thread
  runs about twice as slow under the full load (the mock, oha and Bun's
  HTTP thread share the host's four cores) as it does alone.

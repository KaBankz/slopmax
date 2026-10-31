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
  "no system CA certificates found" can never happen.
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

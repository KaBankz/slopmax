# slopmax: the target architecture

The plan for the Rust slopmax after v0.3.0, carrying over what the TypeScript rewrite in `ts/` got right (see [`ts/docs/VERDICT.md`](ts/docs/VERDICT.md)). A panel wrote it on 2026-11-01. Five critics each read the code through one lens: the hot path, architecture, testing, crates and the build, and the desktop with its native bridge. Two architects then proposed designs, one lean-first and one robust-first, and two judges scored both against the code. This document starts from **lean**, which won on the mean judge score (7.75 against 7.3). It takes robust's sequencing and correctness pieces, and it fixes every error the judges found. [`ARCHITECTURE.md`](ARCHITECTURE.md) describes the code as it is; this document describes where it is going, phase by phase.

## Status, 2026-11-02

| Phase | State | What landed |
|---|---|---|
| 1 | done (`789ed0d`) | No data lost at stop, no file read per request, one thread by default, serve lock, state quarantine, DST and Retry-After fixes |
| 2 | done (`40d9da4`, `453fd60`, `e70ab6a`) | One `Relay` body and `Settle` (`end` recorded), typed taps in `wire::sse`, `rawjson` framing instead of a parse (proptested), large translations off-thread, one task per Codex socket with a cancel-safe frame reader, an `Arc` snapshot pool, the `raw`/`swarm`/`translate`/`allocs` bench modes |
| 3 | mostly (`bc4fa6e`) | `slopmax-api`, the `live!` registry, `/slopmax/api/*` with the event stream, `contract/` (Rust blesses, TypeScript and Swift decode strictly). Not yet: the `slopmax-daemon` crate split, thiserror boundaries, `Home`-only paths |
| 4 | partly | Local files are TOML (`790cebb`). Not yet: the deadline scheduler, the single-flight `/refresh`, `HistoryIndex`, `state.toml` absorbing pins, `slopmax-app` and the CLI on the API |
| 5 | done, shim kept (`2fbadbb`) | The React UI embedded and served at `/slopmax/`; `dashboard.html` deleted. The `/slopmax/*` shim stays until phase 4 moves the desktop app and the CLI |
| 6 | written, kit verified (`f87228e`) | `apple/`: SlopmaxKit tested on Linux against the fixtures and a live daemon; the SwiftUI layer is built only by `apple.yml` on macOS |
| 7 | not started | |

**Decisions revised on measurement:**

- **D1 holds, now on the case that matters.** 300 concurrent sessions, each streaming 300 KB conversations back to back at a model's pace (`scripts/compare/swarm.sh`), on one thread: 44% of one CPU, p99 event lag 2.32 ms against the mock's own 2.07 ms, worst 9.7 ms; 2 and 4 workers did no better. The one-thread risk, head-of-line blocking from a large translation (2 ms at 300 KB), is removed by translating bodies of 64 KB and more on the blocking pool.
- **Allocations per request: ≤ 40 cannot be met on hyper.** `bench allocs` counts 293 on the proxy's thread for a small streamed request (384 before phase 2); 132 are hyper's HTTP/1 client, which sends each body chunk through a futures channel at two allocations a chunk.
- **JSON stays serde_json.** Measured on the 300 KB conversation: framing by `rawjson` 31 µs (serde_json's validation 89, sonic-rs 71, simd-json 129); finding `model` 0.3 µs (sonic-rs 0.4); a usage event by the typed reader 0.6 µs (sonic-rs 0.5, serde_json to `Value` 2.0). sonic-rs wins where slopmax parses whole documents (translation), but into serde types only 1.27× (229 µs against 291), and it adds 17 crates, past the budget of 70; simd-json adds 9 and 123 KB and is slower here. There is no JSON parser in std.
- **slopmax's own files are TOML**, as `config.toml` is; logs (`usage/*.jsonl`, `windows.jsonl`), the setup backup and other tools' files stay JSON (see `ARCHITECTURE.md`, Files).
- **Size:** 7,184,000 bytes with the API and the embedded UI, inside the 7 MiB budget.

### React Native for the desktop and the menu bar: no

Looked at on 2026-11-02:
- **macOS.** [react-native-macos](https://github.com/Microsoft/react-native/releases) is at 0.81.8, four releases behind React Native, with no word on the new architecture since [0.71's experimental preview](https://devblogs.microsoft.com/react-native/?p=251) and none on a status item. A menu bar app, `SMAppService`, notifications and Swift Charts would each be a native module written in Swift anyway, beside a JavaScript runtime the SwiftUI app does not carry.
- **Windows.** [react-native-windows 0.85](https://github.com/microsoft/react-native-windows/releases/tag/react-native-windows_v0.85.0) is Fabric-only and moving well ([0.82](https://devblogs.microsoft.com/react-native/%f0%9f%9a%80react-native-windows-v0-82-is-here/)), but needs Visual Studio 2026 and .NET 10 to build.
- **Linux.** No React Native desktop target, so GPUI or the wry shell is needed regardless.
- **Reuse.** React Native renders its own primitives, not the DOM: the web UI's components (Tailwind, Base UI) would be written again. Only `ts/packages/domain` (the schemas and the client) would carry over.

So it would be a third UI codebase that still leaves Linux to another, for a look closer to native than a web view but not to SwiftUI. The plan stands: SwiftUI on macOS, GPUI or the served React UI in a system web view on Windows and Linux.

**Mobile, if ever:** SlopmaxKit is Foundation-only, so an iOS app in SwiftUI reuses all of it; Android would be its own app. Either needs the daemon reachable off the machine first (today it listens on 127.0.0.1 with plain HTTP), which is a security design of its own: TLS, and a key per device rather than the owner key.

## Summary

slopmax stays one static Rust binary, and that binary is the daemon. Every other front end is a client of it: the CLI, the web UI it serves, a native SwiftUI app on macOS, and GPUI on Windows and Linux. The daemon runs on a **current-thread tokio runtime** and keeps accounts in an **in-memory snapshot**, so a request touches no files. It uses a **slot-indexed pool behind one short lock** and **one concrete relay body that records exactly one outcome**. The ledger is a **single `write(2)` to a month file held open with O_APPEND**. All background work goes through **one deadline scheduler**, and all detached work is owned by a tracker with an explicit shutdown order. The daemon is the **only writer** of state. It speaks **one typed contract** (`slopmax-api`), wire-compatible with the TS `SlopmaxApi`, and keeps it honest with golden fixtures rather than codegen. It **pushes** status over one SSE stream instead of being polled. The React UI from `ts/apps/ui` is served from the binary and `dashboard.html` is deleted. The SwiftUI app is a pure HTTP and SSE client with no FFI. The Rust core also computes the derived facts (tone, pace, attention, next change), so Swift only formats them. The migration has 7 phases, each shipped as its own version. Each has numeric gates and keeps old clients working until they have moved.

### Measured targets

The bench host is the 8 vCPU host in `SUMMARY.md` with the same rig and pinning. **The bench rig must run current-thread first**; today `examples/bench.rs:42` is `new_multi_thread()`.

| Metric | Rust today | TS today | Target | Gate phase |
|---|---|---|---|---|
| CPU/req, small, 32 at once | 985 µs | 491 µs | ≤ 300 µs | 2 |
| CPU/req, small, 1 at a time | 1,625 µs | 995 µs | ≤ 400 µs | 2 |
| p50, small, 1 at a time | 1.35 ms | 0.80 ms | ≤ 0.55 ms and ≤ raw + 0.10 ms | 2 (≤ 0.80 in 1) |
| p99, small, 32 at once (default build, 4 CPUs) | 15.0 ms (multi-thread) | 17.5 ms | ≤ 15.0 ms (no regression from going current-thread) | 2 |
| req/s, 1 CPU, small, 32 at once | 1,476 | 2,034 | ≥ 3,000 | 2 |
| req/s, `hub` build (4 workers), small, 32 at once | 4,018 | 2,510 | ≥ 4,018 | 2 |
| Extra CPU, 300 KB over small | +386 to +508 µs | about +400 µs | ≤ +60 µs | 2 |
| Head-of-line delay on 8 live streams while a 300 KB translated request decodes | not measured | not measured | p99 added inter-chunk delay ≤ 3 ms | 2 |
| File syscalls per request (openat, statx, mkdir) | about 1 / 1 / 0.5 | 0 | 0 | 1 |
| futex per request | about 28 | n/a | ≤ 2 (phase 1), ≤ 1 (phase 2) | 1, 2 |
| writev per request | about 34 (mock burst) | n/a | ≤ upstream reads + 1 | 2 |
| Heap allocations per request | far more than 100 (read from the code) | n/a | ≤ 40 | 2 |
| Lock operations per request | about 14 | n/a | ≤ 3 pool locks, ≤ 5 lock operations in total | 2 |
| Idle wakeups | about 0.73/s from timers | n/a | ≤ 0.1/s | 4 |
| Idle threads | 9 | 9 | ≤ 2 | 1 |
| Idle RSS / PSS | 8.0-8.6 / 5.0-6.6 MB | 59-69 MB | measured current-thread baseline in phase 1, then ≤ 6 MB RSS | 1, 4 |
| Peak RSS (32 × 300 KB) / after | 46.3 / 21.7 MB | 152.9 / 64.2 MB | ≤ 30 / ≤ 12 MB | 2 |
| `serve` → `/healthz` | 24.9 ms | 84.9 ms | ≤ 25 ms with a 12-month ledger | 4 |
| `--version` | 2.11 ms | 10.4 ms | ≤ 2.5 ms | 1 |
| Binary (x86_64 musl, stripped) | 6.52 MB (CI 6,537,696 B, budget red) | 71.5 MB | ≤ 7 MiB (7,340,032 B) | 3, 5 |
| Third-party crates (CLI) | 63 (budget 70) | 4 npm packages + Bun | ≤ 70 | every PR |
| Ledger records kept across SIGTERM | not guaranteed | all | all, by test | 1 |
| macOS app bundle | GPUI 45.4 MB | 345 MB | ≤ 16 MB universal | 6 |
| macOS app footprint / idle | n/a | n/a | ≤ 40 MB, < 1 wakeup/s with the window closed | 6 |

---

## 1. Decisions

| # | Decision | Evidence |
|---|---|---|
| D1 | Every command runs on a hand-built **current-thread** runtime. Multi-thread is a compile-time `hub` feature for Docker. | `main.rs:19` `#[tokio::main]`. CPU is above wall time one at a time (1,625 µs against a 1.35 ms p50). About 28 futex per request. |
| D2 | Accounts live in an in-memory `Arc<Snapshot>`. The disk is read only under the refresh lock, on `/sync`, and on a stat-gated rescan. | `proxy/mod.rs:177-183` reads the account file on every attempt. |
| D3 | The ledger is one inline `write(2)` to the month file, kept open with O_APPEND. Settle runs in `Drop`. There is no queue and no task. | `ledger.rs:84-136`: detached, `spawn_blocking` plus mkdir and open per batch. It is never drained (`daemon.rs:131-133`). |
| D4 | One `Supervisor` owns everything that runs in the background: a `CancellationToken`, a `TaskTracker`, the scheduler's `JoinSet`, and the explicit shutdown order. | `daemon.rs:58-120`: eight detached loops; `every` never exits (`daemon.rs:138-149`). |
| D5 | **Nothing blocks the runtime thread.** File I/O goes through `blocking()`. The only inline syscalls allowed are the ledger write and the rescan's `statx`. This lands **before** D1 in the same phase. | `save_state` → `write_private` calls `sync_all` on a worker (`daemon.rs:216-222`, `fsx.rs:21`). `store.save` runs inside an async task (`auth/mod.rs:327`). `store.update` runs on workers (`admin.rs:455-473`). |
| D6 | The daemon is the only writer of state while it runs. The CLI and every front end are API clients. A serve lock enforces this. | The app writes files and then calls `/sync`: `slopmax-app/src/lib.rs:362, 417, 462, 501`. |
| D7 | One typed contract, `slopmax-api`, wire-compatible with the TS `SlopmaxApi` under `/slopmax/api` (`ts/packages/domain/src/api.ts:368`). There is one settings registry, typed errors and one event stream. Golden fixtures keep it honest; there is no codegen. | `json!` replies; form strings joined from query and body (`admin.rs:80, 205`); setting names as strings in about 8 places (`config.rs:183-263`). |
| D8 | **Old `/slopmax/*` admin routes stay as a thin compat shim over the new handlers until the last client has moved (phase 5).** | `background.rs:76-104` and `dashboard.html:492, 1306` call them. Both proposals deleted the routes 2-4 releases too early. |
| D9 | Status is pushed over SSE, not polled. One deadline scheduler replaces the fixed intervals. | App polls every 2 s (`slopmax-app/src/lib.rs:41`); dashboard `setInterval` (`dashboard.html:1459-1461`). |
| D10 | The React UI is served from the daemon, gzip-only, on the system font. `dashboard.html` is deleted. | 99,748 B raw `include_str!` (`admin.rs:33`). |
| D11 | macOS gets SwiftUI as a **pure HTTP+SSE client with no FFI**. The daemon is the bundled CLI, run as an `SMAppService` agent. | `VERDICT.md:181`: UniFFI only if editing must work while the daemon is stopped, which both proposals rule out. |
| D12 | GPUI stays for Windows and Linux only, as a thin API client behind hardware gates. If it fails them, the fallback is wry around the served React UI. | gpui-pre `=0.3.7`, 553 crates, never measured on a real GPU. |

---

## 2. Crate graph, module map, binaries

### 2.1 Graph (arrows point at dependencies)

```
slopmax-common   time (in-house; DST + HTTP-date fixes), ids (+ per-socket mask PRNG), log (+ debug!), human
      ▲
slopmax-wire     ir, translate, chat/, messages/, responses/, rawjson (moved), sse (line framing + typed borrowed events), opening (Codex start check)
      ▲
slopmax-net      client (hyper-util legacy + proxy::Matcher), server, body (Deadline), ws, form, headers (forwardable/returnable, moved, in place), transport (Tcp | Memory for tests)
      ▲
slopmax-api      DTOs, Event, ApiError, settings! registry, Route; feature "client" → net (plain HTTP + SSE reader)
      ▲
slopmax-core     config, account Store, auth, provider/, agent/, route, pool, limits, ledger (Sink + reader + HistoryIndex), pricing,
                 snapshot, state (one state.json), report/summary/history → api DTOs (incl. derived facts), notify (incl. nudge rules),
                 doctor, import, service, fsx, paths (Home only), clock, error
      ▲
slopmax-daemon   Daemon::start → Handle, supervisor, scheduler, events, blocking, api/{route,handlers,logins,compat,assets},
                 proxy/{forward, relay, settle, live, start, transcode, socket, models, warm, hub, replay}
      ▲
slopmax          CLI binary: core + daemon + api[client]

slopmax-app             GPUI view model: api[client] + common::human. No slopmax-core (CI-enforced).
slopmax-desktop-gpui    Linux + Windows only (not a default member)
apple/                  SwiftUI app (XcodeGen), API client only
contract/               fixtures shared by Rust, TS and Swift tests
fuzz/                   cargo-fuzz crate, outside the workspace
benches/                gungraun crate, not a default member
```

CI rule, taken from robust: `cargo tree -p slopmax-app -e normal | grep -q slopmax-core && exit 1`.

### 2.2 Moves, additions, deletions

| Today | Target | Reason |
|---|---|---|
| `core/proxy/rawjson.rs` | `wire/rawjson.rs` | Layering is inverted today: `agent/mod.rs:29` and `provider/keys.rs:166` import it through `crate::proxy`. |
| `proxy/mod.rs:493-533` forwardable/returnable | `net/headers.rs`, filters in place on an owned `HeaderMap` | `provider/claude/wire.rs:29` and `codex/wire.rs:19` import them. |
| `proxy/sse.rs` Tap, `start.rs` opening check | `wire/sse.rs`, `wire/opening.rs` (pure, fuzzable) + `daemon/proxy/relay.rs` (I/O) | Separates the scanner from the body. |
| `proxy/*`, `daemon.rs`, `admin.rs`, `hub.rs` | `slopmax-daemon` | Breaks the `admin.rs:58` ↔ `daemon.rs:107` cycle. |
| `App` (14 fields, six std Mutex caches, `proxy/mod.rs:47-79`) | `Daemon` + `ProxyCaches` | Explicit ownership. |
| `Report.accounts[].state: AccountState` (`report.rs:122`) | `api::AccountView` | The API is no longer welded to the `state.json` format. |
| `slopmax-app/src/view.rs` derivations: pace, attention, which window binds, `next_change`, the menu-bar facts | `core/report.rs` → DTO fields (enums, fractions, instants). `Tone` is already there (`report.rs:154, 207`). | One derivation site for the CLI, React, GPUI and Swift. This was unscheduled in lean. |
| `slopmax-app/src/alerts.rs` decisions + the `desktop-notified` file | `core/notify.rs` + `told` in `state.json` → `Event::Notice` | One decider. |
| `pins.json`, `nudged.json`, `windows.jsonl`, the 30-day ledger scan for the Codex model (`proxy/mod.rs:85-91`) | `state.json {pins, told, codex{version,last_model}}` + `WindowEnded` ledger records | Fewer files; startup no longer grows with history. Old files are **read once and left in place for one release**, so a downgrade works (§9.3). |
| `paths.rs:76-103` free functions | deleted; `&Home` everywhere | Tests run side by side. |
| `net/client.rs:167-172` `DEFAULT_PROXY` OnceLock | `Client::builder().proxy(Matcher)` | Explicit; sees the system proxy. |
| `proxy/dashboard.html` | deleted (phase 5) | D10 |
| GPUI `native.rs`, the mac half of `notifications.rs`, `macos/`, objc2*, block2, async-channel | deleted (phase 7) | macOS belongs to SwiftUI. |
| `agent::id() -> &'static str`; provider list edited in 4 places | `enum AgentId` + one `providers!` macro (from robust) | A missing part fails the build. |

### 2.3 Binaries

| Binary | Runtime | Notes |
|---|---|---|
| `slopmax` (CLI + daemon) | current-thread; `serve`: `max_blocking_threads(4)`, default 10 s keep-alive | The same binary is the macOS agent (`Contents/MacOS/slopmax serve`), the GPUI app's bundled daemon, and the Docker entrypoint (`--features hub,mimalloc`). |
| `Slopmax.app` | SwiftUI main actor + one `URLSession` SSE task | No Rust library is linked in. |
| `slopmax-desktop` (GPUI) | one current-thread runtime on one thread (replaces `new_multi_thread().worker_threads(2)`, `slopmax-app/src/lib.rs:261-262`) | Linux and Windows; bundles the CLI. |
| `examples/bench.rs` | **current-thread** by default; `--hub` runs 4 workers | Gains `raw`, a minimal hyper forwarder, as Rust's floor. |

---

## 3. Runtime model

### 3.1 Threads and the blocking rule

- **Threads.** When idle there is only the main thread under `block_on`. Under load, up to 4 more blocking threads appear, and they exit after 10 s idle.
- **Why the cap is 4, not 2 or 8.** The blocking pool carries hyper-util's `GaiResolver` DNS lookups, flock waits, state saves, rescan rereads and doctor. In-process single-flight (§3.4) allows at most one flock waiter per account, so a cap of 4 cannot starve DNS. That condition is what made robust choose 8.
- **Keep-alive stays at the default 10 s**, not lean's 60 s. That keeps the idle thread count at 1. The rescan's `statx` calls run inline, so they never spawn a thread.
- **Enforcement:**
  - `clippy.toml` `disallowed-methods` lists `std::fs::*`, `File::{open, create, sync_all, sync_data, lock}`, `std::thread::sleep` and `std::process::Command::{output, status}`.
  - The crate root of `slopmax-daemon` has `#![deny(clippy::disallowed_methods)]` **from phase 1**.
  - `#[allow]` with a reason is granted only in `ledger::Sink`, `snapshot::rescan` (statx only) and `blocking.rs`.
- **Long-poll detector (test only).** A test build compiled with `RUSTFLAGS="--cfg tokio_unstable"` uses `on_before_task_poll` / `on_after_task_poll` (both are `#[cfg(tokio_unstable)]` in `tokio-1.54.1/src/runtime/builder.rs`). It fails any poll longer than 1 ms. It runs as a separate nightly CI job, never in release builds.
- **The `hub` feature** turns on `rt-multi-thread` with `workers = N` (config or `SLOPMAX_WORKERS`). All shared state stays `Send + Sync` behind std locks, so this is a build switch, not a fork.
- **Accepted cost.** On one thread a 300 KB translation decode delays other streams by about 1-3 ms. TLS handshakes take about 1 ms of CPU each. Both are bounded by the head-of-line gate (§7.4).

### 3.2 State ownership: snapshots plus short std locks, no actors

```rust
pub struct Daemon {
    home: Home,
    clock: Clock,
    snap: watch::Sender<Arc<Snapshot>>,      // borrow().clone() per request; changed() feeds the publisher
    pool: Pool,                               // Mutex<PoolState>, slot-indexed, generation-aligned
    refresh: Mutex<HashMap<AccountId, Arc<tokio::sync::Mutex<()>>>>, // single-flight; OUTSIDE the snapshot
    ledger: Sink,
    events: EventBus,
    upstream: Upstream { inference: Client, cold: Client },
    caches: ProxyCaches,                      // replay, catalogs, warmed: one Mutex each
    logins: Logins,
    sup: Supervisor,                          // token, tracker, scheduler JoinSet
    gen: Generation,                          // AtomicU64 + Notify
}
pub struct Snapshot { config: Arc<Config>, accounts: Arc<[Arc<AccountEntry>]>, by_provider: [Arc<[u16]>; ProviderId::COUNT],
                      keys: Arc<[KeyEntry]>, generation: u64 }
pub struct AccountEntry { account: Account, auth: HeaderValue /* sensitive */, origin: (Scheme, Authority), speaks: DialectSet }
```

- **Single-flight lives in a map keyed by `AccountId`.** Lean put a `tokio::sync::Mutex` inside the snapshot's entries. Every swap rebuilt it, so single-flight silently fell back to the flock and cost a blocking thread per waiter.
- **Slot alignment** (robust). `PoolState` records the snapshot generation its slots are laid out for. When a swap happens, `pool.align(&snap)` runs under the lock and carries health over by account id. A pick that sees an older generation reloads the snapshot once.
- **`watch` instead of `RwLock<Arc<_>>` or arc-swap.** It costs the same per read (an uncontended read lock plus an Arc bump), and its `changed()` is needed by the publisher anyway.
- **Snapshot replacement triggers:**
  - after a refresh, once its save has finished;
  - after an API action;
  - on `/sync`;
  - on a 30 s rescan that `statx`es `accounts/`, `config.toml` and every linked account's source file, rereading (through `blocking()`) only what changed.
- **Staleness rule.** Today `ready()` picks up an `auth_error` written by another process (`proxy/mod.rs:186-192`). After this change:
  - the CLI marks an account revoked through the API, or when no daemon runs, under the serve lock;
  - a third-party write is seen within 30 s;
  - a 401 still forces a reread under the lock (`forward.rs:633-643`).
  - A test asserts that a revocation done through the CLI is honoured by the very next request.

### 3.3 Hot path: a native Claude Messages request, streamed, on a warm connection

| Step | What happens | Locks | Allocs | Syscalls |
|---|---|---|---|---|
| 1 Accept | hyper h1 (`server.rs:36-73`: NODELAY, 30 s header timeout kept as explicit policy; loopback reconnects are cheap) | 0 | hyper's | read |
| 2 Route | `Route::parse(&Method, &str)` → `Target { dialect, provider, prefix: &'static str }`; the path stays in the inbound `PathAndQuery` (fixes the Strings at `mod.rs:288-292, 364, 409`) | 0 | 0 | 0 |
| 3 Caller | `snap = daemon.snap.borrow().clone()`; constant-time key compare (`mod.rs:451-453` kept) | 1 read | 0 | 0 |
| 4 Body | `Limited::collect` | 0 | ≤ 1 | reads |
| 5 Inbound | **Phase 1-2: `is_valid` stays** (`rawjson.rs:17-19`). It becomes a framing check (as `ts/packages/core/src/proxy/inbound.ts:107-133`) **only after** the rawjson property tests agree with serde_json and 10 minutes of clean fuzzing (robust's sequencing). Keys restricted to some models keep strict validation (`forward.rs:186-206, 368-393`). | 0 | 2 | 0 |
| 6 Pick | one `pool.lock()`: `saw_agent` folded in, sessions looked up by `&str`, placement read in place (no `AccountState`/`Limits`/`Vec<Account>` clones; `pool.rs:354-356, 381, 408, 437, 767-773`) | **1** | 0-1 | 0 |
| 7 Ready | in memory; when the token is due: single-flight → flock (blocking) → reread → POST → **save (blocking)** → swap → identify | 0 | 0 | 0 |
| 8 Outbound | `Parts` by value; strip in place; insert `entry.auth` (refcount); one-entry `anthropic-beta` memo; `Uri::from_parts` | 0 | ≤ 1 | 0 |
| 9 Send | hyper-util pool; the connection task is on the same thread, so no futex | 0 | hyper's | writev |
| 10 Head | one lock: raw rate-limit bytes compared with `slot.last_raw` (parsed only on change, renewed every 10 s, as `ts/packages/core/src/pool.ts:402, 724-749`); `record_success`; cached pooled `HeaderValue`s; `static HeaderName`s; upstream headers filtered in place | **1** | about 4 | read |
| 11 Relay | one `Relay` body (§3.5) | 0 | 1 | per chunk: read + ≤ 1 writev |
| 12 Settle | one lock for usage and blocks; `Entry` written into a reused `Vec<u8>`; one ledger `write`; `Request` event only when `receiver_count() > 0` (`mod.rs:237-241` kept) | **1** + sink mutex | 2 | **1 write** |
| 13 Log | the per-request line moves to `debug!`; `log::write` formats into a thread-local `String` and does one `write_all` (fixes `log.rs:86-93`) | 0 | 0 | 0 at Info |

**Per-request budget, asserted in CI:**
- 0 openat, statx or mkdir;
- futex ≤ 1;
- writev ≤ upstream reads + 1;
- exactly 1 ledger write;
- ≤ 40 allocations;
- ≤ 3 pool locks.

**SSE coalescing is out of scope.** hyper already flushes on Pending, and the 34 writev come from the mock sending 64 events in one burst. Revisit only if `bench raw` shows writev is the remaining gap.

### 3.4 Refresh

The order for each account:
1. `daemon.refresh[id].lock().await`.
2. `blocking(store.lock(id))` (the flock; `auth/mod.rs:237-256` kept).
3. Reread the account. If another process rotated it, adopt that.
4. POST the grant.
5. **Save (blocking), then swap the snapshot.**
6. `identify`, saving again only if the identity changed.

The fix is moving identify after the save; today it sits between the POST and the save (`auth/mod.rs:325-327`). Rotations are spawned on the tracker and never select on the cancel token between steps 4 and 5. Forced refreshes are limited to 3 a minute per account (`ts/packages/core/src/refresh.ts:189`).

### 3.5 One relay body, one settle

```rust
struct Relay { inner: Incoming, held: VecDeque<Bytes>, tap: wire::sse::Tap, last_activity: Instant,
               live: LiveId, first_byte: Option<Instant>, settle: Option<Settle> }
pub enum EndReason { Complete, UpstreamError, ClientGone, Stalled, Cut }
```

- **It replaces** the `UnsyncBoxBody` / `Tapped` / `Prefixed` / `IdleTimeout` chain and the per-frame Sleep reset (`body.rs:144-145`).
- **Stalls.** One stall sweeper runs over a live `Slab`, sleeping until the earliest deadline and **disarmed while the slab is empty** (from robust). The same set is what shutdown drains.
- **`Settle` is created when the attempt is chosen.** `forward` never calls `failed()` for an answer that already has one. That fixes the double record of translated non-stream failures: `translate_back` returns non-2xx at `forward.rs:952-958` after `Tapped` has reported 200, and then `forward.rs:451-461` records it again.
- **Ledger status by reason:** Complete → upstream status; UpstreamError → 502; ClientGone → 499; Stalled → 504; Cut (the shutdown deadline) → 503. Today all of these are recorded as `served.status` (`sse.rs:186-189, 206-210`).
- **The tap** checks the `"type":` prefix with memmem, then deserializes a borrowed `Ev<'a> { kind: &'a str, usage, error }`. There is no `Value` (fixes `sse.rs:123-137`).
- **Codex `hold`** scans lines with memchr (fixes the per-byte push at `start.rs:48-53`). It now passes an upstream error to the client instead of swallowing it (`start.rs:38-41`).

### 3.6 Ledger and history

- **Sink.** `Mutex<Option<MonthFile>>` plus a reused buffer. The file is opened O_APPEND|O_CREAT with mode 0600, in a directory created once (0700). It is reopened when the month turns or after a write error.
- **Line repair.** When a file is opened and does not end in `\n`, write one first. Today a crash-truncated line also costs the next record (`ledger.rs:129-135`).
- **Write errors** are warned once, counted in `dropped`, and shown by doctor.
- **Durability.** No fsync per record; one `sync_data` at shutdown.
- **Fallback, only if the p99 gate trips on a slow filesystem:** a joined `std::thread` behind the same `Sink` interface. Never a detached `tokio::spawn`.
- **`WindowEnded` records** go through the Sink, which retires `windows.jsonl` and the "told before written" order (`pool.rs:569`, `daemon.rs:248`).
- **`HistoryIndex`.** Hourly aggregates for the current month and daily ones for older months. It is built lazily on a blocking thread and updated at settle. `/history` no longer reparses the month on every call (`admin.rs:172-199`, `history.rs:171-186`).

### 3.7 Scheduler

- **One task** runs `select!` over `sleep_until(min next)`, `gen.notified()` and `token.cancelled()`.
- **Jobs:** rescan, poll (per-account due, `poll_mins` default 5 per `config.rs:112`), refresh lead, list credits, redeem expiring, warm, notices, save_state, prune sessions.
- **Running.** Each job has one instance at a time and never catches up. A run that panics is logged at error level and rescheduled after 60 s (`daemon.rs:138-149` dies silently today).
- **save_state:**
  - debounced 5 s after a dirty bump;
  - written through `blocking()` with a unique temp name (pid plus an `AtomicU64`; today pid only, `fsx.rs:18`) and a parent-directory fsync;
  - the dirty generation advances only once the write succeeds (fixes `pool.rs:711`).
- **`/refresh`** joins the one in-flight run instead of running `poll_all` per caller (`admin.rs:57-61`).
- **Polls carry their send time.** A reading sent before `last_reset_at` is dropped.

### 3.8 Event bus

- **Channels.** `broadcast::Sender<Bytes>` with 256 slots and sliding (a lagging reader skips ahead), plus `watch<Option<Bytes>>` holding the latest Status.
- **Publisher.** It wakes on the generation, debounces 250 ms, and builds the report **only while `receiver_count() > 0`**. It publishes only when the bytes differ.
- **Per connection:** `Hello{version, exe}`, then the cached Status, then live events, plus `Ping` every 15 s while connected.
- **The stream ends on the token**, which removes the forced 10 s drain whenever a dashboard is open (`admin.rs:390-410`, `server.rs:75-77`).

### 3.9 Shutdown (in `Daemon::run`)

1. Cancel the token. Listeners stop accepting, `/events` ends, and socket relays send 1001 after a 5 s flush.
2. HTTP drain, ≤ 10 s (`server.rs:66-77`).
3. Drop the live set. `Settle::drop` records `Cut`.
4. `tracker.close(); timeout(5 s, tracker.wait())`. Refresh rotations finish their save.
5. Stop the scheduler and await its `JoinSet`.
6. Final `save_state`; it is the only writer now.
7. `ledger.sync_data()`.
8. Release `.serve.lock` (`File::try_lock`, held for the daemon's life; a second daemon fails with `AlreadyServing{pid}`).
9. Exit 0, or 75 for `/shutdown {restart: true}`.

**Startup.** An unreadable `state.json` is moved aside as `state.json.bad-<ts>` and the daemon starts with a warning; today the `?` at `daemon.rs:54` fails the start. `panic = "unwind"` stays, so one panicking connection is contained.

---

## 4. Contracts

### 4.1 Settings registry

There is one `settings!` macro in `slopmax-api/src/settings.rs`. It generates `enum LiveKey`, `LivePatch` (all fields `Option`, camelCase, `deny_unknown_fields`), `static LIVE`, `SettingsView` (no secrets) and the `ApplyLive` trait, which `Config` implements with comment-preserving toml_edit writes (`config.rs:372-391` kept). Ranges live in const-generic newtypes.

**Each row carries two keys** (robust's design, not lean's rename):
- the **TOML key stays as it is today** (`session_ttl_mins`, `poll_mins`, …);
- the **API key is the TS name**, which is `sessionMinutes` (`ts/packages/domain/src/settings.ts:166`), `pollMinutes`, `redeemExpiring`, `redeemWhenExhausted`, `warmWindows`, `paidOverflow`, `refreshTokens` and `websockets`.

Robust's `sessionTtlMinutes` was wrong. Keeping the TOML keys also makes a downgrade safe: no `deny_unknown_fields` exists in `config.rs`, so an older binary simply ignores keys it does not know.

`refreshTokens` and `websockets` join `LIVE`. They already apply live but are invisible to the API (`config.rs:183-216`).

**Deleted:** `live_value`, `Config::live`, admin `settings()`, the `Setting` enum in slopmax-app, `view::live_detail(&str)`, and the strings in GPUI and the dashboard. A test checks that the registry, the TOML template (`config.rs:623-656`) and the `SettingsView` fixture agree. A `compile_fail` doctest proves that a misspelled key fails to compile.

### 4.2 API, errors, compat

- **Routes** mirror `api.ts:246-383` under `/slopmax/api`:
  - system: status, refresh, sync, shutdown, doctor;
  - accounts: add (an `AddAccount` union), PATCH, pin, DELETE pins, own, DELETE, redeem; imports;
  - logins: start, paste, cancel; progress as `Event::Login`, driven by the existing `auth::Prompt` (`auth/mod.rs:116-170`);
  - settings GET/PATCH, keys;
  - agents: list, connect, disconnect;
  - usage, history, events, notify test.
- **Routing without axum.** A `Route` enum is parsed once and matched exhaustively. Bodies are capped at 64 KiB and request types use `deny_unknown_fields`.
- **Errors.** thiserror enums at each boundary: `ConfigError`, `StoreError{NotFound, Ambiguous, Gone, Io}`, `LoginError`, `ProviderError`, `ListenError{addr, holder}`; `RefreshError` and `UsageError` are kept. There is one `From` into `ApiError` per boundary. `ApiError` is `#[serde(tag = "_tag")]` with `status()`. anyhow stays in the CLI's `main` only.
- **`api/compat.rs`** maps the old `/slopmax/{status,refresh,sync,shutdown,usage,history,settings,events,accounts/:id/:action,…}` onto the new handlers and keeps today's JSON shapes. It is deleted in phase 5, once the dashboard is gone and `slopmax-app` is on the new API (phase 4). A test drives today's `background.rs` client (`background.rs:239-310` mock list) against the shim.
- **Version skew.** `Hello` and `/healthz` carry `version` and `exe` (the daemon's executable path). Clients map a mismatch to `OtherVersion{running, bundled, managed}` (`ts/packages/domain/src/desktop.ts:12-20`). `managed` is true only when `exe` is their own bundled CLI. A Homebrew-run daemon is therefore flagged, never restarted.

### 4.3 How TS and Swift get their types: golden fixtures, no codegen

- **Fixture zero comes first.** Before any Rust endpoint is written, record the TS daemon's `/events` bytes and its error bodies. Effect's `StreamSse` data mode wraps values in an internal event schema with a reserved failure event (`HttpApiSchema.ts:356-431`).
- **Rust writes the fixtures.** `slopmax-daemon/tests/contract.rs` runs `Daemon::start` on the memory transport. It calls every Route (successes, each error, an SSE transcript) and writes `contract/fixtures/<group>.<endpoint>.<case>.json` plus `contract/events.sse`. `SLOPMAX_BLESS=1` rewrites them; a ~40-line `testkit::golden` helper does this, so no insta.
- **TS decodes them.** `ts/packages/domain/test/rust-contract.test.ts` decodes each fixture with `onExcessProperty: "error"`, in ts-ci. TS-encoded requests go in `contract/requests/` and Rust decodes them with `deny_unknown_fields`.
- **Swift decodes them.** `apple/Tests/ContractTests.swift` decodes every fixture and re-encodes it, comparing key sets so that Codable's tolerance of unknown keys cannot hide drift.
- **Contract master.** The TS Schemas are the master until phase 5 ships; after that the Rust DTOs are.
- **Rejected:** typeshare (no `_tag` unions); specta and ts-rs (TS only, and the UI decodes with Effect Schema); schemars plus swift-openapi-generator (about 40 hand-written types do not justify a generator or OpenAPIRuntime in the app).

### 4.4 Serving the React UI

- **Embedding.** `slopmax-daemon/build.rs` reads `SLOPMAX_UI_DIST` (default `ts/apps/ui/dist/web`) and emits a `static ASSETS` table with `include_bytes!`. If the dist is missing it embeds a one-line "UI not built: `mise run ui`" page, so `cargo build` never needs Bun.
- **Encoding.** Gzip only. Drop IBM Plex for `system-ui` (−71 KB).
- **Headers** as `ts/packages/core/src/api/assets.ts`: CSP, ETag/304, `immutable` for hashed names, `no-cache` for `index.html`.
- **Owner key.** The page asks for it and keeps it in the tab.
- **Release CI** builds the UI and asserts `index.html` is in the table.
- **Consequence.** `ts/apps/ui` and `ts/packages/domain` become shipping code; the rest of `ts/` stays frozen.

---

## 5. Desktop

### 5.1 macOS: SwiftUI over HTTP+SSE, no FFI

**Why not UniFFI.** Robust's UniFFI plan would add:
- a tokio, hyper and serde runtime inside the GUI process;
- an `unsafe` exception for the generated code;
- the bindgen and xcframework toolchain;
- an unmeasured "≤ 3 MB per arch" library.

There is also a crash risk (plausible, not verified here): non-throwing UniFFI exports are wrapped in `try!` in the generated Swift, so a Rust panic would kill the app.

Product-skeptic's real objection was "a third view model". It is answered differently: every *decision* moves into `core/report.rs` (§2.2), and the DTOs carry enums, fractions and instants. Swift only formats them, with `Date.FormatStyle`, `Duration.UnitsFormatStyle` and `Text(timerInterval:)`, which needs no app wakeups for countdowns.

**Reopen conditions:** offline editing becomes a requirement, or Swift logic outside `Views/` grows past 1,000 lines. In that case, add a **pure-function** UniFFI surface over the wording, with no runtime and no network.

**Layout:**

```
apple/project.yml                 XcodeGen (mise) → Slopmax.xcodeproj (ignored)
Slopmax/SlopmaxApp.swift          MenuBarExtra(.window) + Window + Settings; LSUIElement; NSAllowsLocalNetworking=YES
Daemon/Client.swift               URLSession; base URL + owner key from bundled `slopmax daemon-info --json`
Daemon/Events.swift               SSE line parser; reconnect 1 s → 15 s (port of ts/apps/desktop/src/main/events.ts); watches last address
API/*.swift                       ~40 Codable DTOs + ApiError
Store.swift                       @MainActor @Observable, split by change rate (proxy, groups, notice, signIn, settings, history)
Host/LoginItems.swift             SMAppService.agent + .mainApp; requiresApproval → openSystemSettingsLoginItems()
Host/Notifier.swift               UNUserNotificationCenter + delegate (deep links)
Views/…                           NavigationSplitView, Form(.grouped), Gauge, Swift Charts; Commands from GPUI main.rs:226-298
LaunchAgents/dev.slopmax.agent.plist  BundleProgram=Contents/MacOS/slopmax, [serve], RunAtLoad, KeepAlive{SuccessfulExit:false}
Tests/ ContractTests, StoreTests (scripted event sequences), LoopbackTests (real daemon on 127.0.0.1), UITests/Shots
```

**When the daemon is down,** the app is read-only: it shows the bundled `status --json` and `doctor --json`, which emit api DTOs.

### 5.2 Process model, packaging, updates

- **The daemon outlives the app.** It is the bundled CLI run as an `SMAppService.agent` (Login Items shows the app's name and icon). No `ProcessType=Background`. The app itself is `SMAppService.mainApp` with "Open at login" on by default, because it is the notifier. While the app is closed, the daemon's command and webhook hooks remain the headless path.
- **Restart without a visible gap.** After an update the app calls `POST /shutdown {restart}` and then immediately `launchctl kickstart -k gui/$UID/dev.slopmax.agent`, so launchd's throttle interval never applies.
  - **Gate:** under a stream of agent requests, connection-refused lasts ≤ 1 s, and both Claude Code and Codex retry through it. This is measured, not assumed; if either does not retry, the restart waits for the live set to empty, capped at 30 s.
- **Coexistence with a terminal-installed CLI:**
  - `slopmax service install` on macOS detects `gui/$UID/dev.slopmax.agent` and defers to it.
  - When the app adopts the daemon, it boots out and removes `~/Library/LaunchAgents/dev.slopmax.plist` (`service.rs:54, 184-193`).
  - The serve lock decides which daemon runs. A brew-run daemon is `managed: false` (§4.2).
- **CLI on PATH.** The Homebrew cask uses `binary`. The in-app "Install Command Line Tool" button symlinks into `~/.local/bin` when that is on PATH, and otherwise shows a copyable `sudo ln -sf …/Contents/MacOS/slopmax /usr/local/bin/slopmax`. `/usr/local/bin` is root-owned and may not exist on Apple Silicon, so the app never writes there itself.
- **Signing:**
  - Developer ID, hardened runtime, no entitlements, not sandboxed.
  - Sign the nested CLI first, with `--timestamp`; code never lives in `Resources`.
  - `notarytool submit --wait`, then `stapler staple`.
  - **The standalone darwin CLI zip is notarized too.** A bare Mach-O cannot be stapled, so Gatekeeper checks the online ticket.
- **Updates.** Sparkle 2 over SwiftPM, with an EdDSA appcast.
- **Floor and architectures.** macOS 14; universal binary via `lipo` until the floor passes 26.
- **CI.**
  - `apple.yml` runs unsigned on PRs (build, Swift tests, XCUITest light and dark screenshots) and signed on tags.
  - The update → OtherVersion → restart flow is tested with `launchctl bootstrap` of the same plist, because `SMAppService.register()` needs user approval and cannot be automated. A per-release manual checklist covers SMAppService itself.
  - A nightly mac job sets a system proxy with `networksetup` and asserts that `Matcher::from_system()` sees it inside a bootstrapped agent.

### 5.3 GPUI on Windows and Linux

- **Thin client.** `slopmax-app` depends only on `api[client]` and `common::human` (CI-enforced). It runs one current-thread runtime and pushes `Change::{Live, History, Alert}` instead of the monolithic `Snapshot`, which today carries `Config` including `api_key` (`lib.rs:48-85`).
- **`view.rs` becomes wording only,** plus `next_change`.
- **Changes in GPUI:**
  - delete the 1 s whole-window `cx.notify()` (`main.rs:518-524`);
  - split `Main` into entities with `Entity::cached`;
  - dedupe `tray.set_title`;
  - reload history 8 s after a `Request` event and every minute.
- **Build.** `[profile.desktop]` with thin LTO and 16 codegen units (fat LTO took 10 min 47 s and 3.8 GB). Add a Windows CI job. The Windows login item is an HKCU Run key through `Command`. Linux notifications use notify-rust, already in the tree.
- **Gates on real hardware** (Windows with DX11, a Linux iGPU on Vulkan, and Linux with no GPU):
  - idle CPU ≤ 1% with the window open, ≈ 0 with the tray only;
  - < 1 wakeup/s;
  - PSS ≤ 100 MB;
  - the no-GPU case detected and warned about.
- **If it fails:** a wry + tao + tray-icon + muda shell around the served React UI (about 500 lines), and GPUI and `slopmax-app` are deleted. Not Slint, which would be a third UI.

---

## 6. Crates, build, release

### 6.1 Verdicts

| Crate | Verdict |
|---|---|
| tokio → 1.54.1 | **Keep** (RUSTSEC-2026-0386). Drop only `fs`: grep finds no `tokio::fs`. **Keep `process`**, which `notify.rs:176-180` uses; robust's list broke this. Audit `io-std` (no `tokio::io::std*` use found by grep; drop it if the build confirms). Move `rt-multi-thread` behind `hub`. `test-util` in dev only. |
| hyper 1.12, hyper-util, http, http-body-util, bytes, tower-service | **Keep.** This is the minimal HTTP/1 stack. |
| hyper-util `client-proxy` (all) + `client-proxy-system` (macOS/Windows only) | **Add.** It sees the macOS system proxy and parses NO_PROXY the way curl does. It pulls system-configuration (+core-foundation) on macOS and windows-registry on Windows, which the musl gate cannot see, so a **macOS size gate** is added (§6.4). |
| rustls 0.23.46 + ring, hyper-rustls, native-certs, webpki 0.103.16 | **Keep and update** (RUSTSEC-2026-0346..0349, -0382). aws-lc-rs is +2.3 MB. |
| serde, serde_json (preserve_order), toml_edit, memchr, base64, ring, libc, anyhow | **Keep.** preserve_order is needed at `provider/codex/wire.rs:139`. |
| thiserror 2 | **Add.** Proc macro only. |
| tokio-util (`rt`) | **Add.** `CancellationToken` + `TaskTracker`. Gate ≤ 15 KB. |
| mimalloc | **Opt-in** (`hub`). Default on musl only if the musl bench shows ≥ 10% CPU/req saved with ≤ +1 MB idle RSS. |
| jiff | **Not now.** DST is fixed in-house in phase 1: resolve each civil midnight with its own offset (`summary.rs:114-117`), and bound the HTTP-date year to 1970-2261 (`time.rs:109, 367-369, 399`). Re-decide when the Windows GPUI release happens, and take it only at ≤ 250 KB. |
| uniffi, swift-bridge | **No** (D11). |
| proptest, proptest-state-machine (or a ~100-line driver if it adds friction), gungraun (in `benches/`; its DHAT mode counts allocations), libfuzzer-sys + arbitrary (`fuzz/`) | **Add, dev only.** `dhat` only if gungraun's DHAT limits prove inadequate. |
| insta, tempfile, wiremock, loom, shuttle, schemars, cargo-mutants, cargo-vet, cargo-dist | **No.** A golden helper, a drop guard on `testkit::temp_dir` under `CARGO_TARGET_TMPDIR` (fixes the leak at `testkit.rs:18-22`), a duplex mock and paused-time races cover the real bugs. |
| axum, reqwest, clap, tracing-subscriber, tungstenite/fastwebsockets, notify, arc-swap, keyring, sonic-rs, h2, rustls-platform-verifier | **No.** Each costs 5-40 crates or 0.25-2.3 MB for no measured gain. Platform-verifier is reconsidered only after a macOS first-HTTPS latency measurement. |
| objc2 family, block2, async-channel | **Drop** in phase 7. |

**Crate count.** Today it is 63 against a budget of 70 (`mise.toml`). The additions are tokio-util, thiserror, thiserror-impl, ipnet and percent-encoding: **68, inside the budget, with no raise**. Robust's "70 → 74" started from the wrong baseline.

**Tools via mise:** cargo-nextest, cargo-llvm-cov (report only), cargo-deny, cargo-bloat, cargo-auditable, cargo-fuzz (nightly), xcodegen, bun.

### 6.2 Profiles

```toml
[workspace.package]  rust-version = "1.99"     # = mise pin; delete the msrv task (mise.toml:20 pins 1.89) and GPUI's 1.92 override
[profile.release]    opt-level = 3, lto = "fat", codegen-units = 1, strip = true, panic = "unwind"
[profile.desktop]    inherits = "release", lto = "thin", codegen-units = 16
[profile.profiling]  inherits = "release", lto = "thin", codegen-units = 16, strip = false, debug = "line-tables-only"
[profile.dev]        debug = "line-tables-only";  [profile.dev.package."*"] opt-level = 2, debug = false
```

- Use `--remap-path-prefix` for `$CARGO_HOME` and the checkout, or `trim-paths` if 1.99 has stabilized it.
- Evaluate `opt-level = "s"` once, against the speed gates; adopt it only within ±5%.

### 6.3 Release pipeline

- **Per version:** a signed tag and a GitHub release, with notes from CHANGELOG.md.
- **Native runners:** x86_64 musl on ubuntu-24.04; aarch64 musl on ubuntu-24.04-arm (today it is cross-built and never run, `release.yml:31-32`); both darwin targets on macos-15, lipo'd into a universal binary. Each runner smoke-runs `--version` and `serve` until `/healthz`.
- **Every artifact:** `cargo auditable build` and `actions/attest-build-provenance`.
- **CI hygiene:**
  - cargo-deny, with a separate config for the GPUI graph;
  - Dependabot for cargo and Actions;
  - Actions pinned by SHA;
  - Docker pinned to `rust:1.99-alpine` and an alpine minor;
  - `ts/` added to `.dockerignore` (956 MB of node_modules is in the context today).
- **Fix the red macOS check in phase 1:** `doctor::tests::cliproxyapi_matters_only_with_linked_accounts` (`doctor.rs:808`).

### 6.4 Size

| Change | Δ |
|---|---|
| Today (musl, measured in phase 1) | about 6.52 MB |
| React UI gz, no fonts | +about 300 KB |
| − dashboard.html | −100 KB |
| ~40 DTOs + registry + endpoints | **measured by a one-day cargo-bloat spike before phase 3** (estimates range from 120 to 250 KB) |
| Matcher (Linux), tokio-util | +about 50-75 KB |
| − rt-multi-thread, − boxing chains and `Value` paths | −50-150 KB |
| **Expected** | **6.8-7.0 MB** |

**Budgets:**
- **Phase 1:** the musl artifact's measured size + 64 KB. Robust's "≤ 6 MiB" is unreachable: 6.52 MB − 70 KB is still over.
- **Phase 3 onward:** **7,340,032 B (7 MiB) hard.**
- **macOS:** universal CLI ≤ 14.5 MB; app bundle ≤ 16 MB.
- **Every PR:** print the delta and `cargo bloat --crates -n 30` to the job summary. A delta over +64 KB must be explained.

---

## 7. Testing and gates

### 7.1 Testability first (phase 1-2 prerequisite)

- **Clock.** `Clock` on `Daemon`. `ManualClock` is tied to tokio's paused base, so wall time and timers move together. Use `tokio::time::Instant` everywhere; `forward.rs:16` uses `std::time::Instant` today. The 74 direct `Timestamp::now()` call sites move to the clock. The pool keeps its explicit `now` arguments.
- **`Transport::Memory`.** A hyper-util `Connect` that returns one end of `tokio::io::duplex`, served by an async `MockUpstream` whose channel-backed bodies can send, stall, error or end at chosen moments (about 150 lines; `ts/packages/core/test/support/memory-upstream.ts`). The inbound side drives `http1::serve_connection` over a duplex. Keep 3-5 real-TCP smoke tests.
- **`Daemon::start(Options) -> Handle`** with `stop()`. It replaces tests that call `proxy::handle` directly (`tests/proxy.rs:522-528`).
- **Runtime in tests:** `#[tokio::test(start_paused = true, flavor = "current_thread")]`.

### 7.2 Layers

| Layer | Tool | Scope |
|---|---|---|
| Unit | inline | pool, limits, registry, wire, report derivations, wording, time (DST spring and autumn with `TZ=America/New_York` per nextest process) |
| Integration | memory transport, paused time | failover, streaming outcomes (all 5 EndReasons), refresh races, quota, socket relay, API, events, lifecycle, restart, compat shim |
| Property | proptest (64 cases on PRs, 10k nightly) | Tap and opening give the same outcome under any chunk split. rawjson agrees with serde_json on generated documents and every one-byte cut, and never panics; **this gates the `is_valid` swap**. A restricted key's model equals serde_json's. Wire round trips. Time round trips; `from_http_date` never panics. WS framing. |
| Model-based | state machine | pick, block, observe, reset, sync, align, snapshot and time against a reference model |
| Fuzz | cargo-fuzz, nightly, 5 min per target, corpus committed | Tap, rawjson, ws::Reader, time parsers, `translate::decode` ×3, limits parsers |
| Golden | `testkit::golden` | CLI status, usage, doctor, `--help`; all API fixtures |
| Contract | Rust fixtures → TS strict decode, Swift strict decode; TS requests → Rust | §4.3 |
| Concurrency | paused-time races | 10 racing requests on an expired token give 1 POST. 3 `/refresh` calls give 1 poll per account. Stop during a refresh still saves. A snapshot swap during a pick keeps health on the right account. |
| Durability | in-process | N streams (some cut) then stop give exactly N ledger lines with the right reasons. A second daemon is refused. 16 concurrent `write_private` calls leave valid JSON. A corrupt `state.json` is quarantined. A CLI revocation is honoured by the next request. |
| Downgrade | CLI sandbox | run vN+1 then vN on the same home: vN starts, pins and settings survive |
| Coverage | llvm-cov | reported per critical module; no gate |

**Porting from TS.** About 600 TS tests are ported, using `ts/docs/parity/test-map.tsv` as the checklist:
- phase 1: F (ledger) and G (lifecycle);
- phase 2: A (pool), C (refresh), D (proxy, stream, inbound, failover), E (socket), L (wire);
- phase 3: H (settings), I (API and events), J (outbound), M (CLI);
- phase 4: B (quota) and K (engine services);
- phase 7: N (view model).

Target: about 1,100 tests in ≤ 8 s.

### 7.3 Deterministic perf gates (every PR)

1. **Instruction counts** (gungraun): one Claude and one Codex request in-process, plus `pick`, `Tap::feed`, `rawjson`, translate. Fail at +3% for request benches and +5% for micro benches, against committed baselines.
2. **Allocations** (gungraun DHAT): ≤ 40 per request; 0 from pick and settle.
3. **Syscalls:** `strace -c -f` over 1,000 sequential requests on the current-thread rig **with `SLOPMAX_LOG=info`**; today the rig never calls `log::init`. Assert per request: openat = statx = mkdir = 0, futex ≤ 1, writev ≤ upstream reads + 1, ledger writes = 1.
4. **Idle** (Linux): 4 fake accounts, 60 s. Voluntary context switches summed over `/proc/PID/task/*` ≤ 6, threads ≤ 2, RSS ≤ the phase-1 baseline (≤ 6 MB from phase 4). On a macOS runner, the same from `top -l` idle wakeups.
5. **Size and crates:** §6.4.

### 7.4 Wall-clock gates (nightly, or required on a pinned runner)

- **Against `bench raw`:** small at 32 at once ≥ 70% of raw throughput; 300 KB ≥ 80%; one-at-a-time p50 ≤ raw + 0.10 ms; CPU ≤ 2× raw.
- **Absolute targets** from the opening table, including:
  - 32-at-once p99 ≤ 15.0 ms on the default build;
  - the `hub` build ≥ 4,018 req/s;
  - **head-of-line:** 8 token-paced streams plus one 300 KB translated request, with p99 added inter-chunk delay ≤ 3 ms;
  - **cold-handshake:** one forced new TLS connection during 8 live streams adds ≤ 2 ms p99 to them.
- **Runs on both musl and glibc.**
- **Upstream idle timeout.** A provider idle-lifetime probe runs once in phase 2: open a connection, idle N s, then probe. It sets `pool_idle_timeout` (60 s today, `client.rs:425-433`) to min(measured − 5 s, 300 s).

---

## 8. Migration plan

Each phase ships as its own version with a signed tag and a release.

### Phase 1, v0.4: stop losing data; no disk per request (about 1-1.5 weeks, about 1,200 lines)

**Scope, in this order:**
1. `cargo update` for the advisories. Size budget on musl = measured + 64 KB. cargo-deny. Actions pinned. Fix the red macOS test.
2. **D5 before D1:**
   - `blocking()` helper;
   - `save_state` (with its fsync), refresh `store.save`, and admin `store.update` (`admin.rs:455-473`) all through it;
   - the clippy deny at the crate root.
3. Current-thread runtime (`main.rs:19`) and in `bench.rs:42`; tokio features trimmed (keep `process`).
4. Snapshot without per-entry mutexes; single-flight map; slot alignment; `ready()` with no I/O; rescan every 30 s (statx inline); the CLI calls `/sync` after every mutation, as an interim step.
5. Supervisor, token and tracker; loops into a `JoinSet`; shutdown order (§3.9); `/events` ends on stop.
6. Ledger Sink with line repair. Refresh saves before identify. `fsx` unique temp names and directory fsync. Serve lock. `state.json` quarantine.
7. Logging: one write per line, per-request line at debug, `debug!` exported.
8. In-house DST and HTTP-date fixes; Retry-After finite and capped at 7 days (`limits.rs:363-368`).

**Not in this phase:** the `is_valid` swap.

**Copy from:** `ts/packages/core/src/{accounts.ts:105-126, ledger.ts:221-290, refresh.ts:200-232, lock.ts}`.

**Gates:**
- strace: file syscalls = 0, futex ≤ 2.
- One at a time: p50 ≤ 0.80 ms, CPU ≤ 800 µs.
- 300 KB extra CPU ≤ +350 µs (`is_valid` is still in).
- Idle threads ≤ 2. Idle RSS recorded as the baseline.
- Tests:
  - N ledger lines after stop;
  - a hanging identify still saves;
  - a second daemon is refused;
  - 16 concurrent writes leave valid JSON;
  - with `/events` open, stop takes < 200 ms;
  - long-poll detector (tokio_unstable job) shows 0 polls > 1 ms over the integration suite;
  - CLI revocation → next request.

### Phase 2, v0.5: the hot path down to the floor (about 2 weeks, about 2,500 lines)

**Scope:**
- §7.1 infrastructure.
- Slot pool (≤ 3 locks). `AccountEntry` caches. In-place headers, `Uri::from_parts`, the beta memo. Raw rate-limit compare and pooled-header cache.
- `Relay` + `Settle` + `EndReason` + live set and sweeper. Typed taps. Codex hold.
- **`is_valid` → framing check, after proptest agreement and 10 minutes of clean fuzzing.**
- Socket relay:
  - one task per socket (today four tasks and two mpsc, `socket.rs:265-323`);
  - `type` peeked through rawjson;
  - word-wise masking and `write_vectored`;
  - per-socket PRNG;
  - 5 s finish after the client closes (`socket.rs:314-317`);
  - 600 s idle timeout;
  - tracked, with 1001 at stop.
- `bench raw` and `--hub`; gungraun and DHAT; idle-timeout probe.

**Copy from:** `ts/packages/core/src/proxy/{relay,settle,live,inbound,hold,socket}.ts`, `ts/packages/wire/src/{tap,opening,scan,lines}.ts`, `pool.ts:402, 724-749`, `ts/tools/bench/src/{budgets,gates}.ts`.

**Gates:** every Rust row of the opening table marked phase 2. Plus: "counted once" passes for all three lanes, streamed and whole, success and failure.

### Phase 3, v0.6: one contract, plus events (about 2.5 weeks, about 3,000 lines)

**Before the phase:** a one-day cargo-bloat spike on the DTOs and registry. If it is over 250 KB, cut Serialize/Deserialize derives to one direction per type before continuing.

**Scope:**
1. Pure-move commit: `slopmax-daemon` split; rawjson → wire; headers → net; `Home`-only paths; `AgentId` and `providers!`.
2. Fixture zero captured from the TS daemon.
3. `slopmax-api`: DTOs (including the derived facts moved from `view.rs` into `report.rs`), `ApiError`, `Route`, `settings!` with dual keys.
4. thiserror boundaries. `/slopmax/api/*` complete, including logins, imports, agents, keys, notify test, PATCH, own, redeem, `/shutdown {restart}`.
5. **Compat shim for `/slopmax/*`.**
6. EventBus, Status publisher and `Hello{version, exe}`.
7. `contract/` and TS strict decode in ts-ci.

**Port:** H, I, J, M.

**Gates:**
- every Route has a success fixture and an error fixture, and TS decodes all of them strictly;
- the SSE transcript matches fixture zero byte for byte, modulo volatile fields;
- the compat-shim test passes with today's `background.rs` client;
- no `json!` left in `api/` (grep in CI);
- the misspelled-key `compile_fail` doctest;
- no Status built while nobody watches;
- size ≤ 7 MiB.

### Phase 4, v0.7: single writer, idle near zero, clients on the API (about 2 weeks, about 1,800 lines)

**Scope:**
- **Single writer and state:**
  - deadline scheduler, panic-supervised;
  - single-flight `/refresh`; stale-poll fix; debounced saver;
  - `HistoryIndex`;
  - `state.json` absorbs pins, told and codex; old files read once and left in place;
  - nudge rules into `notify.rs` with `Event::Notice`.
- **Clients:**
  - `slopmax-app` becomes an API client on **every platform** (no Store or Config writes, SSE follower, `Change` split, `next_change`), so GPUI pins keep working once pins move into `state.json`;
  - the CLI's mutations go through the API whenever a daemon runs;
  - `status --watch` runs over SSE.

**Port:** B, K.

**Gates:**
- the idle gate, including RSS ≤ 6 MB;
- `/history` ≤ 1 ms after warm-up and 0 file reads;
- serve → `/healthz` ≤ 25 ms with a 12-month ledger;
- a panicking job keeps its schedule;
- the `cargo tree` rule (no slopmax-core in slopmax-app);
- app-core wakeups are 0 while nothing changes;
- downgrade test vN+1 → vN.

### Phase 5, v0.8: serve the React UI; retire the shim (about 1 week, about 300 lines Rust)

**Scope:** `build.rs` asset table; system font; the UI pointed at the Rust daemon; delete `dashboard.html` and **the compat shim**; release CI builds the UI.

**Gates:**
- asset headers by test;
- the UI's `bun test` passes against the Rust fixtures;
- a headless smoke test: page loads, key entered, Status rendered, browser sign-in against the mock provider;
- net size delta ≤ +250 KB, total ≤ 7 MiB.

### Phase 6, v0.9: SwiftUI macOS app (about 2.5-3 weeks, about 2,500 lines Swift)

**Scope:** all of §5.1-5.2, `daemon-info --json`, `apple.yml`, Sparkle, notarized DMG, cask and CLI zip, legacy plist migration.

**Gates (measured on an Apple Silicon Mac):**
- launch to panel < 200 ms;
- with the window closed: ≈ 0% CPU and < 1 wakeup/s (`powermetrics`);
- `footprint` ≤ 40 MB;
- bundle ≤ 16 MB universal;
- XCUITest screenshots;
- Contract and Loopback tests green;
- restart gap ≤ 1 s with agents retrying;
- the system-proxy nightly passes.

### Phase 7, v1.0: GPUI hardening for Windows and Linux (about 1.5 weeks, plus about 1 week if it falls back)

**Scope:** delete GPUI's macOS code and dependencies; tick removed; cached entities; desktop profile; Windows CI job and login item; gpui crates updated in lockstep; jiff decision; mimalloc-on-musl decision.

**Port:** N.

**Gates:** §5.3 on real hardware. On failure, build the wry shell and delete GPUI and `slopmax-app`.

**Not in this phase:** the Windows daemon release (named pipe or schtasks). That is a separate later milestone, because robust's "one week" estimate for it was not credible.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| A blocking call stalls every stream on current-thread | D5 lands before D1; clippy deny; tokio_unstable long-poll job; `hub` escape hatch |
| Current-thread loses multi-core concurrency | 32-at-once p99 ≤ 15.0 ms gate; head-of-line and cold-handshake gates; `hub` build gated ≥ 4,018 req/s |
| Inline ledger write on a slow filesystem | p99 gate; the joined std::thread fallback behind the same `Sink` |
| Dropping `is_valid` | Sequenced after property and fuzz evidence; strict validation kept for restricted keys |
| Effect SSE and error framing drift | Fixture zero captured first; strict decoding in both CIs |
| Swift duplicates logic | Decisions computed in `report.rs`; 1,000-line reopen trigger for a pure UniFFI surface |
| Snapshot staleness after external writes | CLI goes through the API; 30 s statx of accounts and linked sources; 401 forced reread; revocation test |
| Version skew and update restart gap | `Hello{version, exe}`; `managed` flag; kickstart after exit 75; ≤ 1 s measured gap |
| Downgrade after state consolidation | TOML keys unchanged; old files left in place for one release; no `deny_unknown_fields` on config or state; downgrade test |
| Size creep | 7 MiB hard; per-PR bloat delta; DTO spike before phase 3; macOS budgets |
| GPUI churn | It holds no logic after phase 4; wry fallback |
| Single maintainer and Apple credentials | Phase 6 needs a Developer ID p12, an App Store Connect API key and a Sparkle key as CI secrets; phases 1-5 do not depend on them |

### What was rejected, and why

- **UniFFI app-core in the Mac app:** a second runtime in the GUI, an unsafe exception, a toolchain, and a possible `try!` crash on panic. `VERDICT.md:181`'s condition (offline editing) is not met.
- **XPC, an owner UDS, named pipes:** loopback TCP plus the owner key already serves every client. The UDS has no measured benefit.
- **Actors for state:** a task hop per message is the cost being removed; std locks cost about 20 ns.
- **arc-swap, the notify crate:** `watch` plus a 3-statx rescan and `/sync` do the job.
- **A ledger writer thread or Flush-ack task:** a queue can lose records; an inline write survives `Drop` during teardown.
- **SSE coalescing and a custom hyper pool:** wait until the raw floor shows writev is the gap.
- **HTTP/2, aws-lc-rs, post-quantum key exchange:** +250 KB to +2.3 MB for no observed provider requirement.
- **jiff now:** both bugs have small in-house fixes; decide at the Windows release.
- **Renaming TOML keys to the TS names:** breaks downgrades for no product gain; the registry maps both.
- **Deleting `/slopmax/*` in phase 3:** it would break the dashboard and the desktop app for 2-4 releases.
- **insta, tempfile, dhat, schemars, wiremock, loom, shuttle, cargo-mutants, cargo-vet, cargo-dist:** one golden helper, one drop guard, a duplex mock, gungraun DHAT and paused-time races cover the real bugs.
- **typeshare, specta, ts-rs, swift-openapi-generator:** cannot express `_tag` unions, or produce TS-only `.d.ts`; 40 hand-written types are less machinery.
- **mimalloc by default:** it addresses multi-thread contention that current-thread removes; the musl gate decides.
- **`panic = "abort"`:** 5-8% size is not worth killing every in-flight stream.
- **`max_blocking_threads(2)` or `(8)`:** single-flight bounds flock waiters, so 4 suffices without starving DNS.
- **A 60 s blocking keep-alive:** it would keep an extra idle thread alive permanently.
- **Robust's tokio feature list:** it drops `process` (`notify.rs:176-180`).
- **Robust's phase-1 6 MiB gate:** unreachable by arithmetic.
- **Raising the crate budget to 74:** the baseline is 63, and the additions land at 68.
- **Slint:** a third UI codebase.
- **Offline editing in the apps:** read-only offline matches TS and keeps the daemon the only writer.

---

## 10. Panel scores and disagreements

| Judge | Winner | lean (perf / min / tests / ext / desktop / migration / overall) | robust (same axes) |
|---|---|---|---|
| perf-skeptic | lean | 8 / 9 / 7.5 / 7 / 8 / 8 / **8.2** | 7.5 / 5.5 / 8 / 8 / 6 / 6.5 / **6.9** |
| product-skeptic | robust | 8.5 / 9 / 7 / 7 / 7 / 6 / **7.3** | 8.5 / 6.5 / 8 / 8.5 / 7.5 / 6.5 / **7.7** |
| **Mean overall** | **lean** | **7.75** | **7.3** |

**Where the judges disagreed:**

1. **The macOS bridge.**
   - perf-skeptic: HTTP+SSE follows `VERDICT.md:181` and avoids a runtime in the GUI.
   - product-skeptic: UniFFI avoids a third view model and its version-skew and reconnect logic.
   - Resolved for HTTP+SSE, with the decision logic moved into `report.rs`, so Swift is left with only the reconnect loop (about 150 lines) and the formatting.
2. **Sequencing risk.**
   - product-skeptic weighed lean's inline fsync on current-thread and its early `is_valid` swap heavily; perf-skeptic weighed robust's unreachable gates and unmeasurable bench heavily.
   - Both were right; this plan fixes both.
3. **Desktop plan score.** perf-skeptic gave lean 8 and robust 6; product-skeptic gave lean 7 and robust 7.5, on the third-view-model argument.
4. **Migration plan score.** perf-skeptic gave lean 8 and robust 6.5; product-skeptic gave lean 6 and robust 6.5. Product-skeptic alone found that both proposals delete `/slopmax/*` before their clients move. Fixed here by D8 and the phase 4-5 order.
5. **Minimalism versus extensibility.** Both judges ranked lean higher on minimalism (9 against 5.5 and 6.5) and robust higher on extensibility (8 or 8.5 against 7). They disagreed on how much that matters for the overall score.

**Both judges flagged** that neither proposal gated concurrent p99, head-of-line delay or macOS artifact size. Those gates are added in §7.4 and §6.4.
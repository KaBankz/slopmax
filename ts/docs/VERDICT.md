# Rust or TypeScript for slopmax: the verdict

The question: which stack is right for slopmax, an app meant to be minimal, fast, invisible and deeply
system-integrated — a background daemon that pools accounts and fails over between them, a CLI, a web
dashboard, and a desktop app whose macOS side should look as if Apple made it.

**Verdict: keep Rust for everything that runs unseen (the daemon, the proxy, the CLI, the login
service), and do not ship the TypeScript runtime or Electron. The rewrite was still worth doing: it is
the better design in several places, and those designs and its React UI carry over.**

Measured 2026-11-01 on one quiet linux-x64 host, both stacks through the same harness
([`scripts/compare/`](../../scripts/compare/README.md)). Four judges (performance, code, system
integration, features) scored the stacks from these figures and the code; two adjudicators, one
starting from the best case for Rust and one from the best case for TypeScript, each checked the
judges against the code and reached their verdict independently. Both reached this one.

## What was measured

- **Rust:** v0.3.0 (`crates/`), Rust 1.99.1, release profile.
- **TypeScript:** `ts/` at 59d6812: Effect 4.1.1, Bun 1.4.4, and Bun 1.4.4-canary.1 for the
  AOT-compiled CLI; Electron 45.2.1.
- **Host:** 8 vCPU (4 physical cores × 2 threads), 30 GB RAM, no GPU.

### The proxy

Both proxies sit behind one mock provider (the Rust rig's) and get the same bodies and the same oha
loads, interleaved over 3 rounds. The proxies are pinned to cores 0-1, the mock to core 2 and oha to
core 3. Every run was 100% HTTP 200. The raw probe (`ts/tools/bench/raw.ts`) is about 60 lines of
`Bun.serve` + `fetch`: the least a Bun proxy can do.

| Load                                               |                    Rust |             TypeScript |     Raw probe | Mock alone |
| -------------------------------------------------- | ----------------------: | ---------------------: | ------------: | ---------: |
| Small, 1 at a time: p50                            |                 1.35 ms |            **0.80 ms** |       0.45 ms |    0.22 ms |
| Small, 32 at once                                  |         **4,018 req/s** |                  2,510 |         9,532 |     14,746 |
| 300 KB, 32 at once                                 |         **2,882 req/s** |                  1,549 |         3,618 |      6,833 |
| Codex small / 300 KB, 32 at once                   |       **4,169 / 2,913** |          2,247 / 1,411 | 9,523 / 3,317 |            |
| CPU per request, small, 32 at once                 |                  985 µs |             **491 µs** |               |            |
| The same loads held to **one** CPU: small / 300 KB |           1,476 / 1,089 |      **2,034 / 1,198** | 6,545 / 2,340 |            |
| Memory idle (RSS / PSS), peak                      | **8.0 / 5.0 MB, 46 MB** | 59.4 / 57.0 MB, 153 MB |               |            |

Rust's throughput lead comes from tokio using every core. Per CPU, this TypeScript proxy does more,
and it adds less latency per request.

That says more about the shipped Rust code than about Rust. On every request it reads the account file
from disk with blocking I/O (`crates/slopmax-core/src/proxy/mod.rs:178-183`). For each batch it creates
the usage-ledger directory and opens the file through `spawn_blocking` (`ledger.rs:84-136`). It writes
each SSE chunk separately and hands work between threads: an strace counts about 34 `writev` and 28
`futex` calls per small request (`probe-rust.sh`). The TypeScript rewrite fixed the same three things
in its speed pass (C17).

None of this matters at product rates. A model answer takes seconds; either stack adds about a
millisecond and has hundreds of requests per second to spare.

### The CLIs as shipped

|                                           |             Rust |                TS, AOT (shipped) | TS, `--no-aot` fallback |
| ----------------------------------------- | ---------------: | -------------------------------: | ----------------------: |
| Binary / xz -9e                           | **6.5 / 2.2 MB** |                   71.5 / 23.9 MB |         118.3 / 41.7 MB |
| `--version`                               |       **2.1 ms** |                          10.4 ms |                 15.5 ms |
| `status --json` (4 accounts, daemon down) |       **2.7 ms** |                          72.1 ms |                123.5 ms |
| `serve` until `/healthz` answers          |        **25 ms** |                            85 ms |                  163 ms |
| Daemon idle (RSS / PSS)                   | **8.6 / 6.6 MB** |                   69.3 / 67.0 MB |          81.6 / 79.4 MB |
| Clean release build                       |       2 min 18 s |                         **29 s** |                     8 s |
| Third-party code in the binary            |        63 crates | 4 npm packages + the Bun runtime |                    same |

TypeScript's `status` spends about 50 ms of its 72 ms loading and initialising the engine's module
graph before it does any work.

### The desktop apps (Xvfb, no GPU)

Each app ran against its own demo daemon with the same fake accounts. Both draw the same Overview.

|                                   |                            Rust (GPUI) |             TypeScript (Electron + React) |
| --------------------------------- | -------------------------------------: | ----------------------------------------: |
| Download, tar.xz                  |                            **13.5 MB** |                                  114.6 MB |
| Unpacked                          | **45.4 MB** (38.8 MB app + 6.5 MB CLI) | 345.4 MB (Electron 234.5 MB, CLI 71.5 MB) |
| Launch to a visible window        |                             **248 ms** |                                  1,053 ms |
| Processes                         |                                  **1** |                                         7 |
| Memory with the window open (PSS) |                             **154 MB** |                                    342 MB |
| With the daemon idle              |                             **161 MB** |                                    409 MB |
| Idle CPU                          |    97% (software rendering; see below) |                                  **1.7%** |

Without a GPU, GPUI renders through Mesa's software Vulkan, and that is where its CPU and much of its
memory go. It also repaints the whole window every second for its countdowns. On a Mac with Metal these
two figures are unmeasured. Measuring them is the first thing to do before anyone builds on GPUI.

### Code and the development loop

|                                            |      Rust |        TypeScript |
| ------------------------------------------ | --------: | ----------------: |
| Product code (lines, not blank or comment) |    26,114 |            31,427 |
| Test code                                  |    15,330 |            31,512 |
| Tests                                      |       491 | 1,546 (+6 opt-in) |
| Type check after an engine API change      |     1.4 s |             1.2 s |
| Build before running a change              |     3.0 s |              none |
| Full test suite                            | **6.5 s** |              60 s |

## The scores

| Dimension                           |  Rust |      TS | Who wins, in one line                                                                                                                                              |
| ----------------------------------- | ----: | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Performance and footprint           | **8** |       4 | About 10× less memory idle and 4-25× faster starts, all from the runtime. TS's per-CPU lead is Rust code that can be fixed.                                        |
| Code quality and extensibility      |     7 | **7.5** | TS models errors, resources and settings better; one Schema drives settings, the API and the UI. Every Rust gap is a fix of days.                                  |
| System integration and distribution | **7** |     4.5 | The OS code is a line-for-line port. Rust leads on what can't be ported: a static binary, the size, notarizing without JIT entitlements.                           |
| Features and UX                     |     6 |   **7** | TS has one React UI for the dashboard and the window, OAuth sign-in in the browser, and notifications off macOS. But that UI is portable, and Rust _feels_ faster. |

The adjudicators' corrections, from checking the judges against the code:

- The UI lead belongs to the React app, not to the TypeScript backend. That app speaks only HTTP and
  SSE to `/slopmax/api/*`. The catch is that its client is built from the Effect `HttpApi` in
  `@slopmax/domain`, so a Rust daemon serving it must reproduce that wire contract.
- The judges said the Electron app registers a login item. It does not; neither app does. Only the
  daemon starts at login.
- The pool's split models (Health and Activity, Session and Placed) were blamed on JavaScript. They
  come from building Effect Schema classes on the hot path, a library choice and not a language limit.

## Inherent, and fixable

**Inherent to the runtime, for TypeScript.** These count most for an always-on, invisible app.

- A floor of about 60 MB of memory and about 10 ms of startup: JavaScriptCore plus Bun.
- The garbage collector's peak and tail jitter.
- JavaScript runs on one thread.
- `slopmax run` cannot exec, so a Bun process stays alive for each agent session.
- `fetch` has no connect timeout.
- The macOS JIT entitlements Bun and Electron need before they can be notarized.
- Electron's 235 MB, its 7 processes, and its Chromium security releases, with no updater to deliver
  them.

**Inherent to Rust.** Most of these cost the developer, not the user.

- A slower edit-to-run loop: a 3 s debug build, and 2-11 minute release builds.
- More code written in-house: the date module, the HTTP wrappers, WebSocket framing.
- GPUI is pre-1.0, with 553 crates.

**Fixable in the Rust code:**

- Cache accounts in memory.
- Have one usage-ledger writer that keeps its file open, and drain it at shutdown. Today the writer is
  a detached task nothing waits for (`ledger.rs:84-99`, `daemon.rs:131-132`), so the last few usage
  records can be lost when the daemon stops.
- Coalesce SSE writes.
- Give settings one typed table instead of matching their names as strings in about 8 places.
- Use typed DTOs for the admin API.
- Use `thiserror` at the provider boundary, and `JoinSet` for background tasks.
- Post notifications off macOS.
- Have the desktop CI build an `.app`.

The adjudicators put this at about 2-3 weeks, with the TypeScript code as the design to copy.

**Fixable in the TypeScript code:**

- The installer refuses CPUs without AVX2 (`ts/install.sh:34-36`), while `RUNTIME.md` says the
  default runtime does not need it.
- The shipped CLI and the Docker image track a floating Bun canary.
- `status` loads the whole engine.

## Recommendation

1. **Keep the Rust daemon and CLI as the product.** `ts-release.yml` stays manual-only, so no tag ever
   releases the TypeScript build.
2. **Port the rewrite's wins into Rust** (about 2-3 weeks): the hot-path and ledger fixes above, the
   typed settings table and API DTOs, typed provider errors, scoped background tasks, the event stream
   in place of polling, and the UX additions in `parity/NOT-PORTED.md`. Then run `compare.sh` again,
   with a raw hyper forwarder added as Rust's floor.
3. **Web dashboard:** serve the React UI (`ts/apps/ui`) from the Rust daemon in place of
   `dashboard.html`, with the TypeScript client's types generated from the Rust DTOs (or a contract
   test of the TS client against the Rust daemon). That keeps OAuth sign-in in the browser and ends
   Rust's two drifting UIs. It takes a few weeks. If that is too much, add sign-in to `dashboard.html`.
4. **macOS:** neither GPUI nor Electron can look as if Apple made it; both screenshots are the same
   custom-drawn design. The only route is a small SwiftUI/AppKit menu-bar app over the daemon's API. It
   would use:
   - `MenuBarExtra`, system controls and the system font;
   - `LSUIElement`, so there is no Dock icon;
   - `SMAppService`, to start the app and the daemon at login;
   - `UNUserNotificationCenter`, for notifications;
   - Sparkle, for updates;
   - Developer ID signing and notarization;
   - the 6.5 MB Rust CLI inside the bundle.

   Expose `slopmax-app` through UniFFI only if editing must work while the daemon is stopped.

5. **Linux and Windows desktop, last:** either GPUI, once it is measured on a real GPU and stops
   repainting every second, or the React UI in a system webview (wry or Tauri) over the Rust daemon.
   Not Electron.

**What would change this:**

- A Bun release on a stable channel that brings the AOT daemon to about 20 MB idle and under 30 ms to
  answer, and that can exec. That would make an all-TypeScript product, one language for one
  maintainer, the stronger choice.
- Dropping the Apple-native requirement. That makes one cross-platform UI the plan, though still
  better hosted in a system webview over Rust than in Electron.
- GPUI measured on a Mac with Metal idling near 0% CPU and well under 100 MB. That makes an
  all-Rust app, GPUI included, simpler than adding Swift.
- The Rust hot-path fixes not bringing one-at-a-time latency under TypeScript's 0.80 ms. That would
  point to a deeper problem in the Rust core.

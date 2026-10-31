# @slopmax/app: port notes

The TypeScript port of `crates/slopmax-app`: the desktop app apart from any
UI. It holds the app's state (`Snapshot`, in a `SubscriptionRef`), runs its
actions against `@slopmax/core`, works out what a window draws (`view`) and
which notifications to post (`alerts`), and serves all of it to the Electron
shell over stdio (`protocol`, `host`).

## Files

| Rust                         | TypeScript        | Tests (`test/`)                    |
| ---------------------------- | ----------------- | ---------------------------------- |
| `src/lib.rs`                 | `src/lib.ts`      | `lib.test.ts`                      |
| `src/view.rs`                | `src/view.ts`     | `view.test.ts`                     |
| `src/alerts.rs`              | `src/alerts.ts`   | `alerts.test.ts`                   |
| (`pub use history`, modules) | `src/index.ts`    |                                    |
| (new: the shell's protocol)  | `src/protocol.ts` | `protocol.test.ts`                 |
| (new: `slopmax app-host`)    | `src/host.ts`     | `host.test.ts`, `protocol.test.ts` |
| (test support)               |                   | `support/sandbox.ts`               |

`lib.rs` holds real code, so it is `lib.ts`; `index.ts` is the public
surface: `lib.ts`'s types, `App`, `start`, `defaults`, `adopt`, and
`bundledCli` (not the helpers exported for tests), and `alerts`, `view`,
`protocol`, `history` (the core's, APP-105) as namespaces, with `runHost`,
`model`, `dispatch`.
`package.json` exports `.` and `./protocol`; the protocol module imports
`effect` alone, so Electron's main process imports
`@slopmax/app/protocol` without the core.

`view.ts` imports only types from `lib.ts` (`Setting`, `Snapshot`, …), and
`lib.ts` imports `view.settingChanged`, so the modules depend on each other
by type only, as the Rust's `crate::` uses do; oxlint's `import/no-cycle`
passes.

## The shapes

- **`App`** is a `Context.Service` (`@slopmax/app/App`) whose shape is
  `AppShape`; `App.layer` starts it with `defaults()`, `App.layerWith(options)`
  with `Options { notify, cli }`. `start(options)` is the Rust's
  `App::start_with` as an Effect in a scope: the scope's end stops the
  watcher, a sign-in, and anything an action left running. The proxy the
  app started keeps running, as in Rust.
- **Actions** are the Rust's methods, camelCased. Each returns
  `Effect<Task>` at once: the part that is only a change to the snapshot
  (`redeeming = id`, `doctor = Running`, a sign-in's `Starting`) is done
  before it returns, the rest runs in the app's scope as the `Task` fiber,
  which a caller may await (the host does, to send `Done`) or leave, as a
  GPUI window leaves the Rust's spawned tasks.
- **The snapshot** is a `SubscriptionRef<Snapshot>` the app alone writes;
  a UI reads it through `changes` (`SubscriptionRef.changes`, the Rust's
  `watch::Receiver`) and `snapshot` (its current value). Optional
  fields are present and `undefined`, so updates spread (`{ ...s, notice:
undefined }`).
- **The watcher** is one fiber: a round (live report, else the offline one
  from disk; nudges; the snapshot), a full look on the first round, every
  15 s, or when an action asked, then `Effect.raceFirst(sleep 2 s, take
look)`, where `look` is a dropping queue of one (`Notify::notify_one`'s
  stored permit). All times come from `Clock`.
- **A sign-in** is a task forked into the app's scope;
  `cancelSignIn` interrupts it (which closes the core's callback listener)
  and ends the paste queue (`Queue.end`, the core's `Pasted`). The core's
  `Prompt` tells events synchronously; they go through an unbounded queue
  that a child fiber applies to the snapshot in order (`progress`).
- **Alerts** go to an unbounded `Queue<Alert>`, handed out once by
  `alerts` (APP-047). `Told` is an immutable value (`Told.fresh` returns the
  new value, whether it changed, and what is new); the app holds the
  current one. A semaphore of one stands for the Rust's `Mutex<Told>`: a
  watcher round's fresh, save, and enabled check, and `setNotifications`'
  change and save, each run whole, so neither undoes the other and the
  file's saves land in order. Keys are put in the Rust's `BTreeMap` order
  when saved; in memory the order does not matter.
- **Named effects** use `Effect.fn` (`App.start`, `App.act`, `App.look`,
  `App.tellNudges`, `Told.load`, `runHost`, …), so the watcher's rounds and
  each action carry a span.
- **`Setting`** is a `_tag` union with one `value` field; `Setting.write`
  checks it with the core's `liveValue` and writes it with `Config.set`.
- **The CLI the app runs** (APP-014) is `bundledCli`: `slopmax` beside
  the executable, then `../bin/slopmax`, then the first on `PATH` (read
  through `Config`). `defaults()` first tries `background.currentExe`,
  since the desktop's engine is `slopmax app-host`, the CLI itself; from
  source (where the program is Bun) it falls back to `bundledCli`.

## The host protocol

`protocol.ts`, version `VERSION = 1`. Newline-delimited JSON, one message
per line, every message a `Schema.TaggedUnion` member:

- host → shell (`Event`): `Hello { protocol, version }` first; `View { view
}` whenever what it draws changes (deduplicated by its encoded text);
  `Notify { key, title, body }` for each alert; `Prompt { signIn? }` when a
  sign-in's prompt changes, and once without one when it ends; `Done { id,
error? }` when a request's task ends (`error` only when it was
  interrupted); `Rejected { error }` for a line that is not a request;
  `Fatal { message }` when the app cannot start (then `runHost` fails).
- shell → host (`Request { id, action }`): every `App` action as an
  `Action` member (`SignIn`, `Paste` for the sign-in prompt's answer,
  `Set { setting }`, …) and `Window { shown }`: while a window or the panel
  shows, the host redraws every second for the countdowns.
- **`View`** is what the renderer draws with no logic of its own: the
  proxy (state, version, the header line, the sidebar foot, Settings'
  status, the panel's line, the Start/Stop button and its request); the
  menu bar title; `status`, `attention` (with `Sign in…`/`Redeem…`/`Show`),
  `routing`; the sidebar's providers (count, worst attention tone); each
  group as `view.groups` gives it plus `basis`, `segmentsTip`, `across`,
  `ready`, `pinned`, the panel's `troubled` accounts; each row plus its
  `faded` cells, its `…` menu (items with labels, enabled states, and the
  request each sends), and its credits with `redeeming`, `reason` (held, or
  `Start the proxy to redeem one`), `canRedeem`, the `Redeem` request, and
  the auto-redeem policy; `canRefresh`, `canOpenDashboard`; the notice and
  the sign-in card; agents (line, Connected/Not connected, Connect/
  Disconnect and its request); Start at login (and its request); every
  Settings control (strategies with their requests, switches, steppers with
  their next values, every detail sentence); client keys and a new key;
  the doctor's findings (as the window words them) and `canCheck`; the
  ranges; the ledger histories as JSON with their left-on-the-table line.
- `runHost(options = defaults())` needs `Stdio` (the CLI provides Bun's),
  writes every event through one writer fiber, and on stdin's end cancels
  in-flight requests, closes the app's scope, flushes what is left, and
  returns. The app's scope is acquired with `Effect.acquireUseRelease`, so
  it also closes when the host fails to start or is interrupted (a signal
  to the CLI, a caller's race): the watcher, a sign-in and its callback
  listener, and running actions stop with it. stdout carries only the
  protocol: the core logs to stderr, and the watcher reports a broken round
  there too.
- Requests are started in the reader, one after another in the order they
  arrive, as a GPUI window calls the app's methods on its thread; only each
  task's wait for `Done` runs in a fiber of its own. So a `Paste` right
  after a `SignIn` reaches the sign-in that request started.
- Events are encoded with the protocol's schema without throwing
  (`encodeEvent` returns a `Result`). One that does not fit (a fault in the
  view) is said on stderr and left out, and the view keeps flowing.
- A history's JSON (serde's `40.0` numbers as plain ones) is built once
  per loaded history by a small typed walk over the core's encoding.

## Tests

| Rust file   | Rust tests | Ported (Rust name) |  Added | Passing (Linux, Bun 1.4.4) |
| ----------- | ---------: | -----------------: | -----: | -------------------------- |
| `alerts.rs` |          4 |                  4 |      3 | 7 of 7                     |
| `lib.rs`    |          8 |                  8 |      7 | 15 of 15                   |
| `view.rs`   |         27 |                 27 |      3 | 30 of 30                   |
| (protocol)  |          — |                  — |      5 | 5 of 5                     |
| (host)      |          — |                  — |      4 | 4 of 4                     |
| **Total**   |     **39** |             **39** | **22** | 61 of 61                   |

The added `lib.test.ts` tests start the real `App` in a temporary home
(`support/sandbox.ts`: `HOME`, `SLOPMAX_HOME`, `SLOPMAX_LISTEN`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME` inside it, `SLOPMAX_NO_SERVICE` set, no
CLI to start a proxy with), and one runs the real proxy in-process on a free
port. `host.test.ts` pipes requests into `runHost` through
`Stdio.layerTest` and reads its events: hello, views, settings, client
keys, today's ledger, the doctor, `Window`, refused lines, a clean stop on
stdin's end with the proxy left running; a fatal config; and, without a
proxy, an expiring limit reset told once as `Notify` and offered in its
row; and an interrupted host, after which nothing more reaches the proxy's
address. The view tests also pass under `TZ=America/New_York`.

`bun check -b`, `oxlint`, and `bun check --aot src/index.ts` (Bun canary)
are clean for the package; the AOT check's only warnings are Effect's own
`RegExp`s built from strings.

## Deviations from the Rust

- Actions return their task (above) instead of nothing.
- `Notice.shown` is the `Clock`'s time; fractions are plain numbers, not
  `f32` (`test/NOT-PORTED.md`).
- `loadHistory`/`loadToday` read the ledger on the event loop (the file
  reads yield; bucketing does not), as the core's `GET history` does
  (core PORT.md, D2); Rust reads it in `spawn_blocking`.
- The watcher survives a round that breaks (a defect), saying so on
  stderr; a panic would have ended the Rust's task.
- An action that dies reads `the action stopped: ` and the defect's
  message, where Rust's has `task N panicked with message …` after it.
- `open_dashboard` opens the browser in a task (the core's `openBrowser`
  is an Effect), where Rust called it in place.
- The default CLI is this program first when it is slopmax (above).

## Left for later

- The Usage and Performance pages' chart words (axes, tooltips, `dollars`,
  `priced`: DESK-063..075) are the desktop's own formatting in the Rust,
  not `view.rs`'s; the view carries the histories as JSON for the renderer
  to draw. Moving those helpers here would let the view word the charts
  too.
- No test drives a sign-in through the host end to end (it would need an
  OAuth stand-in for a real provider); `Prompt` is covered by the view's
  sign-in wording and the protocol round trip.
- Notification availability (DESK-121/122: macOS only in GPUI) is the
  shell's to decide; the host sends every alert.

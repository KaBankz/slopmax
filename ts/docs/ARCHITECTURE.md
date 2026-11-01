# Architecture

This is the binding design for slopmax in TypeScript. Builders follow it and
judges check against it. It keeps every feature in `parity/` and nothing else
of the Rust slopmax. It is written in Effect 4.1 and Bun, not translated from
Rust. The Rust-shaped first port (`/tmp/slopmax-ts-reference/ts`, branch
`ts-reference/rust-shaped`) is only a reference for subtle behavior.

Where this document and `CONVENTIONS.md` disagree, this document wins. Each
such place is named in §1.3 and recorded in `DECISIONS.md`.

## 0. How this design was chosen

Three designs were written (`/tmp/slopmax-design/{simple,perf-first,effect-max}.md`)
and scored by two judges. Both picked **simple.md**: three packages, about ten
services, providers and agents as values in registries, one `HttpApi` plus one
SSE event stream for every front end, and no app-host process. This document
starts from simple.md and grafts the judges' recommendations onto it. Each
disagreement is settled below. The rest of the document is the result.

| Question                                  | simple.md                                        | Decision here                                                                                                                                                                                                                                                                                                                                      | Why                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The inference hot path                    | `HttpRouter` + `HttpClient` + `Stream` tap       | **A native byte lane, with Effect making every decision** (§6): `Bun.serve` classifies the request with a pure function, one Effect per request runs on a prebuilt context, upstream `fetch` runs inside `Effect.callback`, and bodies are native `ReadableStream`s driven by pure state machines. The admin API, hub and UI stay on `HttpRouter`. | Judge 2 asked for this lane. Judge 1 asked for it as a fallback behind perf gates. Building the slow lane and then the fast one would mean writing the hot path twice. The measured gap is 2.2–2.9x for small requests, 2x for 300 KB bodies, and 193 MB against 121 MB peak RSS. The constraints say "as fast as possible, light on memory". Every timer, retry, verdict and state change stays in Effect. |
| Trace headers to providers                | not handled                                      | **Never sent.** Inference uses native `fetch` with exact headers. Every `HttpClient` is built with `TracerPropagationEnabled = false` and `TracerDisabledWhen = () => true`. `SLOPMAX_TRACE=1` turns on local spans only.                                                                                                                          | `HttpClient` adds `traceparent` and `b3` by default (`HttpClient.js:293/1057`). Extra headers on subscription traffic are an account risk.                                                                                                                                                                                                                                                                  |
| Token refresh races                       | `forkDetach` + `join`, lock wait uninterruptible | **`FiberMap.run(id, rotate, { onlyIfMissing: true })`** in the `Accounts` layer's scope. Only the stretch from the token POST to the save is uninterruptible. A `RateLimiter` bounds forced refreshes.                                                                                                                                             | Fibers are tracked, joined by every caller, and interrupted cleanly at shutdown.                                                                                                                                                                                                                                                                                                                            |
| Reloading settings and accounts           | 2 s polling                                      | **`FileSystem.watch`, debounced 100 ms, plus a 30 s rescan as a backup**. They feed `SubscriptionRef`s. Status reports are pushed on change, not polled.                                                                                                                                                                                           | An idle daemon does no work, and changes show up at once.                                                                                                                                                                                                                                                                                                                                                   |
| Account reads on the hot path             | disk read per attempt                            | **An in-memory cache.** It is re-read from disk only under the account lock before a refresh, after a 401, and on watcher events.                                                                                                                                                                                                                  | No disk read per attempt, and rotation by another process is still seen.                                                                                                                                                                                                                                                                                                                                    |
| `ProviderId`                              | a brand checked at run time                      | **A literal union** (`Schema.Literals`), with registries typed `Record<ProviderId, Provider>`.                                                                                                                                                                                                                                                     | `Match` stays exhaustive and the compiler forces a registry entry for every id. Adding a provider is one file, one literal, and one registry line.                                                                                                                                                                                                                                                          |
| Pins                                      | in `config.json`                                 | **In `state.json`**, written by the daemon (or offline under the serve lock).                                                                                                                                                                                                                                                                      | Pins are runtime state, not user settings.                                                                                                                                                                                                                                                                                                                                                                  |
| `state.json` writers                      | no lock                                          | **The daemon holds a `serve` lock for its whole life.** An offline CLI write takes the same lock, so it cannot race a starting daemon.                                                                                                                                                                                                             | This closes judge 2's lost-write race.                                                                                                                                                                                                                                                                                                                                                                      |
| Lock liveness                             | pid, or older than 2 minutes                     | **pid plus process start time** (`/proc/<pid>/stat` on Linux, `ps -o lstart=` on macOS). There is no blanket age rule.                                                                                                                                                                                                                             | A reused pid cannot fake a live holder, and a long refresh is never stolen.                                                                                                                                                                                                                                                                                                                                 |
| The held start                            | `timeoutOption` on each pull (loses a chunk)     | **The pending read is kept** when the 3 s wait runs out. The relay awaits that same read first.                                                                                                                                                                                                                                                    | All three designs dropped the in-flight chunk. The reference port's `proxy/start.ts` shows the fix.                                                                                                                                                                                                                                                                                                         |
| Settling a finished stream                | `Stream.onExit`                                  | **A once-guard pushes a `Settlement` with `Queue.offerUnsafe`.** One `Settler` fiber in the daemon's scope applies it.                                                                                                                                                                                                                             | This is exactly once with no fiber per stream, and it avoids perf-first's `runSyncWith`, which throws if anything inside goes async.                                                                                                                                                                                                                                                                        |
| Stalled streams                           | a timer per chunk                                | **One 10 s sweeper** over a `LiveStreams` set. Shutdown drains the same set.                                                                                                                                                                                                                                                                       | One timer for all streams, and the per-chunk cost is one assignment.                                                                                                                                                                                                                                                                                                                                        |
| WebSocket relay behind an upstream proxy  | refused                                          | **Kept.** Under Bun, `ws` accepts `{ proxy }` and still shows the 101's headers. Probed in `/tmp/archprobe/p.ts`: `gpt-x e1` with one CONNECT through the proxy.                                                                                                                                                                                   | Feature parity. The judge asked for a check before promising it, and the check passed.                                                                                                                                                                                                                                                                                                                      |
| WebSocket backpressure                    | `Queue.bounded(64)`                              | **Upstream to client:** `ws.pause()` when `send` returns −1, then `resume()` on Bun's `drain`. **Client to upstream:** close with 1013 when `up.bufferedAmount` passes 64 MiB.                                                                                                                                                                     | Bun's callbacks are synchronous, and a bounded queue fed from them gives no backpressure. `pause` and `resume` exist under Bun (probe `q.ts`).                                                                                                                                                                                                                                                              |
| The desktop window                        | loads the daemon's `http://127.0.0.1` page       | **The renderer is bundled with the app** and served from `app://slopmax/`. Main forwards `app://slopmax/slopmax/api/*` to the daemon and adds the key there, so the renderer never holds it.                                                                                                                                                       | There is no port squatting, the preload is never exposed to a foreign origin, and the window still renders an offline mode while the daemon is down.                                                                                                                                                                                                                                                        |
| Desktop while the proxy is stopped        | `offline.html`                                   | **An offline mode**: main runs `slopmax status --json` and `slopmax doctor --json` and shows the report, the doctor and a Start button. A daemon on another version is restarted, or flagged with DOC-004 when a login service runs it.                                                                                                            | APP-015's offline report is kept, and the window can never talk to an API of another version without saying so.                                                                                                                                                                                                                                                                                             |
| Detached `serve`                          | `node:child_process`                             | **`ChildProcess.make(..., { detached: true })` + `handle.unref`**. The spawner's finalizer skips unref'd children (`NodeChildProcessSpawner.js:502`). The daemon writes its own log (`serve --log <file>`).                                                                                                                                        | There is no escape hatch.                                                                                                                                                                                                                                                                                                                                                                                   |
| System CA roots (NET-007)                 | not handled                                      | **`tls.getCACertificates("system")` merged with Bun's bundled roots**, passed as `tls.ca` to every outbound `fetch` and `ws`.                                                                                                                                                                                                                      | Proxies that intercept TLS and work with the Rust keep working.                                                                                                                                                                                                                                                                                                                                             |
| Two contracts (effect-max)                | —                                                | **One `SlopmaxApi`** plus `HubApi` (protocol fixed by T3 Code). No `LiveRpcs`, no MessagePort Rpc, no OTLP or Prometheus, no Schema AOT compiler, no Scalar.                                                                                                                                                                                       | These add build time and drift risk and no feature.                                                                                                                                                                                                                                                                                                                                                         |
| CLI actions (perf-first `Mode`/`Actions`) | —                                                | **One implementation per action**: the core service method. A CLI command calls it in process, or calls the endpoint whose handler calls it. Never both kinds of code for one action.                                                                                                                                                              | This avoids writing every action twice.                                                                                                                                                                                                                                                                                                                                                                     |
| Tests on files                            | temp dirs                                        | **An in-memory `FileSystem`** (`FileSystem.makeNoop` plus a map) for store tests. A temp home is kept for the few real-file tests (locks, watch, modes).                                                                                                                                                                                           | CONVENTIONS prefers in-memory layers.                                                                                                                                                                                                                                                                                                                                                                       |
| Performance                               | a bench in prose                                 | **A bench rig in `tools/bench` and CI gates** on the AOT binary (§16).                                                                                                                                                                                                                                                                             | Speed is proved in CI, not just claimed.                                                                                                                                                                                                                                                                                                                                                                    |
| Chunk 8 (proxy plus relay)                | one chunk                                        | **Split**: the HTTP proxy is C9 and the WebSocket relay is C10.                                                                                                                                                                                                                                                                                    | Both judges said it was too large.                                                                                                                                                                                                                                                                                                                                                                          |

API names corrected for Effect 4.1 (each was checked in the installed `.d.ts`):
`Stream.flattenIterable`/`Stream.mapArray` (there is no `Stream.mapConcat`),
`Result` (there is no `Either`), `DateTime.nowUnsafe` (not `unsafeNow`), no
`Schema.NonEmptyTrimmedString`, `Schema.RedactedFromValue` for secrets read
from files, and `Schema.TaggedError<Self>()(tag, fields, { httpApiStatus })`.

---

## 1. Rules that bind every package

### 1.1 Effect owns every decision

Planning, placement, readiness, refresh, verdicts, the 400 ms retry, the 3 s
held start, block and throttle bookkeeping, persistence, schedules, the ledger,
notifications, the CLI and the admin API are all Effect. They use services,
layers, `Clock`, `Schedule`, typed errors and `Schema`. Only bytes move
natively, and only in the places listed in §1.3.

### 1.2 Pure logic stays plain

The byte scanner, taps, transcoders, router, pool model, window math, pricing,
ledger views, verdicts, header shaping, agent config edits, notification
watch/nudges, report building and the UI view model are plain functions over
Schema-typed data. They take `now` as an argument. They are not wrapped in
`Effect`.

### 1.3 Where slopmax drops to Bun APIs, exactly

Nothing else may touch Bun or Node directly. oxlint enforces the bans
(`no-restricted-imports`, `no-restricted-globals`) per directory.

| Place              | Bun or Node API                                                              | Why (measured)                                                                                                              | The typed seam                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Front door         | `Bun.serve({ routes, fetch, websocket })`                                    | `HttpRouter` costs about 23% (small, c32). `BunHttpServer.upgradeWith` rejects custom 101 headers (`BunHttpServer.js:433`). | `core/src/server.ts`: `Server` service. `core/src/proxy/classify.ts` is a pure `classify(...)`.                         |
| Inference upstream | `fetch(url, { decompress: false, proxy, tls, signal })` in `Effect.callback` | `HttpClient` costs 33–45%. `Effect.callback` beats `tryPromise` by 11%. Exact headers, so no trace headers.                 | `Upstream.send(UpstreamRequest): Effect<Response, Unreachable \| TimedOut>`                                             |
| Response bodies    | `ReadableStream` with `highWaterMark: 0` over the upstream reader            | A `Stream` body costs 25–30%.                                                                                               | `core/src/proxy/relay.ts`: `relay(plan): ReadableStream<Uint8Array>`. The logic is in pure `wire` taps and transcoders. |
| Inbound WebSocket  | `server.upgrade(req, { headers, data })` + `websocket` handlers              | Effect's upgrade cannot set 101 headers (WS-010 needs three).                                                               | `core/src/proxy/socket.ts`: the `Relay` service. Decisions are pure; effects go through the `Settler` queue.            |
| Upstream WebSocket | `ws` (Bun's built-in implementation of the `ws` API)                         | It is the only client that shows the 101's headers, and it takes `proxy` and `tls`.                                         | `Upstream.dial(url, headers): Effect<UpstreamSocket, Unreachable \| TimedOut, Scope>`                                   |
| SOCKS5 outbound    | `node:net` loopback CONNECT→SOCKS5 bridge                                    | Bun's `fetch` and `ws` take HTTP proxies only (RUNTIME.md).                                                                 | Built in `Upstream.layer`'s scope.                                                                                      |
| CA roots           | `node:tls` `getCACertificates("system" \| "bundled")`                        | NET-007                                                                                                                     | Read once in `Upstream.layer`.                                                                                          |
| Embedded UI        | `import f from "…" with { type: "file" }`, `Bun.file`                        | This is the only way to embed files in the binary.                                                                          | The `Assets` service, whose layer is generated by `apps/cli/build.ts`.                                                  |
| Static `/healthz`  | `Bun.serve` `routes` with a prebuilt `Response`                              | Answered with no JS per request.                                                                                            | Built once from the version.                                                                                            |
| JIT policy         | `Bun.unsafe.setJITPolicy(1)` after listen                                    | RUNTIME.md §1                                                                                                               | `Server` layer.                                                                                                         |

CONVENTIONS' rows "HTTP server: `HttpRouter`", "HTTP client: `HttpClient`" and
"Streams: `Stream`" therefore apply everywhere except `core/src/proxy/**`'s
inference and socket lanes. In `core/src/proxy/**`, oxlint bans
`effect/http/HttpClient` and `Stream` imports. Translation still uses
`effect/encoding`'s `Sse.makeParser`. Every cold call (OAuth, usage, resets,
catalogs, webhooks, the CLI's daemon client) uses `HttpClient`.

### 1.4 Typed for the ahead-of-time compiler

There is no `any`, no unchecked cast, no `eval`, no computed `import()`, and
no code-generating dependency (`AOT.md`). Errors are matched by `_tag` or
`instanceof`, never by message. `HttpRouter` routes are static or wildcard
only, so FindMyWay never builds a regex. CI runs `bun compile --explain` and
fails review on new slow paths in `core/src/proxy/**` and `packages/wire/**`.

---

## 2. Packages and boundaries

```
ts/
  packages/
    domain/  @slopmax/domain  imports effect only. The contract: schemas that cross a process
                              boundary, provider and agent facts, SlopmaxApi, events, errors,
                              people-facing formatting, the desktop bridge's schemas.
    wire/    @slopmax/wire    imports effect (Schema, Data, encoding/Sse), @slopmax/domain. Pure:
                              byte scanner, SSE line splitter, taps, opening judge, the three
                              formats, the common form, translation, transcoders, error bodies.
    core/    @slopmax/core    imports effect, @effect/platform-bun, ws, @decimalturn/toml-patch,
                              @slopmax/domain, @slopmax/wire. The engine (Bun only): services,
                              providers, agents, pool, router, proxy, socket relay, admin API,
                              hub, daemon, background client, doctor, importers.
  apps/
    cli/     slopmax          imports core, domain. effect/cli tree, terminal I/O, main; embeds
                              apps/ui's web build; builds the AOT binary.
    ui/      @slopmax/ui      imports domain, effect (reactivity, http-api), @effect/atom-react,
                              react, tailwind, shadcn/ui. One React app with two hosts (web, desktop).
    desktop/ slopmax-desktop  imports domain, effect, @effect/platform-node (main only), electron.
                              Main, preload, packaging; ships apps/ui's desktop build and the CLI binary.
  tools/
    test/    @slopmax/test    it.effect / it.live / it.layer, MemoryFileSystem, TestHome
    bench/   @slopmax/bench   bench mock provider, body generator, oha driver, demo home, perf gates
```

Dependency direction: `domain ← wire ← core ← cli`, `domain ← ui`,
`domain ← desktop`. Packages never import apps. `tools/test` imports only
`effect`. Test support that needs the engine (the proxy harness, the mock
provider) lives in `packages/core/test/support/`.

Import rules (oxlint `no-restricted-imports` per directory):

- `packages/domain/**` and `packages/wire/**`: no `node:*`, no `bun`, no
  `@effect/platform-*`, no `FileSystem`, no `HttpClient`.
- `apps/ui/**`: no `@slopmax/core`, no `@slopmax/wire`, no `node:*`.
- `apps/desktop/src/main/**`: no `@slopmax/core`, no `@slopmax/wire` (the
  engine never loads on Node).
- `packages/core/src/proxy/**`: no `effect/http/HttpClient`, no `Stream`
  (§1.3). `setTimeout` and `setInterval` are banned everywhere in packages.
- Only `packages/core/**`, `apps/cli/src/main.ts` and `tools/bench/**` import
  `@effect/platform-bun`.

### 2.1 What each package exports

| Package           | `exports`                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@slopmax/domain` | `"."`: ids, provider and agent facts, `limits`, `report`, `ledger`, `settings`, `notice`, `doctor`, `login`, `events`, `errors`. `"./api"`: `SlopmaxApi`, its groups, `OwnerKey`. `"./format"`: people formats and shared words. `"./desktop"`: `DesktopBridge` and its schemas. |
| `@slopmax/wire`   | `scan`, `lines`, `Tap`, `Opening`, `Usage` observers, `errorBody`, `limitReached`, `retell`, `common` (the common form), `formats`, `canTranslate`, `Transcoder`, `transcoder`, `collect`, `Compaction`, `ReplayBook`                                                            |
| `@slopmax/core`   | the services in §4, `providers`, `agents`, `router`, `Pool` model functions, `buildReport`, `doctor`, `importers`, `CoreLive` (every live layer for the CLI), `Daemon` (layer + `serve`), `Assets` (the service tag only)                                                        |
| `@slopmax/ui`     | no runtime exports. `build.ts` writes `dist/web/**` (embedded by the CLI) and `dist/desktop/**` (shipped by the desktop app).                                                                                                                                                    |
| `@slopmax/test`   | `it`, `MemoryFileSystem.layer`, `TestHome.layer`                                                                                                                                                                                                                                 |
| `@slopmax/bench`  | CLI scripts: `mock`, `bodies`, `run`, `demo`, `gates`                                                                                                                                                                                                                            |

### 2.2 File layout

```
packages/domain/src/
  ids.ts          ProviderId, AgentId, AccountId, KeyName, Dialect, Span, Strategy, Secret
  providers.ts    ProviderFacts, providerFacts: Record<ProviderId, ProviderFacts>, providerOrder
  agents.ts       AgentFacts, agentFacts, AgentWiring
  limits.ts       Window, Limits, PoolWindow, LimitReset; usedAt, upcomingReset, merge, lapsed, score, urgency, pooled
  report.ts       Condition, Note, AccountView, PoolView, NextView, Report, RedeemOutcome
  ledger.ts       Usage, LedgerRecord (Request | WindowEnded), SummaryRange, HistoryRange, Summary, History, LeftOnTheTable
  settings.ts     Settings, ClientKey, Price, NotifySettings, ProxyUrl, live annotation, LiveSettings, LivePatch, PublicSettings, SettingsView
  notice.ts       NoticeKind, Notice
  doctor.ts       Level, Finding, Section
  login.ts        LoginEvent, LoginId
  events.ts       Event
  errors.ts       API errors with statuses
  api.ts          SlopmaxApi, OwnerKey
  format.ts       duration, until, clock, day, ago, compact, money, percent (half even), pace, menuBar, conditionText, noticeTitle, noticeBody
  desktop.ts      DesktopBridge, ProxyState, DesktopPrefs, ShellResult
  index.ts
packages/wire/src/
  scan.ts  lines.ts  tap.ts  observe.ts  opening.ts  errors.ts
  common.ts  format.ts  messages.ts  responses.ts  chat.ts  transcode.ts  collect.ts  compaction.ts  replay.ts
  index.ts
packages/core/src/
  home.ts  lock.ts  log.ts  settings.ts  accounts.ts  refresh.ts  upstream.ts  dial.ts  socks.ts
  providers/{provider,oauth,claude,codex,keys,compat,index}.ts
  agents/{agent,claude-code,codex,index}.ts
  importers.ts  router.ts  pool.ts  quota.ts  pricing.ts  report.ts
  ledger.ts  ledger-views.ts  events.ts  notifier.ts
  background.ts  service.ts  doctor.ts  port-holder.ts  browser.ts
  proxy/{classify,auth,inbound,planner,forward,attempt,hold,relay,settle,live,models,count-tokens,replies,socket}.ts
  api/{handlers,logins,status,hub-api,hub,assets}.ts
  server.ts  daemon.ts  index.ts
packages/core/test/support/{memory-upstream,harness,mock-provider,fixtures,clients}.ts
```

---

## 3. The domain model (`@slopmax/domain`)

Persisted and wire shapes are `Schema.Class` values with decoding defaults, so a
partial file loads. Sum types that cross a boundary are `Schema.TaggedUnion`
values. The engine's internal sums (`Verdict`, `Attempt`, `Lane`, `Plan`,
`Pick`, `Entry`) are `Data.TaggedEnum`s and are handled with `Match` or a
`switch` on `_tag`.

`withDefault(x)` is `Schema.withDecodingDefaultKey(Effect.succeed(x))`.

### 3.1 Ids and small values (`ids.ts`)

```ts
export const ProviderId = Schema.Literals(["claude", "codex", "anthropic", "openai", "xai", "compat"])
export type ProviderId = typeof ProviderId.Type
export const AgentId = Schema.Literals(["claude-code", "codex"])
export const AccountId = Schema.String.pipe(Schema.brand("AccountId")) // "<provider>-<8 hex>" (ACC-009)
export const KeyName = Schema.NonEmptyString.pipe(Schema.brand("KeyName"))
export const Dialect = Schema.Literals(["messages", "responses", "chat"]) // WIRE-001
export const Span = Schema.Literals(["5h", "7d", "30d"])
export const Strategy = Schema.Literals(["reset-first", "fill-first", "least-used", "round-robin"])
export const Secret = Schema.RedactedFromValue(Schema.String) // tokens and keys: plain in files, Redacted in memory
export const Instant = Schema.DateTimeUtcFromString // RFC 3339; reads 0–9 fraction digits, writes ≤ 3 (COM-001..004)
```

### 3.2 Provider and agent facts (`providers.ts`, `agents.ts`)

The facts are what the CLI, the UI and Electron main need without the engine.
The behavior lives in `core/providers` (§5.1).

```ts
export interface ProviderFacts {
  readonly id: ProviderId
  readonly title: string // "Claude", "ChatGPT", "Anthropic API", "OpenAI API", "xAI API", "Compatible endpoint"
  readonly billing: "subscription" | "metered"
  readonly backs?: ProviderId // a metered provider that can overflow a subscription (ROUTE-007)
  readonly agentOnly?: AgentId // Claude subscriptions serve Claude Code alone (PRX-036)
  readonly signIn: "browser" | "browser-or-device" | "key" | "endpoint"
  readonly dialects: ReadonlyArray<Dialect>
  readonly hasResets: boolean // limit-reset credits (PROV-060)
}
export const providerFacts: { readonly [K in ProviderId]: ProviderFacts }
export const providerOrder: ReadonlyArray<ProviderId> // registry order = try order = sort order (PROV-001)

export interface AgentFacts {
  readonly id: AgentId
  readonly title: string
  readonly provider: ProviderId
}
export const agentFacts: { readonly [K in AgentId]: AgentFacts }
export class AgentWiring extends Schema.Class<AgentWiring>("AgentWiring")({
  id: AgentId,
  title: Schema.String,
  installed: Schema.Boolean,
  configPath: Schema.String,
  wiredTo: Schema.optionalKey(Schema.String), // the base URL the agent points at, if it is ours
  wired: Schema.Boolean,
  backedUp: Schema.Boolean,
}) {}
```

### 3.3 Usage windows (`limits.ts`)

```ts
export class Window extends Schema.Class<Window>("Window")({
  span: Span,
  model: Schema.optionalKey(Schema.String),
  used: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optionalKey(Instant),
}) {}
export class Limits extends Schema.Class<Limits>("Limits")({
  windows: Schema.Array(Window).pipe(withDefault([])),
  observedAt: Schema.optionalKey(Instant),
  resetCredits: Schema.optionalKey(Schema.Int),
  plan: Schema.optionalKey(Schema.String),
}) {
  static readonly empty: Limits
}
export class PoolWindow extends Schema.Class<PoolWindow>("PoolWindow")({
  span: Span,
  used: Schema.Number,
  resetsAt: Schema.optionalKey(Instant),
  weighted: Schema.Boolean,
}) {}
export class LimitReset extends Schema.Class<LimitReset>("LimitReset")({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  grantedAt: Schema.optionalKey(Instant),
  expiresAt: Schema.optionalKey(Instant),
}) {}

// Pure window math (LIM-002..018). `now` is always an argument.
export const usedAt: (w: Window, now: DateTime.Utc) => number
export const upcomingReset: (w: Window, now: DateTime.Utc) => Option.Option<DateTime.Utc>
export const merge: (older: Limits | undefined, newer: Limits, now: DateTime.Utc) => Limits
export const lapsed: (older: Limits | undefined, newer: Limits, now: DateTime.Utc) => ReadonlyArray<Window>
export const score: (l: Limits | undefined, now: DateTime.Utc) => number // 101 when unmeasured
export const exhaustedUntil: (l: Limits, now: DateTime.Utc, model?: string) => Option.Option<DateTime.Utc>
export type Urgency = "none" | "soon" | "now"
export const urgency: (l: Limits | undefined, now: DateTime.Utc) => Urgency
export const pooled: (
  members: ReadonlyArray<{ readonly limits: Limits; readonly share?: number }>,
  now: DateTime.Utc,
) => ReadonlyArray<PoolWindow>
```

### 3.4 Reports (`report.ts`)

```ts
export const Condition = Schema.TaggedUnion({
  SignInNeeded: { error: Schema.String },
  Disabled: {},
  Limited: { until: Instant },
  Throttled: { until: Schema.optionalKey(Instant) },
  Active: { sessions: Schema.Int },
  Ready: {},
}) // REP-007
export const Note = Schema.TaggedUnion({
  Pinned: {},
  Priority: { value: Schema.Int },
  Follows: { tool: Schema.String },
  Resets: { count: Schema.Int },
  Served: { requests: Schema.Int, tokens: Schema.Int },
  LastError: { text: Schema.String },
}) // REP-008..012
export class AccountView extends Schema.Class<AccountView>("AccountView")({
  id: AccountId,
  provider: ProviderId,
  name: Schema.String,
  email: Schema.optionalKey(Schema.String),
  plan: Schema.optionalKey(Schema.String),
  disabled: Schema.Boolean,
  priority: Schema.Int,
  pinned: Schema.Boolean,
  follows: Schema.optionalKey(Schema.String),
  tokenExpiresAt: Schema.optionalKey(Instant),
  endpoint: Schema.optionalKey(Schema.String),
  models: Schema.Array(Schema.String),
  sessions: Schema.Int,
  condition: Condition,
  notes: Schema.Array(Note),
  windows: Schema.Array(Window),
  resets: Schema.Array(LimitReset),
  lastUsed: Schema.optionalKey(Instant),
  served: Usage,
}) {}
export const NextReason = Schema.Literals([
  "pinned",
  "session",
  "resets-first",
  "fills-first",
  "least-used",
  "turn",
  "only-one",
])
export class NextView extends Schema.Class<NextView>("NextView")({
  account: AccountId,
  reason: NextReason,
  why: Schema.String,
}) {}
export class PoolView extends Schema.Class<PoolView>("PoolView")({
  provider: ProviderId,
  accounts: Schema.Int,
  windows: Schema.Array(PoolWindow),
  scoped: Schema.Array(Window),
  shares: Schema.Record(AccountId, Schema.Number),
  next: Schema.optionalKey(NextView),
}) {} // REP-003/004
export class Report extends Schema.Class<Report>("Report")({
  version: Schema.String,
  live: Schema.Boolean,
  generatedAt: Instant,
  strategy: Strategy,
  accounts: Schema.Array(AccountView),
  pools: Schema.Array(PoolView),
  nudges: Schema.Array(Notice),
}) {} // REP-001
export const RedeemOutcome = Schema.Literals(["reset", "nothing-to-reset", "no-credit", "already-redeemed", "declined"])
export class RedeemResult extends Schema.Class<RedeemResult>("RedeemResult")({
  outcome: RedeemOutcome,
  report: Report,
}) {}
```

The engine computes `Condition` and `Note` once, so the CLI, the UI and the
tray agree without deriving them again.

### 3.5 The ledger (`ledger.ts`, files `usage/YYYY-MM.ndjson`)

```ts
export class Usage extends Schema.Class<Usage>("Usage")({
  requests: Schema.Int,
  input: Schema.Int,
  output: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
}) {
  static readonly zero: Usage
  plus(that: Usage): Usage
  get tokens(): number
} // WIRE-002

export const LedgerRecord = Schema.TaggedUnion({
  Request: {
    at: Instant,
    account: Schema.optionalKey(AccountId),
    provider: ProviderId,
    model: Schema.optionalKey(Schema.String),
    status: Schema.Int,
    usage: Usage,
    ms: Schema.Int,
    firstByteMs: Schema.optionalKey(Schema.Int),
    attempts: Schema.Int.pipe(withDefault(1)),
    agent: Schema.optionalKey(AgentId),
    session: Schema.optionalKey(Schema.String),
    via: Schema.Literals(["http", "socket"]).pipe(withDefault("http")),
  }, // LED-002
  WindowEnded: {
    at: Instant,
    account: AccountId,
    provider: ProviderId,
    plan: Schema.optionalKey(Schema.String),
    span: Span,
    model: Schema.optionalKey(Schema.String),
    used: Schema.Number,
  }, // LED-050
})
export type LedgerRecord = typeof LedgerRecord.Type
export const isFailed: (r: LedgerRecord & { _tag: "Request" }) => boolean // status >= 400 (LED-005)
export const isAnswer: (r: LedgerRecord & { _tag: "Request" }) => boolean // not failed, tokens > 0

export const SummaryRange = Schema.Literals(["today", "7d", "30d", "all"])
export const SummaryBy = Schema.Literals(["day", "model", "account"])
export const HistoryRange = Schema.Literals(["today", "7d", "30d"])
export class Summary extends Schema.Class<Summary>("Summary")({/* rows, totals, cost (LED-013) */}) {}
export class History extends Schema.Class<History>("History")({
  /* buckets by provider/model, KPIs, heatmap, latency (LED-021) */
}) {}
export class LeftOnTheTable extends Schema.Class<LeftOnTheTable>("LeftOnTheTable")({
  /* per plan and account (LED-053) */
}) {}
```

The three report shapes are shaped for the tables and charts that read them.
The CLI's `usage --json`, the API and the UI share them.

### 3.6 Settings (`settings.ts`, file `config.json`)

One Schema defines the file, its defaults, its validation, its JSON Schema
(`config.schema.json`), its descriptions (editor hover text, `slopmax config`
help) and which settings may change while slopmax runs.

```ts
declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** May be changed by `slopmax config`, `PATCH /settings`, and the UI's switches. */
      readonly live?: { readonly summary: string } | undefined
    }
  }
}

export const ProxyUrl = Schema.String.check(/* http://, socks5://, socks5h:// (NET-003) */)
export class ClientKey extends Schema.Class<ClientKey>("ClientKey")({
  name: KeyName,
  key: Secret,
  models: Schema.Array(Schema.String).pipe(withDefault([])),
}) {
  allows(model: string): boolean
} // CFG-008
export class Price extends Schema.Class<Price>("Price")({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.optionalKey(Schema.Finite),
  cacheWrite: Schema.optionalKey(Schema.Finite),
}) {} // LED-043
export class NotifySettings extends Schema.Class<NotifySettings>("NotifySettings")({
  webhook: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  events: Schema.Array(NoticeKind).pipe(withDefault(defaultNoticeKinds)),
}) {
  static readonly empty: NotifySettings
} // NOTE-001/002/015

export class Settings extends Schema.Class<Settings>("Settings")(
  {
    $schema: Schema.optionalKey(Schema.String), // "./config.schema.json"
    listen: Schema.String.pipe(withDefault("127.0.0.1:7567")).annotate({
      description: "Address the proxy listens on. Needs a restart.",
    }),
    apiKey: Secret.annotate({ description: "The owner key. Made on first run." }), // "sm-" + 43 base64url chars
    strategy: Strategy.pipe(withDefault("reset-first")).annotate({
      live: { summary: "How new sessions pick an account" },
    }),
    sessionAffinity: Schema.Boolean.pipe(withDefault(true)).annotate({
      live: { summary: "Keep a session on its account" },
    }),
    sessionMinutes: PositiveInt.pipe(withDefault(60)).annotate({
      live: { summary: "Minutes an idle session stays bound" },
    }),
    pollMinutes: NonNegativeInt.pipe(withDefault(5)).annotate({
      live: { summary: "Minutes between usage polls (0 = off)" },
    }),
    refreshTokens: Schema.Boolean.pipe(withDefault(true)).annotate({
      live: { summary: "Refresh sign-ins ahead of expiry" },
    }),
    redeemExpiring: Schema.Boolean.pipe(withDefault(true)).annotate({
      live: { summary: "Redeem limit resets before they expire" },
    }),
    redeemWhenExhausted: Schema.Boolean.pipe(withDefault(false)).annotate({
      live: { summary: "Redeem a reset when every account is limited" },
    }),
    websockets: Schema.Boolean.pipe(withDefault(true)).annotate({ live: { summary: "Let Codex use WebSockets" } }),
    warmWindows: Schema.Boolean.pipe(withDefault(false)).annotate({
      live: { summary: "Start idle ChatGPT windows early" },
    }),
    paidOverflow: Schema.Boolean.pipe(withDefault(false)).annotate({
      live: { summary: "Overflow to API keys when subscriptions are spent" },
    }),
    upstreamProxy: Schema.optionalKey(ProxyUrl).annotate({ description: "Proxy for provider calls. Needs a restart." }),
    aliases: Schema.Record(Schema.String, Schema.String).pipe(withDefault({})),
    fallbacks: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(withDefault({})),
    prices: Schema.Record(Schema.String, Price).pipe(withDefault({})),
    planPrices: Schema.Record(Schema.String, Schema.Finite).pipe(withDefault({})), // "claude/max 20x": 200
    notify: NotifySettings.pipe(withDefault(NotifySettings.empty)),
    keys: Schema.Array(ClientKey).pipe(withDefault([])),
  },
  { parseOptions: { onExcessProperty: "error" } }, // a typo is an error (CFG-003..006)
) {}

/** The fields annotated `live`, as their own class. A test walks Settings' AST and checks they match. */
export class LiveSettings extends Schema.Class<LiveSettings>("LiveSettings")({
  strategy: Strategy,
  sessionAffinity: Schema.Boolean,
  sessionMinutes: PositiveInt,
  pollMinutes: NonNegativeInt,
  refreshTokens: Schema.Boolean,
  redeemExpiring: Schema.Boolean,
  redeemWhenExhausted: Schema.Boolean,
  websockets: Schema.Boolean,
  warmWindows: Schema.Boolean,
  paidOverflow: Schema.Boolean,
}) {}
export const LivePatch = Schema.Struct(LiveSettings.fields).mapFields(Struct.map(Schema.optionalKey))
export type LiveKey = keyof LiveSettings
/** One row per live setting, read from the annotations: name, summary, how `slopmax config` parses a value. */
export const liveTable: ReadonlyArray<{
  readonly name: LiveKey
  readonly summary: string
  readonly parse: (text: string) => Result.Result<unknown, string>
}>
export const strategySummaries: { readonly [K in typeof Strategy.Type]: string } // CFG-010
export class PublicSettings extends Schema.Class<PublicSettings>("PublicSettings")({
  /* Settings without apiKey; keys as { name, models } */
}) {}
export class SettingsView extends Schema.Class<SettingsView>("SettingsView")({
  settings: PublicSettings,
  live: Schema.Array(Schema.Struct({ name: Schema.String, summary: Schema.String })),
  strategies: Schema.Array(Schema.Struct({ id: Strategy, summary: Schema.String })),
  restartNeeded: Schema.Array(Schema.String), // settings whose file value differs from the running one
}) {}
export const settingsJsonSchema = (): JsonSchema.Document<"draft-2020-12"> => Schema.toJsonSchemaDocument(Settings)
```

### 3.7 Notices, doctor, sign-in, events

```ts
export const NoticeKind = Schema.Literals(["limited", "available", "exhausted", "recovered", "signed-out",
  "reset-expiring", "quota-unused", "test"]) // NOTE-002
export class Notice extends Schema.Class<Notice>("Notice")({
  kind: NoticeKind, key: Schema.String, provider: Schema.optionalKey(ProviderId), account: Schema.optionalKey(Schema.String),
  until: Schema.optionalKey(Instant), message: Schema.String, at: Instant, worth: Schema.optionalKey(Schema.Number),
}) {} // NOTE-003; titles and plain bodies are format.noticeTitle / noticeBody (APP-064/065)

export const Level = Schema.Literals(["ok", "info", "warn", "fail"])
export class Finding extends Schema.Class<Finding>("Finding")({ level: Level, text: Schema.String, fix: Schema.optionalKey(Schema.String) }) {}
export class Section extends Schema.Class<Section>("Section")({ title: Schema.String, findings: Schema.Array(Finding) }) {} // DOC-001

export const LoginId = Schema.String.pipe(Schema.brand("LoginId"))
export const LoginEvent = Schema.TaggedUnion({
  Authorize: { title: Schema.String, url: Schema.String, port: Schema.Int, opened: Schema.Boolean },
  DeviceCode: { url: Schema.String, code: Schema.String },
  Note: { text: Schema.String },
  Done: { account: AccountView, isNew: Schema.Boolean },
  Failed: { message: Schema.String },
}) // APP-005/038

export const Event = Schema.TaggedUnion({
  Hello: { version: Schema.String },                    // first event on every connection (the live indicator)
  Status: { report: Report },                           // sent at connect and whenever the report changes
  Request: { record: /* LedgerRecord Request case */ }, // one per answered request (ADM-012)
  Notice: { notice: Notice },                           // once per notice (the daemon remembers what it told)
  Login: { id: LoginId, event: LoginEvent },            // sign-in progress for API callers
  Ping: {},                                             // every 15 s, keeps proxies from closing the stream
})
```

### 3.8 Errors, by boundary

| Boundary                                | Errors                                                                                                                                                                                                   | Kind                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Files (`Home`, `Lock`)                  | `FileError { path, action: "read" \| "write" \| "remove" \| "list" \| "parse", cause }`, `LockTimeout { name, holder? }`                                                                                 | `Data.TaggedError`                                                                           |
| Settings                                | `SettingsInvalid { path, issue }` (nothing is written), `SettingRejected { name, reason }`                                                                                                               | `Schema.TaggedError` (they reach the CLI and the API)                                        |
| Accounts                                | `AccountNotFound { query }`, `AccountAmbiguous { query, ids }`, `AccountGone { id }`                                                                                                                     | `Schema.TaggedError`                                                                         |
| Sign-in and refresh                     | `LoginFailed { message }`, `LoginTimedOut`, `StateMismatch`, `RefreshRevoked { reason }`, `RefreshTransient { message }`                                                                                 | `Data.TaggedError`. `RefreshRevoked.reason` becomes the account's `authError`.               |
| Upstream                                | `Unreachable { url, cause }`, `TimedOut { after }`, `TooLarge { limit }`                                                                                                                                 | `Data.TaggedError`                                                                           |
| Provider APIs (usage, resets, catalogs) | `ProviderUnauthorized`, `ProviderFailed { message, status? }`, `NeedsAgent { agent }`                                                                                                                    | `Data.TaggedError`                                                                           |
| Processes                               | `SpawnFailed { program }`, `ExitFailed { program, args, code, stderr }` (SVC-010)                                                                                                                        | `Data.TaggedError`                                                                           |
| Daemon                                  | `ListenFailed { address, holder? }` (DMN-001, NET-031), `AlreadyServing { pid }`, `NotRunning`, `StartFailed { log }`                                                                                    | `Data.TaggedError`                                                                           |
| The proxy                               | **none.** Every path ends in a reply shaped for the client's format. Upstream refusals are data (`Verdict`, `Failure`). A defect becomes a 500 in the route's dialect and is logged with `Cause.pretty`. | n/a                                                                                          |
| `SlopmaxApi` (`domain/errors.ts`)       | `Unauthorized` 401, `NotFound { what }` 404, `BadRequest { message }` 400, `Conflict { message }` 409, `UpstreamFailed { message }` 502, `Internal { message }` 500                                      | `Schema.TaggedError<…>()(tag, fields, { httpApiStatus })`; encoded as `{ _tag, message, … }` |
| Hub                                     | `HubError { status, error }`, encoded `{ "error": message }`                                                                                                                                             | `Schema.TaggedError` in `core/api/hub-api.ts`                                                |
| CLI                                     | `CliFailure { message }` exits 1. `effect/cli`'s validation errors exit 2.                                                                                                                               | `Data.TaggedError`                                                                           |

Every error has a `message` getter written for people, in slopmax's words. The
parity texts quoted in backticks survive as those messages.

---

## 4. Services (`@slopmax/core`)

Each service is a `Context.Service` class with `make` and a static `layer`, as
in CONVENTIONS. Effectful methods are `Effect.fn("Service.method")`. Hot-path
methods are `Effect.sync` over in-memory state. The "Delivers" line names the
parity prefixes each service owns.

```
          Home ── Lock
            │
         Settings ─────────────┐
            │                  │
         Upstream           Events
            │                  │
         Accounts (+ refresh)  Ledger
            │                  │
           Pool ───────────── Quota ── Notifier
            │
  proxy (Planner, Settler, LiveStreams, Relay, Catalog, Replay) ── Server ── Daemon
            │
         api (SlopmaxApi handlers, Logins, HubApi, Assets)         Background (the daemon from outside)
```

### 4.1 `Home` and `Lock`

```ts
export interface Paths {
  readonly root: string // $SLOPMAX_HOME (non-empty) else ~/.slopmax (FS-002/003)
  readonly config: string
  readonly configSchema: string
  readonly accounts: string
  readonly state: string
  readonly backups: string
  readonly usage: string
  readonly log: string
  readonly locks: string
  readonly claudeDir: string // $CLAUDE_CONFIG_DIR else ~/.claude (FS-006)
  readonly codexDir: string // $CODEX_HOME else ~/.codex (FS-007)
  readonly cliProxyApiDir: string // ~/.cli-proxy-api (FS-008)
}
export class Home extends Context.Service<
  Home,
  {
    readonly paths: Paths
    readonly read: <S extends Schema.Top>(
      path: string,
      schema: S,
    ) => Effect.Effect<Option.Option<S["Type"]>, FileError, S["DecodingServices"]>
    readonly write: <S extends Schema.Top>(
      path: string,
      schema: S,
      value: S["Type"],
    ) => Effect.Effect<void, FileError, S["EncodingServices"]>
    readonly append: (path: string, text: string) => Effect.Effect<void, FileError> // O_APPEND, 0600 on create
    readonly watch: (paths: ReadonlyArray<string>) => Stream.Stream<string, FileError> // changed paths, debounced 100 ms
  }
>()("@slopmax/core/Home", { make }) {
  static readonly layer: Layer.Layer<Home, ConfigError, FileSystem.FileSystem | Path.Path>
  static readonly layerAt: (root: string) => Layer.Layer<Home, never, FileSystem.FileSystem | Path.Path>
}

export class Lock extends Context.Service<
  Lock,
  {
    /** A Semaphore per name inside the process, then `locks/<name>.lock` across processes. */
    readonly with: (
      name: string,
      options?: { readonly wait?: Duration.Input },
    ) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | LockTimeout | FileError, R>
    /** Taken only if free now; None when another live process holds it. */
    readonly tryWith: (
      name: string,
    ) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E | FileError, R>
    /** Held until the scope closes (the daemon's `serve` lock). */
    readonly hold: (name: string) => Effect.Effect<void, AlreadyServing | FileError, Scope.Scope>
  }
>()("@slopmax/core/Lock", { make }) {
  static readonly layer: Layer.Layer<Lock, never, Home | FileSystem.FileSystem | ChildProcessSpawner>
  static readonly layerMemory: Layer.Layer<Lock> // tests: Semaphores only
}
```

- `write` writes a sibling temp file (`.<name>.<pid>.tmp`, mode 0600), fsyncs
  it and renames it over the target. The parent is created 0700 when it is
  new. JSON is pretty-printed with a trailing newline (FS-009..014).
- A lock file is created with `FileSystem.open(path, { flag: "wx", mode: 0o600 })`
  and holds `{ pid, startedAt }`. `startedAt` is the process start time:
  field 22 of `/proc/<pid>/stat` on Linux, `ps -o lstart= -p <pid>` on macOS.
  A waiter that finds the file checks that the pid is alive
  (`process.kill(pid, 0)`) and that its start time matches. If not, the lock
  is stale: it is renamed to a unique name (only one contender wins), removed,
  and created again. Waits poll on `Schedule.spaced("25 millis")` up to `wait`
  (default 60 s). Release runs in the `acquireRelease` finalizer, so
  interruption never leaks a lock.
- Lock names: `config` (first-run key, every `config.json` write),
  `account-<id>` (account updates and refresh), `backups`, `serve` (held by
  the daemon for its life; §10.2).

Delivers: FS-001..014, DMN-020.

### 4.2 `Settings`

```ts
export class SettingsService extends Context.Service<
  SettingsService,
  {
    readonly get: Effect.Effect<Settings> // SubscriptionRef.get: no I/O
    readonly changes: Stream.Stream<Settings>
    readonly reload: Effect.Effect<"unchanged" | "applied" | "invalid"> // keeps the last good settings when invalid
    readonly update: (
      f: (s: Settings) => Settings,
    ) => Effect.Effect<Settings, SettingsInvalid | FileError | LockTimeout>
    readonly setLive: (
      patch: typeof LivePatch.Type,
    ) => Effect.Effect<Settings, SettingRejected | FileError | LockTimeout>
    readonly addKey: (
      name: KeyName,
      models: ReadonlyArray<string>,
    ) => Effect.Effect<ClientKey, SettingRejected | FileError | LockTimeout>
    readonly removeKey: (name: KeyName) => Effect.Effect<boolean, FileError | LockTimeout>
    readonly baseUrl: Effect.Effect<string> // 0.0.0.0/:: → 127.0.0.1, IPv6 in brackets (CFG-026)
    readonly running: { readonly listen: string; readonly upstreamProxy: Option.Option<string> } // fixed at start
  }
>()("@slopmax/core/Settings", { make }) {
  static readonly layer: Layer.Layer<SettingsService, SettingsInvalid | FileError | LockTimeout, Home | Lock>
  static readonly layerValue: (s: Partial<Settings>) => Layer.Layer<SettingsService> // tests: no file
}
```

- First load: under `Lock.with("config")` it reads the file again. If there is
  still no `apiKey`, it makes one (`"sm-"` + 32 random bytes as base64url), then
  writes `config.json` (with `"$schema": "./config.schema.json"`) and
  `config.schema.json`. Every process started at once ends up with one key
  (CFG-019/020).
- `config.schema.json` is rewritten when it is missing or its `$comment`
  version differs from the running one (CFG-030/031).
- Writes: under `Lock.with("config")`, re-read, apply, encode with keys in
  Schema field order, validate by decoding the result, write atomically, set
  the ref. A file that does not decode is never rewritten (CLI-007). A blank
  `apiKey` in a reloaded file keeps the running key (PRX-018).
- `SLOPMAX_LISTEN` (via `Config.string`) overrides `listen`, and an
  unparsable value fails (CFG-017, CLI-008). `listen` and `upstreamProxy` are
  read once. `doctor` and `SettingsView.restartNeeded` report drift.
- The daemon calls `reload` from its watcher (§9). An invalid file logs
  `config.json is invalid, keeping the last good one: {issue}` once per
  distinct text.

Delivers: CFG-001..035, PRX-018, PRX-102 (as restart-needed), ADM-010/011/017..019 back ends.

### 4.3 `Accounts`: the store, its cache, and ready credentials

The `Account` schema lives in `core`, because tokens never cross the API.

```ts
export class Link extends Schema.Class<Link>("Link")({ tool: Schema.Literal("cliproxyapi"), path: Schema.String }) {}
export class Tokens extends Schema.Class<Tokens>("Tokens")({
  access: Secret,
  refresh: Schema.optionalKey(Secret),
  idToken: Schema.optionalKey(Secret),
  expiresAt: Schema.optionalKey(Instant),
  refreshedAt: Schema.optionalKey(Instant),
}) {}
export const Credential = Schema.TaggedUnion({
  OAuth: { tokens: Tokens, follows: Schema.optionalKey(Link) }, // follows: the CLIProxyAPI file it mirrors (ACC-006)
  Key: { key: Secret },
  Endpoint: {
    baseUrl: Schema.String,
    dialect: Dialect,
    models: Schema.Array(Schema.String),
    key: Schema.optionalKey(Secret),
  },
})
export class Identity extends Schema.Class<Identity>("Identity")({
  email: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.String), // ChatGPT workspace / Claude uuid
  orgId: Schema.optionalKey(Schema.String),
  orgName: Schema.optionalKey(Schema.String),
  plan: Schema.optionalKey(Schema.String),
}) {}
export class Account extends Schema.Class<Account>("Account")({
  id: AccountId,
  provider: ProviderId,
  credential: Credential,
  identity: Identity.pipe(withDefault(Identity.make({}))),
  label: Schema.optionalKey(Schema.String),
  disabled: Schema.Boolean.pipe(withDefault(false)),
  priority: Schema.Int.pipe(withDefault(0)),
  authError: Schema.optionalKey(Schema.String),
  addedAt: Instant,
}) {
  get name(): string // label, else endpoint host, else "<title> key …abcd", else email (org) (ACC-010)
  expiresWithin(lead: Duration.Duration, now: DateTime.Utc): boolean
}
export const assignId: (provider: ProviderId, identity: string) => AccountId // "<provider>-" + hex(sha256)[0..8] (ACC-008/009)

export class Accounts extends Context.Service<
  Accounts,
  {
    readonly list: Effect.Effect<ReadonlyArray<Account>> // cached; registry order, priority desc, addedAt asc (ACC-013)
    readonly get: (id: AccountId) => Effect.Effect<Option.Option<Account>>
    readonly fresh: (id: AccountId) => Effect.Effect<Option.Option<Account>, FileError> // re-read from disk into the cache
    readonly rescan: Effect.Effect<boolean, FileError> // re-read the directory; true when anything changed
    readonly changes: Stream.Stream<void> // after any change seen (sliding PubSub of 1)
    readonly find: (query: string) => Effect.Effect<Account, AccountNotFound | AccountAmbiguous> // N, id, label, email, id prefix (CLI-065)
    readonly upsert: (
      a: Account,
    ) => Effect.Effect<{ readonly account: Account; readonly isNew: boolean }, FileError | LockTimeout> // keeps label, disabled, priority, addedAt
    readonly update: (
      id: AccountId,
      f: (a: Account) => Account,
    ) => Effect.Effect<Account, AccountGone | FileError | LockTimeout>
    readonly remove: (id: AccountId) => Effect.Effect<void, AccountGone | FileError | LockTimeout>
    /** The account with a credential usable now: refreshed or followed when due or forced. */
    readonly ready: (
      a: Account,
      options?: { readonly force?: boolean },
    ) => Effect.Effect<Account, RefreshRevoked | RefreshTransient>
    readonly refreshDue: Effect.Effect<ReadonlyArray<{ readonly id: AccountId; readonly error?: string }>> // DMN-006/021
  }
>()("@slopmax/core/Accounts", { make }) {
  static readonly layer: Layer.Layer<Accounts, FileError, Home | Lock | Upstream | SettingsService>
}
```

Files that do not decode are skipped with a warning (`skipping {file}: {issue}`).

`ready` and `refreshDue` are built by `refresh.ts` (`makeRefresher`), which the
`Accounts` layer calls with its store functions, so the refresh logic has its
own file and owner (C5).

How `ready` works (AUTH-011..019):

```ts
const refreshes = yield * FiberMap.make<AccountId, Account, RefreshRevoked | RefreshTransient>() // layer scope
const limiter = yield * RateLimiter.make // over RateLimiter.layerStoreMemory

const ready = Effect.fn("Accounts.ready")(function* (account, options) {
  const provider = providers[account.provider]
  const now = yield* DateTime.now
  if (!options?.force && !account.expiresWithin(provider.refreshLead, now)) return account // fresh: no I/O
  if (account.credential._tag === "OAuth" && account.credential.follows) return yield* follow(account) // AUTH-016/017
  if (options?.force) {
    yield* limiter
      .consume({ key: `refresh:${account.id}`, limit: 3, window: "1 minute", onExceeded: "fail" })
      .pipe(
        Effect.mapError(() => new RefreshTransient({ message: "refreshed too often; waiting before the next try" })),
      )
  }
  const fiber = yield* FiberMap.run(refreshes, account.id, rotate(account, options), { onlyIfMissing: true })
  return yield* Fiber.join(fiber) // every caller joins one rotation; a caller hanging up does not stop it
})

const rotate = (account: Account, options?: { readonly force?: boolean }) =>
  lock.with(`account-${account.id}`)(
    Effect.gen(function* () {
      const stored = Option.getOrElse(yield* fresh(account.id), () => account) // re-read under the lock (AUTH-013)
      if (rotatedElsewhere(stored, account) || !stillDue(stored, options, yield* DateTime.now)) return stored
      // A refresh token is single-use: from the token POST to the save nothing may interrupt.
      const next = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const grant = yield* provider.refresh(stored).pipe(Effect.tapError(markRevoked(stored)))
          const rotated = applyGrant(stored, grant, yield* DateTime.now)
          yield* save(rotated).pipe(Effect.catch(logAndKeep)) // a failed save still returns the fresh tokens
          return rotated
        }),
      )
      return yield* provider.identify(next) // plan or email changes, outside the uninterruptible part
    }),
  )
```

The lock wait stays interruptible, so shutdown can end it. The `FiberMap` is
closed with the layer, which interrupts only fibers not yet inside the
uninterruptible part. `markRevoked` stores `authError` (AUTH-014).
`RefreshTransient` with an unexpired token returns the current token and logs
a warning (PRX-020).

Delivers: ACC-001..024, AUTH-011..019, CLI-065, PRX-019/020.

### 4.4 `Upstream`: every outbound byte

```ts
export interface UpstreamRequest {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: Uint8Array | string | undefined
}
export interface UpstreamSocket {
  readonly headers: Headers // the 101's headers
  readonly raw: WebSocket // `ws` instance, owned by the relay
}
export class Upstream extends Context.Service<
  Upstream,
  {
    /** Inference: native fetch in Effect.callback; decompress off; proxy and CA roots; origin rewrite (tests). */
    readonly send: (r: UpstreamRequest) => Effect.Effect<Response, Unreachable | TimedOut>
    /** Read a non-2xx body whole, bounded; never streamed to the client. */
    readonly readAll: (res: Response, limit: number) => Effect.Effect<Uint8Array, Unreachable | TooLarge>
    /** Cold calls (OAuth, usage, resets, catalogs, webhooks). */
    readonly http: HttpClient.HttpClient
    /** Codex's upstream socket; waits for the 101 and `open`, at most 15 s (WS-009). */
    readonly dial: (url: string, headers: Headers) => Effect.Effect<UpstreamSocket, Unreachable | TimedOut, Scope.Scope>
  }
>()("@slopmax/core/Upstream", { make }) {
  static readonly layer: Layer.Layer<Upstream, ProxyUrlInvalid, SettingsService | Scope.Scope>
  /** Tests: every URL whose prefix matches a key goes to the value instead (NET-008, FS-019). */
  static readonly layerOrigins: (
    origins: Record<string, string>,
  ) => Layer.Layer<Upstream, never, SettingsService | Scope.Scope>
  /** Tests: fetch is replaced by an in-process handler; no sockets. */
  static readonly layerHandler: (handler: (req: Request) => Response | Promise<Response>) => Layer.Layer<Upstream>
}
```

How it is built:

- **The proxy URL** comes from `upstreamProxy`, else the first non-empty of
  `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY` and `all_proxy` (NET-003/004). It
  is parsed once when the layer is built. `socks5://` and `socks5h://` start
  the loopback CONNECT→SOCKS5 bridge (`socks.ts`, about 60 lines of
  `node:net`, with user/password auth) in the layer's scope, and `proxy` points
  at it. CONNECT proxies get `Proxy-Authorization` (NET-006).
- **Bypass** is precomputed per origin: loopback and `NO_PROXY`/`no_proxy`
  (NET-005).
- **CA roots**: `tls.getCACertificates("system")` merged with `"bundled"`,
  read once and passed as `tls: { ca }` to `fetch` and `ws` (NET-007).
- **`send`** is
  `Effect.callback((resume, signal) => fetch(url, { method, headers, body, signal, decompress: false, proxy, tls }).then(...))`.
  Interrupting the fiber aborts the fetch before headers arrive. After that the
  body belongs to the relay (§6). The wait for response headers is bounded by
  `Effect.timeout("600 seconds")` on `Clock`. The 600 s gap between body
  chunks is the stall sweeper's job (§6.7).
- **`http`** is `FetchHttpClient.layer` with `FetchHttpClient.RequestInit`
  (proxy, tls), `HttpClient.TracerPropagationEnabled = false`,
  `HttpClient.TracerDisabledWhen = () => true`, a 30 s total timeout
  (`HttpClient.transformResponse(Effect.timeout(...))`), and
  `user-agent: slopmax/<version>` unless one is set. It decompresses
  normally. Only the inference lane passes bytes through untouched.
- **`dial`** (`dial.ts`) is `new WebSocket(url, { headers, proxy, tls })` from `ws`,
  wrapped in `Effect.callback`. It resolves on `upgrade` (keeping the
  headers) then `open`. It is acquired with `acquireRelease`, whose release
  closes the socket.

Delivers: NET-001..012, CFG-027, PRX-025 (upstream side), PRX-102.

### 4.5 `Pool`: health, sessions, placement

The model is immutable data built from Effect's persistent collections, with
pure functions. The service holds it in a `Ref` and saves it.

```ts
// pure (core/pool.ts)
export class Health extends Schema.Class<Health>("Health")({
  limits: Limits.pipe(withDefault(Limits.empty)), blockedUntil: Schema.optionalKey(Instant),
  modelBlocks: Schema.Record(Schema.String, Instant).pipe(withDefault({})), throttledUntil: Schema.optionalKey(Instant),
  lastUsed: Schema.optionalKey(Instant), lastError: Schema.optionalKey(Schema.String), served: Usage.pipe(withDefault(Usage.zero)),
  resets: Schema.optionalKey(Schema.Struct({ list: Schema.Array(LimitReset), listedAt: Instant, counted: Schema.optionalKey(Schema.Int) })),
}) {}
export class Session extends Schema.Class<Session>("Session")({ key: Schema.String, account: AccountId, at: Instant }) {}
export class SavedState extends Schema.Class<SavedState>("SavedState")({ // state.json (POOL-001..)
  health: Schema.Record(AccountId, Health).pipe(withDefault({})),
  sessions: Schema.Array(Session).pipe(withDefault([])),
  turns: Schema.Record(ProviderId, Schema.Int).pipe(withDefault({})), // round-robin cursors
  pins: Schema.Record(ProviderId, AccountId).pipe(withDefault({})),
  agents: Schema.Record(ProviderId, Schema.String).pipe(withDefault({})), // last client user agent per provider (PRX-009)
  codex: Schema.Struct({ version: Schema.optionalKey(Schema.String), lastModel: Schema.optionalKey(Schema.String) }).pipe(withDefault({})),
  told: Schema.Record(Schema.String, Instant).pipe(withDefault({})), // notice key → when it stops mattering
  lapsed: Schema.Array(Schema.String).pipe(withDefault([])), // windows already recorded as WindowEnded
}) {}

export interface PoolModel {
  readonly accounts: ReadonlyArray<Account>
  readonly health: HashMap.HashMap<AccountId, Health>
  readonly sessions: HashMap.HashMap<string, Session> // key: provider + "\0" + session id
  readonly saved: Omit<SavedState, "health" | "sessions"> // pins, turns, agents, codex, told, lapsed
  readonly version: number // bumped by every change to readings; keys the pooled-window cache
  readonly dirty: boolean
}
export interface PickRequest {
  readonly provider: ProviderId; readonly candidates: ReadonlyArray<AccountId>; readonly model?: string
  readonly session?: string; readonly housekeeping: boolean; readonly exclude: ReadonlySet<AccountId>
  readonly strategy: Strategy; readonly affinity: boolean; readonly ttl: Duration.Duration
}
export type Pick = Data.TaggedEnum<{
  Chosen: { readonly account: Account; readonly movedFrom?: AccountId }
  NoneReady: { readonly reason: string; readonly until?: DateTime.Utc; readonly spent: boolean }
}>
export const pick: (m: PoolModel, r: PickRequest, now: DateTime.Utc) => readonly [Pick, PoolModel] // POOL-012..018, 034
export const next: (m: PoolModel, provider: ProviderId, strategy: Strategy, now: DateTime.Utc) => Option.Option<NextView>
export const observe: (m: PoolModel, id: AccountId, limits: Limits, now: DateTime.Utc) => PoolModel // merge; lift early blocks
export const block: (m: PoolModel, id: AccountId, until: DateTime.Utc, model: string | undefined, why: string) => PoolModel
export const throttle: (m: PoolModel, id: AccountId, until: DateTime.Utc) => PoolModel
export const succeeded: (m: PoolModel, id: AccountId, usage: Usage | undefined, now: DateTime.Utc) => PoolModel
export const failed: (m: PoolModel, id: AccountId, why: string) => PoolModel
export const recordResets / recordReset / clearBlocks / pin / unpinAll / sawAgent / tell
export const lapses: (m: PoolModel, now: DateTime.Utc) => readonly [ReadonlyArray<WindowEnded>, PoolModel] // DMN-019
export const pooledView: (m: PoolModel, provider: ProviderId, now: DateTime.Utc) => Omit<PoolView, "next">
export const sync: (m: PoolModel, accounts: ReadonlyArray<Account>) => PoolModel // drops bindings to gone accounts
export const prune: (m: PoolModel, now: DateTime.Utc, ttl: Duration.Duration) => PoolModel // expired sessions

// service
export class Pool extends Context.Service<Pool, {
  readonly model: Effect.Effect<PoolModel>
  readonly modify: <A>(f: (m: PoolModel, now: DateTime.Utc) => readonly [A, PoolModel]) => Effect.Effect<A>
  readonly update: (f: (m: PoolModel, now: DateTime.Utc) => PoolModel) => Effect.Effect<void>
  readonly pooled: (provider: ProviderId) => Effect.Effect<ReadonlyArray<PoolWindow>> // cached per (provider, version)
  readonly changes: Stream.Stream<void> // sliding PubSub of 1
  readonly save: Effect.Effect<void, FileError> // state.json when dirty
}>()("@slopmax/core/Pool", { make }) {
  static readonly layer: Layer.Layer<Pool, FileError, Home | Accounts> // state.json absent → empty; malformed → fail (DMN-002)
  static readonly layerMemory: (seed?: SavedState) => Layer.Layer<Pool, never, Accounts>
}
```

- Strategy, TTL and affinity are passed into every `pick` from the current
  settings, so a change applies on the next request (POOL-009, CFG-035).
- The pool follows `Accounts.changes` with `sync`.
- `pooled` caches each provider's pooled windows with the model's `version`
  and a `validUntil` (the earliest reset among the windows). Response headers
  never recompute a weighted mean per request (PRX-021).

Delivers: POOL-001..037, LIM-008..018 (as used), REP-003/004, PRX-017, PRX-021.

### 4.6 `Quota`: usage polls and limit resets

```ts
export class Quota extends Context.Service<
  Quota,
  {
    readonly poll: (a: Account) => Effect.Effect<void> // usage; 401 → forced refresh and one retry; records lastError (DMN-015)
    readonly pollDue: (options?: { readonly force?: boolean }) => Effect.Effect<void> // concurrent (DMN-014)
    readonly listResets: (a: Account) => Effect.Effect<ReadonlyArray<LimitReset>, ProviderFailed | NeedsAgent>
    readonly listDue: (options?: { readonly force?: boolean }) => Effect.Effect<void> // one account at a time (DMN-016/021)
    readonly redeem: (
      a: Account,
      resetId?: string,
    ) => Effect.Effect<RedeemOutcome, ProviderFailed | NeedsAgent | RefreshRevoked>
    readonly redeemExpiring: Effect.Effect<void> // first in spend order expiring within 3 h (DMN-017)
    readonly rescue: (provider: ProviderId) => Effect.Effect<Option.Option<AccountId>> // spent pool + redeemWhenExhausted (PRX-072)
    readonly warm: Effect.Effect<void> // idle ChatGPT windows (PRX-095/096)
  }
>()("@slopmax/core/Quota", { make }) {
  static readonly layer: Layer.Layer<Quota, never, Pool | Accounts | Upstream | SettingsService | Ledger>
}
```

Every redemption (API, hub, rescue, the expiring-reset task) holds one
`Semaphore(1)` owned by the layer (DMN-022). A rescue that gets the permit
looks again before it spends anything, because the request that held the
permit may already have freed an account.

Delivers: LIM-023..026, PROV-030..034 and PROV-058..061 (orchestration), DMN-006..011, DMN-014..017, DMN-021/022, PRX-041, PRX-072, PRX-095/096.

### 4.7 `Ledger`

```ts
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly record: (r: LedgerRecord) => Effect.Effect<void> // Queue.offer to an unbounded queue: never blocks (LED-003)
    readonly read: (since: DateTime.Utc) => Stream.Stream<LedgerRecord, FileError> // month files ≥ since; bad lines skipped (LED-004/051)
    readonly flush: Effect.Effect<void> // used at shutdown
  }
>()("@slopmax/core/Ledger", { make }) {
  static readonly layer: Layer.Layer<Ledger, never, Home | Events | Scope.Scope> // one writer fiber: Queue.takeAll → one append per batch
}
// pure (ledger-views.ts)
export const summary: (records: Iterable<LedgerRecord>, range: SummaryRange, by: SummaryBy, ctx: ViewContext) => Summary
export const history: (records: Iterable<LedgerRecord>, range: HistoryRange, ctx: ViewContext) => History
export const left: (ended: Iterable<WindowEnded>, ctx: ViewContext) => LeftOnTheTable
export interface ViewContext {
  readonly names: ReadonlyMap<AccountId, string>
  readonly prices: Prices
  readonly planPrices: Record<string, number>
  readonly now: DateTime.Utc
  readonly zone: DateTime.TimeZone
}
```

Records are written as one NDJSON line each (`Schema.encodeSync` then
`JSON.stringify`) to `usage/YYYY-MM.ndjson` by UTC month (LED-001). They are
read with `FileSystem.stream`, `Stream.decodeText`, `Stream.splitLines` and
`Schema.decodeUnknownOption` per line. Local days and hours come from
`DateTime.CurrentTimeZone`, so DST tests pass a fixed zone. Each `Request`
record is also published as `Event.Request`.

Delivers: LED-001..053 (prices with `pricing.ts`), PRX-022/023/043/046.

### 4.8 `Events`

```ts
export class Events extends Context.Service<
  Events,
  {
    readonly publish: (e: typeof Event.Type) => Effect.Effect<void> // PubSub.sliding(256): a slow reader skips, never slows a request
    readonly subscribe: Stream.Stream<typeof Event.Type> // Hello, then Status, then live events
    readonly watching: Effect.Effect<boolean> // any subscriber connected
  }
>()("@slopmax/core/Events", { make }) {
  static readonly layer: Layer.Layer<Events>
}
```

Delivers: ADM-012, the live parts of the UI, tray and `status --watch`.

### 4.9 `Notifier`

```ts
export class Notifier extends Context.Service<
  Notifier,
  {
    readonly send: (n: Notice) => Effect.Effect<void, NotifyFailed> // webhook (JSON with text/content) and command; both tried
    readonly test: Effect.Effect<void, NotifyFailed | NotifyOff>
    readonly look: Effect.Effect<void> // the 15 s watch: conditions + nudges → told → Events.Notice + send (DMN-018)
  }
>()("@slopmax/core/Notifier", { make }) {
  static readonly layer: Layer.Layer<Notifier, never, Upstream | SettingsService | Pool | Events | ChildProcessSpawner>
}
// pure
export const watch: (previous: Conditions, report: Report) => readonly [ReadonlyArray<Notice>, Conditions] // NOTE-011..014
export const nudges: (report: Report, settings: Settings, now: DateTime.Utc) => ReadonlyArray<Notice> // NOTE-009/010
```

The command runs through `ChildProcess.make("sh", ["-c", command])` with the
`SLOPMAX_*` environment and a 30 s timeout. The told set lives in `state.json`,
so the dashboard, the desktop and the sinks are each told once.

Delivers: NOTE-001..015, DMN-018, APP-060..063 (as daemon state).

### 4.10 `Background`: a running proxy seen from outside

```ts
export class Background extends Context.Service<
  Background,
  {
    readonly running: Effect.Effect<Option.Option<{ readonly version: string }>> // GET /healthz, service == "slopmax" (BG-002)
    readonly client: Effect.Effect<HttpApiClient.Client<SlopmaxApiGroups, never, never>, NotRunning> // bearer apiKey; 1 s connect, 30 s total (BG-001)
    readonly ensure: Effect.Effect<{ readonly started: boolean }, StartFailed> // login service if installed, else detached serve; ≤ 5 s (BG-008/009/013)
    readonly stop: Effect.Effect<boolean> // POST shutdown; false when nothing answered (BG-010)
    readonly service: ServiceManager // §4.11
  }
>()("@slopmax/core/Background", { make }) {
  static readonly layer: Layer.Layer<Background, never, SettingsService | Home | ChildProcessSpawner>
}
```

The detached spawn is
`ChildProcess.make(exe, ["serve", "--log", paths.log], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" })`,
then `handle.unref`. The spawner's finalizer skips unref'd children. `serve
--log` makes the daemon append its own log lines to `slopmax.log` (BG-012).
`exe` is `process.execPath` in a compiled binary and the entry script under
`bun run`.

Delivers: BG-001..013, CLI start/stop/service, `run`'s auto-start.

### 4.11 `ServiceManager` (a value inside `Background`)

```ts
export interface ServiceManager {
  readonly kind: Option.Option<"systemd" | "launchd"> // None with SLOPMAX_NO_SERVICE or no manager (SVC-001, CLI-216)
  readonly status: Effect.Effect<{ readonly installed: boolean; readonly running: boolean; readonly file: string }>
  readonly install: Effect.Effect<string, ExitFailed | SpawnFailed | FileError> // stops a running proxy, waits 300 ms, installs, waits (BG-011)
  readonly uninstall: Effect.Effect<string, ExitFailed | SpawnFailed | FileError>
  readonly start: Effect.Effect<void, ExitFailed | SpawnFailed>
}
export const systemdUnit: (o: { exe: string; log: string; home?: string }) => string // SVC-003, tested as text
export const launchdPlist: (o: { exe: string; log: string; home?: string }) => string // SVC-004
```

Delivers: SVC-001..010.

### 4.12 Smaller services inside the proxy layer

These are private to `core/proxy` and built by `Proxy.layer`:

| Service       | What                                                                                                                                                            | Delivers                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `Planner`     | `Router.plan` memoized per `(model, dialect, agent, pathProvider)`. The map is cleared on `Accounts.changes` and `Settings.changes` and capped at 1024 entries. | ROUTE (as used)           |
| `Settler`     | an unbounded `Queue<Settlement>` fed with `Queue.offerUnsafe`. One fiber drains it with `takeAll` and applies pool, ledger and event updates.                   | PRX-071, PRX-080..083     |
| `LiveStreams` | a `Set` of live relays (`lastChunkAt`, `cancel`). Swept every 10 s and drained at shutdown.                                                                     | PRX-025, NET-010, NET-030 |
| `Catalog`     | `Cache.make({ lookup: provider.catalog, timeToLive: "10 minutes" })` per account. Failed lookups are not cached.                                                | PRX-090/091               |
| `Replay`      | `wire.ReplayBook` (bounded at 4096 entries, 2 h, per account) in a `Ref`                                                                                        | PRX-089, PRX-053          |

---

## 5. Values, not services

### 5.1 Providers (`core/providers/`)

```ts
export type Verdict = Data.TaggedEnum<{
  Final: {}
  Unauthorized: {}
  Forbidden: {}
  StaleState: {}
  Exhausted: { readonly until?: DateTime.Utc; readonly model?: string }
  Throttled: { readonly until?: DateTime.Utc }
}> // PROV-009
export interface Refusal {
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
  readonly model?: string
  readonly now: DateTime.Utc
}
export interface Grant {
  readonly access: string
  readonly refresh?: string
  readonly idToken?: string
  readonly expiresIn?: Duration.Duration
}

export interface Provider extends ProviderFacts {
  // Hot path: pure, called per attempt.
  readonly api: (a: Account) => string // base URL
  readonly dialectsOf: (a: Account) => ReadonlyArray<Dialect>
  readonly serves: (a: Account, model: string) => boolean
  readonly headers: (o: {
    readonly client: Headers
    readonly account: Account
    readonly moved: boolean
    readonly agents: SavedState["agents"]
    readonly codex: SavedState["codex"]
  }) => Headers
  readonly verdict: (r: Refusal) => Verdict
  readonly limitsFrom: (h: Headers, now: DateTime.Utc) => Option.Option<Limits>
  readonly showPool: (out: Headers, pool: ReadonlyArray<PoolWindow>) => Headers // agents see the pool, not the account (PROV-022..029)
  readonly rebind: (body: Uint8Array) => Option.Option<Uint8Array> // strip account-bound state when a session moves (PROV-046)
  readonly shape: (body: Record<string, unknown>) => Record<string, unknown> // last touch on translated bodies (PROV-049)
  readonly socket: Option.Option<SocketHooks> // Codex: rate-limit events, turn rules (PROV-053, WS-013..017)
  // Cold path: Effects over Upstream.http.
  readonly refreshLead: Duration.Duration
  readonly identity: (a: Account) => string | undefined
  readonly login: (
    o: LoginOptions,
  ) => Effect.Effect<Account, LoginFailed | LoginTimedOut | StateMismatch, Upstream | LoginUi | Scope.Scope>
  readonly refresh: (a: Account) => Effect.Effect<Grant, RefreshRevoked | RefreshTransient, Upstream>
  readonly identify: (a: Account) => Effect.Effect<Account, never, Upstream>
  readonly usage: Option.Option<(a: Account) => Effect.Effect<Limits, ProviderUnauthorized | ProviderFailed, Upstream>>
  readonly catalog: (
    a: Account,
    ctx: { readonly codexVersion?: string },
  ) => Effect.Effect<ReadonlyArray<string>, ProviderFailed, Upstream>
  readonly resets: Option.Option<{
    readonly counted: boolean
    readonly needsAgent: boolean
    readonly list: (
      a: Account,
      ua: string | undefined,
    ) => Effect.Effect<ReadonlyArray<LimitReset>, ProviderFailed, Upstream>
    readonly redeem: (
      a: Account,
      id: string | undefined,
      ua: string | undefined,
    ) => Effect.Effect<RedeemOutcome, ProviderFailed, Upstream>
  }>
}
export const defineProvider: (p: ProviderParts) => Provider // fills defaults (PROV-010)
export const matches: (pattern: string, model: string) => boolean
export const providers: { readonly [K in ProviderId]: Provider } // claude, codex, anthropic, openai, xai, compat
```

Files: `claude.ts` (OAuth, profile, header windows, pool headers, resets),
`codex.ts` (OAuth and device code, workspace headers, rebind, resets, catalog,
socket hooks), `keys.ts` (`anthropic`, `openai`, `xai` as data built by
`keyProvider`), `compat.ts` (compatible endpoints), and `oauth.ts`.

`oauth.ts` holds PKCE, state, JWT claims, and the browser sign-in:

```ts
export class LoginUi extends Context.Service<
  LoginUi,
  {
    readonly tell: (e: typeof LoginEvent.Type) => Effect.Effect<void>
    readonly pasted: Stream.Stream<string> // redirect addresses typed or pasted (AUTH-023/025)
    readonly openBrowser: boolean // the CLI opens it; the API leaves it to the UI (AUTH-030/031)
  }
>()("@slopmax/core/LoginUi") {}
export const browserLogin: (o: {
  title: string
  url: string
  port: number
  path: string
  state: string
}) => Effect.Effect<
  { readonly code: string; readonly state?: string },
  LoginFailed | LoginTimedOut | StateMismatch,
  LoginUi | Scope.Scope
>
export const signIn: (
  provider: ProviderId,
  options: LoginOptions,
) => Effect.Effect<
  { readonly account: Account; readonly isNew: boolean },
  LoginFailed | LoginTimedOut | StateMismatch,
  LoginUi | Accounts | Upstream
>
```

The callback server is a scoped `Bun.serve` on `127.0.0.1:<provider port>`. It
races pasted lines inside `Effect.timeout("10 minutes")`. A busy port sends a
`Note` and waits on pastes only (AUTH-020..027). The device code polls on
`Schedule.spaced(interval)` for up to 15 minutes (PROV-042).

**Adding a provider** means one file, one literal in `ProviderId`, one entry
in `providerFacts`, and one entry in `providers`. The type checker fails until
all four exist.

Delivers: PROV-001..073, AUTH-001..010, AUTH-020..035, LIM-019..022.

### 5.2 Agents (`core/agents/`)

```ts
export interface WireSettings {
  readonly baseUrl: string
  readonly apiKey: string
  readonly websockets: boolean
}
export interface Agent extends AgentFacts {
  readonly detect: (h: Headers) => boolean // AGT-014/026
  readonly session: (h: Headers, body: Uint8Array) => string | undefined // headers, then a byte peek (AGT-015/027)
  readonly launch: (
    s: WireSettings,
    args: ReadonlyArray<string>,
  ) => {
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly env: Record<string, string | undefined>
  }
  readonly shell: (s: WireSettings, exe: string) => string // `slopmax env` (AGT-016/028)
  readonly configFile: (p: Paths) => string
  readonly setup: (doc: string, s: WireSettings) => { readonly text: string; readonly backup: unknown } // one document in, one out
  readonly undo: (doc: string, backup: unknown) => string
  readonly wiredTo: (doc: string) => string | undefined
  readonly note: string
  readonly importLogin: Option.Option<
    (
      p: Paths,
    ) => Effect.Effect<Option.Option<Account>, LoginFailed, FileSystem.FileSystem | Upstream | ChildProcessSpawner>
  >
}
export const agents: { readonly [K in AgentId]: Agent }
// agent.ts: around the pure edits: follow symlinks, 0600 writes, backups.json (the first setup's backup is kept)
export const wiring: (id: AgentId) => Effect.Effect<AgentWiring, FileError, Home | SettingsService>
export const connect: (
  id: AgentId,
) => Effect.Effect<
  { readonly path: string; readonly note: string },
  FileError | LockTimeout,
  Home | Lock | SettingsService
>
export const disconnect: (
  id: AgentId,
) => Effect.Effect<{ readonly path: string }, FileError | LockTimeout | NothingToUndo, Home | Lock>
```

Claude Code is wired to `ANTHROPIC_BASE_URL=<base>/claude` with the owner key.
Codex's `config.toml` is edited in place with `@decimalturn/toml-patch`,
which keeps comments, and it gets `base_url = "<base>/codex"`. An agent's
`setup`/`undo` only transform text, so their tests are pure.

Delivers: AGT-001..039, IMP-001..012 (with `importers.ts`).

### 5.3 The router (`core/router.ts`, pure)

```ts
export interface Table {
  readonly accounts: ReadonlyArray<Account>
  readonly settings: Settings
}
export interface Ask {
  readonly model?: string
  readonly dialect: Dialect
  readonly agent?: AgentId
  readonly pathProvider?: ProviderId
}
export interface Step {
  readonly provider: ProviderId
  readonly model: string
  readonly accounts: ReadonlyArray<AccountId>
}
export type Plan = Data.TaggedEnum<{
  Steps: { readonly steps: ReadonlyArray<Step> }
  Refused: { readonly provider: ProviderId; readonly agent: AgentId } // agentOnly (PRX-036)
  Unserved: { readonly model: string }
  NoModel: {}
}>
export const plan: (t: Table, a: Ask) => Plan // aliases (one level), fallbacks, provider/ and account/ selectors,
// paid overflow, agentOnly, dialect reachability (ROUTE-001..010)
```

### 5.4 Other pure modules

- `pricing.ts`: list prices, plan fees, plan shares, cost (LED-040..046).
- `report.ts`: `buildReport({ accounts, pool, settings, now, version, live, pooled, next, nudges }) => Report`
  (REP-001..013). The CLI's offline status uses it with `live: false`
  (REP-006).
- `doctor.ts`: a list of small Effects, one per check, run with
  `{ concurrency: "unbounded" }` (DOC-001..018). The CLIProxyAPI probe port is
  a parameter. The port holder comes from `port-holder.ts`: `/proc/net/tcp{,6}`
  through `FileSystem` on Linux, `lsof` through `ChildProcess` on macOS
  (NET-031).
- `importers.ts`: `discover(source)` and `save(found, own)`, with lenient
  Schemas for Claude Code's `.credentials.json` (or the macOS keychain through
  `security`), Codex's `auth.json`, and CLIProxyAPI's `*.json` (IMP-001..012,
  CLI-217).
- `browser.ts`: `open(url): Effect<boolean>` (`open`, `explorer`,
  `xdg-open`; false without a display) (AUTH-030/031, CLI-212).
- `log.ts`: the `Logger` layer. The level comes from `SLOPMAX_LOG` (info for
  `serve`, else warn). Lines read `{time} {LEVEL} {message}`, colored only on a
  TTY without `NO_COLOR`. `serve --log <file>` appends to the file
  (COM-011, CLI-001/002).

---

## 6. The proxy

### 6.1 URL layout

| Path                                                       | What                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /healthz`                                             | `{ status: "ok", service: "slopmax", version }`, no key, a static `Response` (PRX-001)                             |
| `HEAD *`, `* …/api/hello`                                  | 200 with an empty body and no key: Claude Code's probes (PRX-002)                                                  |
| `/claude/*`                                                | Claude Code (Messages). `ANTHROPIC_BASE_URL=<base>/claude`. Path provider `claude`.                                |
| `/codex/*`                                                 | Codex (Responses, and the WebSocket on `/codex/responses`). `base_url=<base>/codex`. Path provider `codex`.        |
| `/v1/messages*`, `/v1/responses*`, `/v1/chat/completions*` | Anthropic- and OpenAI-style clients, routed by model (PRX-011..013). `/v1/responses` also takes WebSockets.        |
| `GET /v1/models`                                           | the merged model list (§6.9). `/claude/v1/models` and `/codex/models` are forwarded to the provider (PRX-004/013). |
| `/slopmax/api/*`                                           | slopmax's own `HttpApi` (§7)                                                                                       |
| `/slopmax/`, `/slopmax/assets/*`                           | the web dashboard (§8)                                                                                             |
| `/v0/management/*`                                         | the CLIProxyAPI-compatible hub (§7.3), fixed by T3 Code                                                            |
| anything else                                              | 404 in Messages' error shape: `unknown path; slopmax serves /claude/*, /codex/*, and /v1/*` (PRX-005)              |

### 6.2 The front door (`server.ts`, `proxy/classify.ts`)

```ts
// pure
export type Entry = Data.TaggedEnum<{
  Hello: {}; Inference: { readonly route: Route }; Socket: { readonly route: Route }
  Web: {}; Unknown: {}
}>
export interface Route {
  readonly pathProvider?: ProviderId; readonly dialect: Dialect
  readonly upstreamPath: string // the path + query to forward
  readonly byModel: boolean; readonly listing: boolean; readonly countTokens: boolean
}
export const classify: (method: string, url: string, headers: Headers) => Entry

// server.ts
export class Server extends Context.Service<Server, { readonly address: string; readonly drain: Effect.Effect<void> }>()(…) {
  static readonly layer: Layer.Layer<Server, ListenFailed, Proxy | Relay | WebApp | SettingsService | LiveStreams | Scope.Scope>
}
```

`Server.layer`:

```ts
const context = yield * Effect.context<ProxyServices>() // built once
const run = Effect.runCallbackWith(context)
const web = yield * WebApp // HttpRouter.toWebHandler(apiAndHubAndUi, { disableLogger: true }), provided with the same context
const server = Bun.serve({
  hostname,
  port,
  idleTimeout: 0,
  maxRequestBodySize: 256 * 1024 * 1024, // 413 past it (PRX-026)
  routes: { "/healthz": HEALTH },
  fetch(req, srv) {
    const entry = classify(req.method, req.url, req.headers)
    switch (entry._tag) {
      case "Hello":
        return HELLO
      case "Unknown":
        return UNKNOWN
      case "Web":
        return web.handler(req)
      case "Socket":
        return relay.accept(req, srv, entry.route) // Promise<Response | undefined>
      case "Inference":
        return new Promise<Response>((resolve) => {
          const interrupt = run(proxy.handle(req, entry.route), {
            onExit: (exit) =>
              resolve(Exit.isSuccess(exit) ? exit.value : replies.defect(entry.route.dialect, exit.cause)),
          })
          req.signal.addEventListener("abort", () => interrupt(), { once: true }) // client gone before the first byte
        })
    }
  },
  websocket: relay.handlers,
})
Bun.unsafe.setJITPolicy(1)
yield * Effect.addFinalizer(() => drain(server)) // stop(false); LiveStreams drain ≤ 10 s; stop(true) (NET-030, DMN-013)
```

A bind failure is `ListenFailed { address, holder }` with the holder from
`port-holder.ts` (DMN-001, NET-031). The web app's layer is
`Layer.succeedContext(context)` under the `HttpApiBuilder` layer, so the admin
API sees the same `Pool`, `Ledger` and `Events` as the proxy. A test checks
this.

### 6.3 A request, end to end (`proxy/inbound.ts`, `auth.ts`, `forward.ts`)

```ts
export interface Inbound {
  readonly route: Route; readonly headers: Headers; readonly body: Uint8Array
  readonly caller: Caller // Owner | Client(ClientKey)
  readonly peek: { readonly model?: string; readonly modelCount: number; readonly stream: boolean; readonly cacheKey?: string; readonly userId?: string }
  readonly agent?: AgentId; readonly session?: string; readonly housekeeping: boolean
  readonly startedAt: number // Clock millis
}
export const handle = Effect.fn("Proxy.handle")(function* (req: Request, route: Route) {
  const settings = yield* settingsService.get
  const caller = authenticate(req.headers, settings) // constant-time; precomputed buffers (PRX-006)
  if (caller === undefined) return replies.noKey(route.dialect) // 401 in the route's format
  const body = yield* readBody(req) // Effect.callback(req.arrayBuffer())
  const inbound = inspect(route, req.headers, body, caller, settings) // pure: wire.scan peeks; agent and session (AGT-015/027)
  yield* pool.update(Pool.sawAgent(...)) // PRX-008/009: client UA, Codex version
  const gate = keyGate(inbound) // PRX-034: a client key may not send two models or route past its models
  if (gate._tag === "Reply") return gate.response
  const plan = yield* planner.plan(inbound) // memoized Router.plan
  if (plan._tag !== "Steps") return replies.noRoute(plan, inbound)
  if (route.countTokens && !speaks(plan.steps[0], "messages")) return countTokens.estimate(inbound) // PRX-039
  return yield* forward(inbound, plan.steps)
})
```

What is peeked and what is decoded:

| Value                               | How                                                                                    | When                               |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| key (`authorization` / `x-api-key`) | header read; `timingSafeEqual` against precomputed buffers                             | every request (PRX-006)            |
| agent, Codex version, client UA     | `startsWith` on `user-agent`                                                           | every request (PRX-008/009)        |
| body inspectable?                   | no `content-encoding` (or `identity`), framed as one object; `isJson` for held keys    | every POST (PRX-031, NOT-PORTED)   |
| `model`, count of top-level `model` | `wire.scan.find(bytes, "model")`, `countTopLevel`                                      | every POST (PRX-032/034)           |
| `stream`                            | `wire.scan.find` → the literal `true`                                                  | translated requests                |
| session                             | headers, else `metadata.user_id` / `prompt_cache_key` by `scan.find`                   | every request                      |
| model rename                        | `wire.scan.splice(bytes, range, JSON.stringify(model))`                                | when an alias renamed it (PRX-051) |
| account-bound state                 | `JSON.parse`, edit, stringify that body only                                           | moved session or stale-state retry |
| whole request                       | `JSON.parse` + `Schema.decodeUnknownSync(format.request)`                              | only when translating (§6.8)       |
| refusal body                        | read whole; `provider.verdict` scans bytes                                             | non-2xx only                       |
| rate-limit headers                  | `provider.limitsFrom(headers)`                                                         | every response (PRX-055)           |
| SSE events                          | byte line split; only `data:` lines mentioning `usage`, `error` or `failed` are parsed | native taps (PRX-081)              |

### 6.4 The failover loop (`forward.ts`)

```ts
const forward = Effect.fn("Proxy.forward")(function* (inbound: Inbound, steps: ReadonlyArray<Step>) {
  const settings = yield* settingsService.get
  const tried = new Set<AccountId>()
  let last: Failure | undefined
  let soonest: DateTime.Utc | undefined
  for (const step of steps) {
    let rescued = false
    for (;;) {
      const picked = yield* pool.modify((m, now) => Pool.pick(m, pickRequest(inbound, step, tried, settings), now))
      if (picked._tag === "NoneReady") {
        soonest = earliest(soonest, picked.until) // PRX-042
        if (!rescued && picked.spent && settings.redeemWhenExhausted) {
          rescued = true
          const freed = yield* quota.rescue(step.provider) // PRX-041/072
          if (Option.isSome(freed)) {
            tried.delete(freed.value)
            continue
          }
        }
        break
      }
      tried.add(picked.account.id)
      const result = yield* attempt(picked.account, picked.movedFrom !== undefined, step, inbound)
      switch (result._tag) {
        case "Served":
          return result.response // the first byte goes to the client from here
        case "Answer":
          return yield* passBack(result.failure, inbound, tried.size) // the client's problem: pass it back
        case "Skip":
          continue // not ready (signed out, refresh failed): no record
        case "Next":
          last = result.failure
          continue
      }
    }
  }
  return yield* giveUp(inbound, steps, last, soonest, tried.size) // limit reply in the client's format, or 503 (PRX-043..046)
})
```

`attempt` (`attempt.ts`) runs one account and retries at most once, on that
account, inside itself:

```ts
export type Attempt = Data.TaggedEnum<{
  Served: { readonly response: Response }
  Next: { readonly failure: Failure } // health already recorded; try the next account
  Answer: { readonly failure: Failure } // pass it back
  Skip: {}
}>
export interface Failure {
  readonly provider: ProviderId
  readonly account?: AccountId
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
  readonly lane: Lane
}
export type Lane = Data.TaggedEnum<{ Native: {}; Translate: { readonly from: Dialect; readonly to: Dialect } }>
```

1. `accounts.ready(account)`. A fresh token needs no I/O. `RefreshRevoked`
   means `Skip`. `RefreshTransient` with an unexpired token uses the current
   token (PRX-020).
2. Pick the lane: `Native` when the account speaks the client's dialect, else
   `Translate` when `wire.canTranslate(client, upstream)` (PRX-048, WIRE-020).
3. Build the request. Native: the same bytes, the model spliced, `rebind` when
   the session moved, `provider.headers`. Translated: §6.8.
4. `upstream.send`. `Unreachable` records `network error: …` and gives `Next`
   (PRX-054).
5. `pool.update(Pool.observe(provider.limitsFrom(headers)))` on every answer
   (PRX-055).
6. 2xx: if the dialect holds its start (Responses), run the held start (§6.5).
   `Refused` blocks or throttles and gives `Next` with the held bytes.
   Otherwise `Served` with the relay (§6.6).
7. Non-2xx: read the body whole (`readAll`, 64 MiB), log it, then `Match` on
   `provider.verdict(refusal)`:
   - `Unauthorized`, the first time, refreshable, `refreshTokens` on →
     `ready(force)` and retry.
   - `StaleState`, the first time → strip the state and retry.
   - `Unauthorized` or `Forbidden` → block 30 minutes, `Next`.
   - `Exhausted { until, model }` → block until `until` (else 5 minutes),
     per model when given, `Next`.
   - `Throttled { until }` → throttle until `until` (else 30 s), `Next`.
   - `Final` with 500, 502, 503, 504 or 529, the first time →
     `Effect.sleep("400 millis")` and retry. The second time → record and
     `Next` (PRX-064).
   - any other `Final` → `Answer` (PRX-066/067).

`passBack` returns a native failure as it came. A translated one is retold in
the client's format (`wire.retell`): the message comes from the usual JSON
paths or `data:` lines, and a Messages client hears any 5xx as 529. Every
final non-2xx is recorded in the ledger with its attempt count
(PRX-043/044/046). **Failover happens only before the first byte.** After
`Served`, upstream errors reach the client inside the stream.

### 6.5 The held start (`hold.ts`)

Responses can refuse inside a 200 stream. The first events are held back (at
most 3 s and 256 KiB) so the proxy can move to another account before the
client gets anything (PRX-085, PRX-056, WIRE-005).

```ts
export type Held = Data.TaggedEnum<{
  Streaming: {
    readonly reader: Reader
    readonly held: ReadonlyArray<Uint8Array>
    readonly pending?: Promise<ReadResult>
  }
  Refused: { readonly bytes: Uint8Array; readonly exhausted: boolean }
}>
export const holdStart = Effect.fn("Proxy.holdStart")(function* (
  body: ReadableStream<Uint8Array>,
  judge: wire.Opening,
) {
  const reader = body.getReader()
  const held: Array<Uint8Array> = []
  let size = 0
  let pending: Promise<ReadResult> | undefined
  const deadline = (yield* Clock.currentTimeMillis) + 3_000
  while (size < 256 * 1024) {
    pending ??= reader.read()
    const left = Math.max(0, deadline - (yield* Clock.currentTimeMillis))
    // Waiting on the read can time out; the read itself is never cancelled.
    const next = yield* awaitRead(pending).pipe(Effect.timeoutOption(left))
    if (Option.isNone(next)) return Held.Streaming({ reader, held, pending }) // the relay awaits `pending` first
    pending = undefined
    if (next.value.done) return Held.Streaming({ reader, held })
    held.push(next.value.value)
    size += next.value.value.byteLength
    const verdict = judge.feed(next.value.value) // pure: Wait | Content | Refused { exhausted }
    if (verdict._tag === "Content") return Held.Streaming({ reader, held })
    if (verdict._tag === "Refused") {
      yield* cancelReader(reader)
      return Held.Refused({ bytes: concat(held), exhausted: verdict.exhausted })
    }
  }
  return Held.Streaming({ reader, held })
})
```

`awaitRead` is `Effect.callback` over an existing promise and ignores
interruption, so a timeout loses no chunk. If the request's fiber is
interrupted while holding, an `onExit` finalizer cancels the reader unless it
was handed to the relay. `TestClock` drives the 3 s budget in tests.

### 6.6 The relay, the tap, and settling (`relay.ts`, `settle.ts`)

```ts
export interface RelayPlan {
  readonly reader: Reader
  readonly held: ReadonlyArray<Uint8Array>
  readonly pending?: Promise<ReadResult>
  readonly tap: wire.Tap // pure: chunk(bytes) → void; finish() → TapOutcome
  readonly transcoder?: wire.Transcoder // pure: push(bytes) → Uint8Array[]; end() → Uint8Array[]
  readonly settle: (end: StreamEnd) => void // once-guarded; Queue.offerUnsafe(settler, …)
  readonly clock: Clock.Clock // currentTimeMillisUnsafe; follows TestClock in tests
}
export interface StreamEnd {
  readonly how: "ended" | "errored" | "dropped" | "stalled"
  readonly outcome: wire.TapOutcome // usage, exhausted mid-stream, failed
  readonly firstByteAt?: number
}
export const relay: (plan: RelayPlan, live: LiveStreams) => ReadableStream<Uint8Array>
```

- The `ReadableStream` has `highWaterMark: 0`, so it pulls only when the
  client reads. `pull` replays `held`, then `pending`, then `reader.read()`.
  Each chunk goes to `tap.chunk` and then, translated or not, is enqueued.
  `lastChunkAt` is set on the live entry. `cancel` (the client hung up)
  cancels the upstream reader and settles `dropped`.
- **The tap** (`wire/tap.ts`) chooses its shape from the headers (PRX-080):
  `Opaque` (compressed: count the request only), `Document` (`json`: buffer
  up to 16 MiB and read at the end), or `Events`. In event mode it splits on
  `0x0a` with a carry buffer, skips lines over 16 MiB, decodes only `data:`
  lines, and parses only those that mention `usage`, `error` or `failed`. It
  folds them with the dialect's observer (WIRE-006..008). Bytes pass through
  untouched.
- **Settling exactly once.** `settle` is guarded by a flag and pushes a
  `Settlement` with `Queue.offerUnsafe`. The `Settler` fiber applies it:
  `Pool.succeeded` with the usage, or a 5-minute block when the stream said it
  was exhausted mid-way (PRX-071), plus `Ledger.record` with `ms`,
  `firstByteMs`, attempts, agent and session (PRX-080..083). A stream end
  starts no fiber and runs no synchronous Effect.
- Response headers are copied from upstream. `provider.showPool` rewrites the
  rate-limit headers with the cached pooled windows (PRX-021).

### 6.7 Stalls and shutdown (`live.ts`)

`LiveStreams` is a `Set` of `{ lastChunkAt, cancel(reason) }`. The daemon runs
one sweeper on `Schedule.spaced("10 seconds")`. It errors relays whose
`lastChunkAt` is more than 600 s old with
`no data for 600 s` and settles them `stalled` (PRX-025, NET-010). Shutdown
stops accepting, waits for the set to empty for up to 10 s, then cancels the
rest (NET-030, DMN-013). Both follow `Clock`.

### 6.8 Translation through `wire`

Translation happens only when the account cannot speak the client's format.

1. `formats[client].decodeRequest(json)`: `JSON.parse`, then
   `Schema.decodeUnknownSync` over lenient structs (unknown fields ignored)
   into `common.Request`. It runs once per request, lazily, and is reused
   across steps. A decode error is a 400 with its message (PRX-052,
   WIRE-022/030/040/060).
2. Set the step's model and the cache key (the session when the client gave
   none). For a Responses upstream, restore the remembered reasoning state
   from `Replay` for calls this account issued (PRX-053).
3. `formats[upstream].encodeRequest(request)` builds the body in key order,
   then `provider.shape`, sent with minimal headers.
4. Streaming answers: `wire.transcoder(from, to, ctx)` returns a pure
   `Transcoder`. Its decoder uses `Sse.makeParser` (every event matters here)
   into `common.Event` (`Text | Reasoning | State | Call | Done | Failed`), and
   its encoder writes the client's frames (WIRE-009/032/050/064). It has a
   64 MiB cap and turns a cut stream into an error event (PRX-087). Its
   `watch` hook records reasoning state per call id (PRX-070).
5. Whole answers (`stream: false`, warmups): the upstream body is read inside
   the Effect (bounded) and `wire.collect` (WIRE-014) feeds `to.whole`
   (WIRE-033/053/065).
6. Compaction emulation (a sealed summary) and the freeform-tool mapping live
   in `wire/compaction.ts` and `wire/chat.ts` (WIRE-023..025, 052, 056).

A property test splits every recorded upstream stream at random byte offsets
and checks the transcoder's output does not change.

### 6.9 `/v1/models` (`models.ts`)

The list merges the catalogs of every enabled, signed-in account whose
provider has no `agentOnly`. Lookups run concurrently through `Catalog`.
Results are deduplicated and sorted, the aliases are added, and a client key's
patterns filter the list (PRX-090/091).

### 6.10 The Codex WebSocket relay (`socket.ts`)

`Relay` is a service with `accept(req, srv, route)` and Bun's `handlers`.

1. **Refusals** answer 426 in Responses' error shape, so Codex falls back to
   HTTP streaming at once. The causes: websockets off; not `/codex/responses`
   or `/v1/responses`; a client key held to some models; a bad
   `sec-websocket-version`; a routing hint (`x-codex-routing-hint: model=…`)
   naming a model not served natively by a ChatGPT account; no account ready.
   A missing `sec-websocket-key` gets 400 (WS-001..008).
2. **Upstream first.** Pick the account as an HTTP request does (session from
   headers). Copy the client's headers through `provider.headers(moved)`, add
   `openai-beta: responses_websockets=2026-02-06` unless the client sent one,
   and drop `accept-encoding`. Then `upstream.dial(api + "/responses", headers)`
   through the configured proxy, waiting at most 15 s (WS-009).
3. Then
   `srv.upgrade(req, { headers: pick(up.headers, "openai-model", "x-reasoning-included", "x-models-etag"), data: state })`.
   Bun writes the 101 and the accept key (WS-010). A failed handshake never
   upgrades the client.
4. **Frames.** Per-socket state (`RelayState`: account, moved, agent,
   session, the current turn, closing) is the only shared object. Decisions
   are pure functions of the Codex provider's `SocketHooks`. Effects (pool,
   ledger) go through the `Settler` queue.
   - Client text that starts a turn (`"type":"response.create"` in the first
     64 bytes) is parsed. On a moved socket it drops `previous_response_id`,
     `encrypted_content` and `x-codex-turn-state`, and is re-serialized only
     if something was dropped (WS-013).
   - Upstream text is parsed only when its type prefix is `codex.rate_limits`
     (the pool observes it, and the client gets it rewritten to show the pool,
     WS-015), `response.completed`, `incomplete` or `done` (success and a
     ledger record with `via: "socket"`, WS-016), or `response.failed`/`error`
     (judged: spent → block and close both sides with 1012 so Codex
     reconnects elsewhere; overload → throttle, WS-017).
   - Everything else is forwarded untouched. Bun and `ws` answer pings
     (WS-012/014).
5. **Backpressure.** When `ws.send` to the client returns −1, the relay calls
   `up.pause()` until Bun's `drain` handler calls `up.resume()`. In the other
   direction, a client message is forwarded while `up.bufferedAmount` stays
   under 64 MiB. Past that, the client is closed with 1013. On close, an
   Effect forked into the daemon's `FiberSet` gives queued frames up to 5 s
   (WS-011).
6. **Framing** (NET-040..042) is Bun's and `ws`'s RFC 6455 code. Its tests
   become e2e round trips of 0, 125, 126, 65,535 and 65,536-byte text and
   binary messages, plain and through a CONNECT proxy, and `wss` through the
   proxy.

### 6.11 How it stays fast

- One `Bun.serve`. Every layer is built once, and nothing allocates services
  per request. A request costs one fiber and no `HttpServerRequest` or
  `HttpClientRequest` objects.
- Bodies are one `Uint8Array`. Peeking scans bytes and stops early. The model
  is spliced. A native body is never serialized again.
- `Router.plan` is memoized, pooled windows are cached, and accounts are read
  from memory.
- The tap parses only lines that mention usage or an error. Relays pull only
  when the client reads. `decompress: false`. `TCP_NODELAY` is Bun's default.
- One stall timer for every stream, and no fiber per stream end.
- No trace spans or propagation headers unless `SLOPMAX_TRACE=1`, and
  propagation never reaches providers.

---

## 7. slopmax's own API, events, and the hub

### 7.1 `SlopmaxApi` (`domain/api.ts`, prefix `/slopmax/api`)

```ts
export class OwnerKey extends HttpApiMiddleware.Service<OwnerKey>()("OwnerKey", {
  security: { bearer: HttpApiSecurity.bearer, header: HttpApiSecurity.apiKey({ in: "header", key: "x-api-key" }) },
  error: Unauthorized,
}) {} // owner key only, constant time; client keys get 401 (ADM-002)

export class SlopmaxApi extends HttpApi.make("slopmax")
  .add(System)
  .add(Accounts)
  .add(Logins)
  .add(Config)
  .add(Agents)
  .add(Usage)
  .add(Events)
  .add(Notify)
  .middleware(OwnerKey)
  .prefix("/slopmax/api") {}
```

| Group      | Endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Delivers                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `system`   | `GET /status` → `Report` · `POST /refresh` → `Report` (polls usage and lists resets now; concurrent calls share one run) · `POST /sync` → `Report` (re-read settings, accounts) · `POST /shutdown` → `{ status: "stopping" }` · `GET /doctor` → `Section[]`                                                                                                                                                                                                                          | ADM-004..007, ADM-020, DMN-022 |
| `accounts` | `POST /accounts` `AddAccount` (`Key { provider, key, label? }` \| `Endpoint { url, dialect, models, key?, label? }`) → `{ account: AccountView, report }` · `PATCH /accounts/:id` `{ label?: string \| null, priority?, disabled? }` → `Report` · `POST /accounts/:id/pin` · `DELETE /pins` · `POST /accounts/:id/own` · `DELETE /accounts/:id` (each → `Report`) · `POST /accounts/:id/redeem` `{ reset? }` → `RedeemResult` · `POST /imports` `{ sources?, own }` → `ImportResult` | ADM-013..016, APP-030..039     |
| `logins`   | `POST /logins` `{ provider, device? }` → `{ id }` · `POST /logins/:id/paste` `{ address }` · `DELETE /logins/:id`. Progress arrives as `Event.Login`.                                                                                                                                                                                                                                                                                                                                | APP-030..032, APP-038          |
| `config`   | `GET /settings` → `SettingsView` · `PATCH /settings` `LivePatch` → `SettingsView` (the whole patch is validated before anything is written) · `GET /keys` → `{ name, models }[]` · `POST /keys` `{ name, models }` → `{ name, key, models }` (shown once) · `DELETE /keys/:name` → `{ name, models }[]`                                                                                                                                                                              | ADM-010/011, ADM-017..019      |
| `agents`   | `GET /agents` → `AgentWiring[]` · `POST /agents/:id/connect` → `{ path, note }` · `POST /agents/:id/disconnect` → `{ path }`                                                                                                                                                                                                                                                                                                                                                         | APP-035, DESK-080              |
| `usage`    | `GET /usage?range&by` → `Summary` · `GET /history?range` → `History`                                                                                                                                                                                                                                                                                                                                                                                                                 | ADM-008/009, APP-044           |
| `events`   | `GET /events` → `HttpApiSchema.StreamSse(Event)`: `Hello`, `Status`, then live `Request`, `Notice`, `Login` events, and `Ping` every 15 s                                                                                                                                                                                                                                                                                                                                            | ADM-012, APP-015..017          |
| `notify`   | `POST /notify/test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | NOTE, CLI `notify`             |

- Handlers (`core/api/handlers.ts`) are thin `HttpApiBuilder.group` calls.
  Each one calls the same service method the CLI calls in process. After an
  account or settings change they `Pool.sync`, which triggers a `Status`
  event.
- Unknown paths under `/slopmax/api/` answer 404 `no such slopmax endpoint`
  (ADM-003). Bodies are capped at 64 KiB.
- **Status events** (`api/status.ts`): `Pool.changes`, `Accounts.changes` and
  `Settings.changes` are merged, debounced 250 ms, and joined by a 15 s tick
  (for time-based conditions). Each builds the report and publishes `Status`
  when it differs from the last one. Nothing is built while no one watches
  (`Events.watching`).
- **Sign-in for API callers** (`api/logins.ts`) keeps a `FiberMap<LoginId>`.
  Each session runs `signIn` with a `LoginUi` whose `tell` publishes
  `Event.Login` and whose `pasted` stream is a `Queue` fed by `/paste`.
  `DELETE` interrupts the fiber, which closes the callback server. The UI opens
  the authorize URL itself, so sign-in from another machine works through the
  paste path.

### 7.2 The client

`Background.client` is
`HttpApiClient.make(SlopmaxApi, { baseUrl, transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(key)) })`
over `FetchHttpClient` with tracing off. The UI uses `AtomHttpApi.Service`
(§8). Electron main uses the same `HttpApiClient` on Node 24's `fetch`. One
definition gives typed clients in Bun, Node and Chromium.

### 7.3 The hub (`core/api/hub-api.ts`, `hub.ts`)

`HubApi = HttpApi.make("hub").prefix("/v0/management")` has three endpoints:
`GET auth-files`, `POST api-call`, and `POST reset-quota`. A `ManagementKey`
middleware accepts the owner key as a bearer token, as `x-api-key`, or as
`x-management-key` (trimmed, constant time). Errors are `HubError`, encoded
`{ "error": message }`. Unknown paths answer 404 with HUB-002's text.
`api-call` is always HTTP 200 with the inner status, header and body (HUB-006).
Its payload accepts `auth_index`, `authIndex` and `AuthIndex` through a
Schema transformation. Answers come from the pool's readings and `Quota`,
never from relayed upstream calls, so no token leaves the engine
(HUB-005..012). It is a separate `HttpApi` because its auth and error shape
are T3 Code's, not ours.

Delivers: HUB-001..012.

---

## 8. The UI (`apps/ui`): one React app, two hosts

The dashboard and the desktop window are one app: React 19, Tailwind v4,
shadcn/ui on Base UI, checked as STYLING.md says. `build.ts` builds it twice:

- `dist/web/`, embedded in the CLI binary and served at `/slopmax/`;
- `dist/desktop/`, shipped inside the desktop app and served from
  `app://slopmax/`.

Asset URLs are relative, so both hosts load the same files. The API base is
`/slopmax/api` in both. In the desktop, Electron main forwards
`app://slopmax/slopmax/api/*` to the daemon (§13).

```
apps/ui/
  index.html  build.ts (Bun.build + the 20-line Tailwind plugin from RUNTIME.md; hashed names; .br and .gz)
  src/
    main.tsx            RegistryProvider; picks the host; error boundary
    host.ts             Host service: web (key from #key= → sessionStorage, Notification API, window.open)
                        | desktop (window.slopmaxDesktop bridge: proxy state, offline report, shell actions)
    api.ts              class Api extends AtomHttpApi.Service<Api>()("Api", { api: SlopmaxApi, httpClient: FetchHttpClient.layer, baseUrl: "/slopmax/api" })
    atoms.ts            report, settings, keys, agents, doctor, history(range), liveRequests, login(id), proxy, offline, now (1 s)
    view/               pure view model: groups, slots, gauges, pace, attention, words, chart axes (bun test)
    pages/              overview, provider, usage, performance, requests, agents, access, diagnostics, settings, panel, gate, offline
    components/ui/      shadcn components (button, switch, dialog, dropdown-menu, segmented, stepper, toast, tooltip, …)
    components/charts.tsx  hand-drawn SVG: stacked columns, lines, heatmap, segmented meter (no chart library)
    fonts/              IBM Plex Sans 400/500/600, Latin subset (@fontsource), OFL shipped
```

How state flows:

- One `events` atom runs `GET /events` through the HttpApi client's SSE
  `Stream`. `Status` replaces the `report` atom. `Request` appends to
  `liveRequests` (the last 200) and invalidates `history` through `Reactivity`
  keys, debounced 8 s. `Login` drives the sign-in card. `Notice` posts a
  browser notification once per browser in the web host (ADM-035,
  `localStorage`). The desktop host leaves notices to Electron main.
- Mutations are `api.mutation(...)` atoms with `reactivityKeys: ["report"]`.
  Their `Report` answers are written into `report` at once.
- `now` ticks every second for countdowns and pace (ADM-043, DESK-009).
- When the stream drops, the live indicator reads Reconnecting and the atom
  retries with backoff from 1 s, doubling to 15 s (ADM-042). In the desktop
  host, a stopped proxy switches to the offline page (§13.3).
- Text, numbers and times go through `@slopmax/domain/format`, so the CLI, the
  UI and the tray say the same thing.

Serving the web build (`api/assets.ts`): `apps/cli/build.ts` runs the UI build
and generates `apps/cli/src/embedded.ts`, which imports every `dist/web/*`
file with `{ type: "file" }` and provides the `Assets` layer. Responses use
`content-encoding: br` or `gzip` by `accept-encoding` (an identity copy is
decompressed once and cached), ETags, `cache-control: public, max-age=31536000, immutable`
for hashed assets, and `no-cache` for `index.html`. The CSP is
`default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
plus `referrer-policy: no-referrer` and `x-content-type-options: nosniff`.
There is no inline script. The cost is about 250 KB compressed in the binary.

The gate (ADM-047): without a key the page asks for one (`sm-…`). A 401
returns to the gate.

Delivers: ADM-030..053, APP-001..009 (as atoms), APP-030..047 (as UI flows),
APP-070..105, DESK-013..101, DESK-125..145, DESK-155.

---

## 9. Background work (`core/daemon.ts`)

```ts
export const Daemon = {
  layer: Layer<never, ListenFailed | AlreadyServing | SettingsInvalid | FileError, CoreServices>,
  serve: (options: { readonly log?: string }) => Effect.Effect<void, …, BunServices>, // ends on SIGINT, SIGTERM, or POST /shutdown
}
const every = (period: Duration.Input, task: Effect.Effect<void, unknown>, when: (s: Settings) => boolean = () => true) =>
  Effect.gen(function* () { if (when(yield* settingsService.get)) yield* task }).pipe(
    Effect.catchCause((c) => Effect.logWarning(Cause.pretty(c))), // a failure never ends the schedule
    Effect.repeat(Schedule.spaced(period)), // runs at once, never overlaps itself, no catch-up burst (DMN-003)
    Effect.forkScoped,
  )
```

| Task                                                     | When                                                                                           | Delivers                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------- |
| Reload settings; rescan accounts                         | `Home.watch([config.json, accounts/])`, debounced 100 ms, plus `every("30 seconds")` as backup | DMN-004, PRX-018/019, CFG-035 |
| Record lapsed windows; save `state.json`; prune sessions | `every("10 seconds")` (only when dirty)                                                        | DMN-005, DMN-019              |
| Refresh due tokens                                       | `every("5 minutes", …, s => s.refreshTokens)`                                                  | DMN-006, DMN-021              |
| List limit resets due                                    | `every("1 minute")`                                                                            | DMN-007, DMN-016              |
| Redeem resets about to expire                            | `every("30 minutes", …, s => s.redeemExpiring)`                                                | DMN-008, DMN-017              |
| Warm idle ChatGPT windows                                | `every("1 minute", …, s => s.warmWindows)`                                                     | DMN-009, PRX-095/096          |
| Watch conditions and nudges, notify                      | `every("15 seconds", notifier.look)`                                                           | DMN-010, DMN-018              |
| Poll usage due                                           | `every("1 minute", …, s => s.pollMinutes > 0)`                                                 | DMN-011, DMN-014/015          |
| Stall sweeper                                            | `every("10 seconds")`                                                                          | PRX-025                       |
| Settler                                                  | a continuous `Queue.takeAll` loop                                                              | PRX-071, PRX-080..083         |
| Status publisher                                         | on changes, debounced 250 ms, plus 15 s, while watched                                         | ADM-012, APP-015              |

The order in `Daemon.layer`: take `Lock.hold("serve")` (a second daemon on the
same home fails `AlreadyServing`), load `state.json` (malformed fails the
start, DMN-002), sync the pool once, build the proxy context, listen, log
`slopmax {version} listening on {base}` (DMN-012), and fork the tasks. When
the scope closes: drain the server, flush the settler and the ledger, save
`state.json`, release the lock, and log `stopped`.

`serve` builds `Daemon.layer` and waits on a `Deferred` completed by
`POST /shutdown`. `BunRuntime.runMain` handles SIGINT and SIGTERM (DMN-013).
Tests build the daemon without its schedules and call `quota.pollDue` and the
rest directly (HAR-002).

---

## 10. Persistence and locking

### 10.1 Files

```
$SLOPMAX_HOME (default ~/.slopmax; dirs 0700, files 0600, atomic replace)
  config.json            Settings (§3.6), written by people, the CLI and the API
  config.schema.json     generated from Settings
  accounts/<id>.json     one Account each
  state.json             SavedState: health, sessions, turns, pins, client UAs, Codex info, told, lapsed (daemon)
  backups.json           what agent setup replaced, per agent (the first backup is kept)
  usage/YYYY-MM.ndjson   LedgerRecord lines (Request and WindowEnded), by UTC month
  slopmax.log            the background daemon's log
  locks/<name>.lock      cross-process locks
```

`KeyValueStore` was considered and not used. Each file is one typed document
with its own lifecycle and needs atomic 0600 writes, which `Home.write` gives
directly. NDJSON fits an append-only ledger that is read by range. SQLite would
add a dependency and migrations for no feature.

### 10.2 Who writes what

| File                 | Writers                                                                     | Guard                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`        | the CLI, API handlers, people                                               | `Lock.with("config")` around read-modify-write. The daemon's watcher reloads.                                                                                                                   |
| `accounts/<id>.json` | the CLI (login, label, …), the API, token refresh (daemon or CLI)           | `Lock.with("account-<id>")`. A refresh re-reads under the lock (AUTH-013).                                                                                                                      |
| `state.json`         | the daemon. The CLI only when no daemon runs (`redeem`, `status -r`, `use`) | The daemon holds `serve` for its life. The CLI writes only inside `Lock.tryWith("serve")`, re-reading the file first. If `serve` is held, a daemon is running and the CLI goes through the API. |
| `backups.json`       | the CLI (`setup`), the API (`agents/:id/connect`)                           | `Lock.with("backups")`                                                                                                                                                                          |
| `usage/*.ndjson`     | the daemon's ledger writer; the CLI's offline redeem (one append)           | append-only, `O_APPEND`                                                                                                                                                                         |

### 10.3 How changes spread

- In the daemon, `SettingsService` holds a `SubscriptionRef<Settings>`. Every
  reader calls `get` at use: each request, each task run, each WebSocket
  handshake. No component caches a setting, except `Planner`, which is
  cleared on `changes`.
- An API change writes the file and sets the ref at once. A CLI change or a
  hand edit is seen by the watcher within about 100 ms, and the CLI also calls
  `/sync`.
- `Accounts` keeps its cache current the same way and publishes `changes`.
  `Pool`, `Planner` and the status publisher follow it.

---

## 11. Settings

`config.json` is decoded by `Settings` (§3.6): every missing key takes its
default, and unknown keys are errors. On first run it is created with an
`apiKey` and `"$schema": "./config.schema.json"`, and `config.schema.json` is
written beside it from `Schema.toJsonSchemaDocument(Settings)`. The JSON
Schema carries each field's description, which replaces the TOML template's
comments. Editors then complete and validate the file.

The `live` annotation is the single source for what may change at run time.
It drives:

- `PATCH /settings`, whose payload is `LivePatch`;
- `slopmax config [name] [value]`, which lists the live table, shows a value,
  or parses and sets one (`on`/`off`, minutes, strategy names);
- the UI's switches and steppers, rendered from `SettingsView.live`.

A test walks `Settings`' AST, collects the fields annotated `live`, and checks
they are exactly `LiveSettings`' fields. Another checks every field has a
description. `listen` and `upstreamProxy` need a restart, and `doctor` and
`SettingsView.restartNeeded` say so when the file differs from the running
value.

Delivers: CFG-001..035 (comment preservation becomes the JSON Schema, §18).

---

## 12. The CLI (`apps/cli`, `effect/cli`)

```
slopmax                          status, or the guided setup on a TTY with no accounts (CLI-009)
  setup [agent] [--undo] [-y|--yes] [--import <s,…>] [--login <p,…>] [--keys-from-env]
        [--strategy <s>] [--affinity on|off] [--agents <a,…>] [--no-service]       alias init
  status [-r|--refresh] [-w|--watch] [--json]                                       alias ls
  login <provider> [--device] [--no-browser] [--label <l>] [--url <u> --dialect <d> --models <m,…>]
  import [all|claude-code|codex|cliproxyapi] [--own]
  own <account|all> · use <account|auto> · label <account> [label] · priority <account> <n>
  enable <account> · disable <account> · remove <account> · redeem <account> [reset] [-y]
  serve [--log <file>] · start [--json] · stop
  service install|uninstall|status [--json]
  run <agent> [args…]            spawns the agent with inherited stdio, forwards signals, exits with its code
  env <agent>
  config [name] [value]          the live table (§11)
  usage [today|7d|30d|all] [-b|--by day|model|account] [--json]
  key list|add|remove [name] [--models <m,…>]
  logs [-f|--follow] [-n|--lines <n>]
  notify · dashboard [--print] · doctor [--json]
  --completions bash|zsh|fish · --version · --help                                  (effect/cli's own)
```

```
apps/cli/src/
  main.ts       BunRuntime.runMain(cli) with BunServices, CoreLive, Logger; exit codes (CLI-003/004)
  cli.ts        the command tree
  commands/     accounts.ts, setup.ts, status.ts, usage.ts, background.ts, keys.ts, config.ts, run.ts, logs.ts, misc.ts
  terminal.ts   one stdin reader → Queue<string>, shared by prompts and sign-in pastes (CLI-190/199); secrets in raw mode
  print.ts      ANSI only on a TTY without NO_COLOR, visible-width padding by Unicode scalar, tables, bars (CLI-200..203)
  embedded.ts   generated by build.ts: the web UI's files → Assets layer
  build.ts      UI build, embed, bun compile (AOT and the --no-aot fallback), bytecode-order profiles, budget
```

- Choices come from the registries: `Flag.choice` over `providerOrder` and
  the agent ids (CLI-061). `<account>` goes through `Accounts.find`, whose
  errors become `CliFailure` messages (CLI-065).
- **One implementation per action.** Commands that change files (`login`,
  `import`, `label`, `priority`, `enable`, `disable`, `remove`, `own`, `key`,
  `config`, `setup`) call the core service in process, then
  `client.system.sync()` when a daemon runs. Commands on daemon state (`use`,
  `redeem`, `status -r`) call the API when a daemon runs. Otherwise they call
  the same core methods in process inside `Lock.tryWith("serve")`. `status`
  reads the live report from the daemon, else builds the offline report
  (REP-006).
- Prompts are `Prompt.Confirm`, `Select`, `MultiSelect`, `Text` and
  `Password`. Piped stdin is read to EOF for secrets (CLI-197). While a
  sign-in waits, terminal lines feed its `pasted` stream.
- `status --watch` follows `Event.Status` when a daemon runs, else rebuilds
  offline every 5 s. `logs -f` polls the size every 500 ms and reopens on
  truncation.
- `start --json` prints `{ url, dashboard, version, log }`. `status --json`
  and `doctor --json` print the domain shapes, which Electron main decodes
  (§13).
- Output layout is ours (tables per provider, bars, a pool row). Numbers and
  times go through `domain/format`.

Delivers: CLI-001..009, CLI-040..217, CLI-230/231, AGT-016..018, AGT-028..031, AGT-039.

---

## 13. The desktop (`apps/desktop`)

### 13.1 Processes, and why there is no app-host

```
renderer (@slopmax/ui desktop build, app://slopmax/)
   │  fetch /slopmax/api/* (same origin)            window.slopmaxDesktop (preload bridge)
   ▼                                                  ▼
Electron main (Node 24): protocol handler, window, panel, tray, menus, notifications, prefs
   │  HTTP + SSE to the daemon (key added here)       execFile the bundled CLI (start, stop, status --json, doctor --json, service …)
   ▼
slopmax serve (Bun binary): the daemon, or the login service
```

The sketch's `slopmax app-host` child and its stdio Rpc group are **removed**.
The daemon is the desktop's engine. Its `SlopmaxApi` and event stream give the
renderer everything the app-host would have, through the same contract the
web dashboard uses. That drops one Bun process (about 40 MB PSS), one
protocol and one view-model copy. The engine still never runs on Node: main
holds only `effect` (Schema decoding, `HttpApiClient`, `FetchHttpClient`) and
`@effect/platform-node`'s `ChildProcessSpawner` for running the CLI.

The renderer-to-main bridge is not an engine protocol. It is a small preload
API (`domain/desktop.ts`), and main decodes every argument with its Schema.
This replaces the CONVENTIONS row "App ⇄ engine: `effect/rpc`" (DECISIONS.md).

### 13.2 Main (`apps/desktop/src/main/`)

```
main/
  main.ts       lifecycle: single-instance lock; app.disableHardwareAcceleration(); NetworkServiceInProcess2;
                window-all-closed does not quit; activate reopens (DESK-001)
  engine.ts     finds the CLI: resources/bin/slopmax, else beside the executable, else PATH (APP-014);
                start --json at launch (APP-013); version check; stop/start; service actions (APP-036/037)
  protocol.ts   app:// handler: static files from the desktop build; /slopmax/api/* forwarded with net.fetch
                to the daemon with the key (streaming bodies pass through); 503 NotRunning when it is down
  window.ts     BrowserWindow 1160×800 (min 880×560), hiddenInset on macOS, contextIsolation, sandbox,
                navigation pinned to app://slopmax, external links → shell.openExternal;
                destroyed on close (about 100 MB less), rebuilt on reopen
  tray.ts       macOS: template icon, title = format.menuBar(report); click toggles the panel
                Windows: tray.svg icon; click toggles the panel
                Linux: tray.svg icon with a native context menu (pool lines, Open, Start/Stop proxy, Quit),
                because AppIndicator trays send no click events
  panel.ts      frameless 340-wide window at app://slopmax/#/panel, made on demand, placed from tray.getBounds(),
                sized to content, hidden on Escape, on blur after a 150 ms guard, and when the main window focuses
                (DESK-105..114)
  events.ts     one HttpApiClient SSE subscription, reconnecting on Schedule.exponential("1 second") capped at 15 s:
                Status → tray title/tooltip; Notice → Electron Notification, replacing an earlier one with the
                same key (DESK-120..122, APP-064/065), when prefs.notifications is on
  menus.ts      Menu template with role items and DESK-003's accelerators (Cmd on macOS, Ctrl elsewhere)
  prefs.ts      userData/prefs.json: window size, sidebar width, appearance, notifications (DESK-150);
                decoded with Schema, defaults on any error
  bridge.ts     ipcMain handlers for the preload API, arguments decoded with domain/desktop schemas
preload.ts      contextBridge.exposeInMainWorld("slopmaxDesktop", bridge) (CJS, sandboxed)
build.ts        Bun.build for main (ESM, node) and preload (CJS); copies apps/ui/dist/desktop
package.ts      @electron/packager: asar, en-US only, the CLI in resources/bin, no Vulkan/SwiftShader
```

The `app://` scheme is registered as privileged (`standard`, `secure`,
`supportFetchAPI`, `stream`). The protocol handler sets the CSP on every page.
The key never enters the renderer.

### 13.3 The bridge, and state to the renderer

```ts
// domain/desktop.ts
export const ProxyState = Schema.TaggedUnion({
  Checking: {},
  Starting: {},
  Running: { version: Schema.String },
  Stopped: {},
  OtherVersion: { running: Schema.String, bundled: Schema.String, service: Schema.Boolean },
}) // APP-003, extended with the version check
export class DesktopPrefs extends Schema.Class<DesktopPrefs>("DesktopPrefs")({
  /* sidebar, appearance, notifications, bounds */
}) {}
export class ShellResult extends Schema.Class<ShellResult>("ShellResult")({
  ok: Schema.Boolean,
  message: Schema.String,
}) {}
export interface DesktopBridge {
  readonly proxyState: () => Promise<typeof ProxyState.Encoded>
  readonly onProxyState: (f: (s: typeof ProxyState.Encoded) => void) => () => void
  readonly offline: () => Promise<{
    readonly report: typeof Report.Encoded
    readonly doctor: ReadonlyArray<typeof Section.Encoded>
  }>
  readonly proxy: (action: "start" | "stop" | "restart") => Promise<typeof ShellResult.Encoded>
  readonly service: (action: "install" | "uninstall" | "status") => Promise<typeof ShellResult.Encoded>
  readonly openExternal: (url: string) => void // sign-in URLs, the web dashboard (APP-045)
  readonly prefs: {
    readonly get: () => Promise<typeof DesktopPrefs.Encoded>
    readonly set: (p: typeof DesktopPrefs.Encoded) => Promise<void>
  }
  readonly panelHeight: (px: number) => void
  readonly onMenu: (f: (action: MenuAction) => void) => () => void
  readonly openWindow: (page: string) => void
  readonly quit: () => void
}
```

- **Running.** The renderer's state comes from the same `AtomHttpApi` atoms as
  the web dashboard: the `report` atom from `Event.Status`, mutations through
  the API, and sign-in through `logins` plus `Event.Login`. Nothing is polled.
- **Stopped (offline mode).** When the daemon is down, main runs
  `slopmax status --json` and `slopmax doctor --json` and the bridge's
  `offline()` returns both. The renderer shows the offline report, the doctor
  and a Start button (APP-015). Account and setting changes, sign-in and usage
  history need the proxy running, and say so with a Start button (§18).
- **Another version.** At launch and on every reconnect, main compares
  `/healthz`'s version with the bundled CLI's `--version`. If they differ and
  no login service runs the daemon, main runs `stop` and then `start`. If a
  login service runs it, `ProxyState.OtherVersion` shows DOC-004's finding with
  a Restart button (`service install` re-points the unit at the bundled CLI).
  The window never talks to an API of another version without saying so.

Delivers: DESK-001..012, DESK-105..122, DESK-150, DESK-165..170,
APP-010..022, APP-036/037, APP-045/046, APP-060..065 (posting).

---

## 14. Dependencies

Versions were checked on npm on 2026-10-31. Each package records its reasons in
its `package.json` `"//"` field.

| Package                                                                              | Version             | Where              | Why                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`                                                                             | 4.1.1               | all                | The platform. 4.1.1 is out; C0 moves every workspace from 4.1.0 in one step.                                                                                                             |
| `@effect/platform-bun`                                                               | 4.1.1               | core, cli, bench   | `BunServices`: FileSystem, Path, ChildProcessSpawner, Stdio, Terminal, runtime                                                                                                           |
| `@effect/platform-node`                                                              | 4.1.1               | desktop (main)     | `ChildProcessSpawner` on Electron's Node, to run the bundled CLI                                                                                                                         |
| `@effect/atom-react`                                                                 | 4.1.1               | ui                 | React hooks for `effect/reactivity` atoms (`AtomHttpApi`)                                                                                                                                |
| `ws`                                                                                 | 8.22.0              | core               | The upstream Codex socket. Under Bun, `ws` is Bun's built-in implementation: it shows the 101's headers and takes `proxy` and `tls` (probed). Bun's `WebSocket` hides the 101's headers. |
| `@decimalturn/toml-patch`                                                            | 3.3.1               | core (Codex agent) | Edits Codex's `config.toml` keeping comments and layout (setup then undo gives the original bytes). Effect's `Toml` only parses. No `eval`.                                              |
| `react`, `react-dom`                                                                 | 19.3.1              | ui                 | The UI                                                                                                                                                                                   |
| `tailwindcss`, `@tailwindcss/node`, `@tailwindcss/oxide`                             | 4.3.3               | ui (dev)           | Styling, compiled by the 20-line Bun plugin (not `bun-plugin-tailwind`, which vendors 4.1.14)                                                                                            |
| `@base-ui/react`                                                                     | 1.9.0               | ui                 | shadcn/ui's primitives (STYLING.md)                                                                                                                                                      |
| `class-variance-authority`, `tailwind-merge`, `clsx`                                 | 0.7.1, 3.7.0, 2.1.1 | ui                 | shadcn's `cva` and `cn`                                                                                                                                                                  |
| `lucide-react`                                                                       | 1.65.0              | ui                 | The icon set (DESK-014)                                                                                                                                                                  |
| `@fontsource/ibm-plex-sans`                                                          | 5.3.0               | ui                 | DESK-125's fonts, OFL                                                                                                                                                                    |
| `electron`                                                                           | 45.2.1              | desktop (dev)      | The shell                                                                                                                                                                                |
| `@electron/packager`                                                                 | 20.3.0              | desktop (dev)      | Packaging (RUNTIME.md)                                                                                                                                                                   |
| `@types/react`, `@types/react-dom`                                                   | 19.3.0              | ui (dev)           | Types                                                                                                                                                                                    |
| `@types/ws`                                                                          | 8.18.2              | core (dev)         | Types                                                                                                                                                                                    |
| `@shadcn/lint`, `eslint-plugin-better-tailwindcss`                                   | 0.2.3, 4.10.0       | root (dev)         | STYLING.md's lint rules under oxlint                                                                                                                                                     |
| `happy-dom`, `@happy-dom/global-registrator`                                         | 21.0.4              | ui (dev)           | Component tests under `bun test`                                                                                                                                                         |
| `fast-check`                                                                         | 4.10.2              | wire, core (dev)   | Property tests: scanner splices, transcoders under random chunk splits, relay settle-once                                                                                                |
| `playwright-core`                                                                    | 1.64.1              | desktop (dev)      | The `_electron` smoke test under Xvfb. No browser download.                                                                                                                              |
| kept: `@effect/tsgo` 0.63.0, `oxlint` 1.90.0, `typescript` 7.0.2, `@types/bun` 1.4.4 |                     | root (dev)         | DECISIONS.md                                                                                                                                                                             |

The CLI binary's third-party runtime packages are `effect`,
`@effect/platform-bun` (with `@effect/platform-node-shared`), `ws` and
`@decimalturn/toml-patch`.

Deliberately not added: zod and ajv (they generate code; Schema does the job),
undici (Bun's `fetch`), a SOCKS library (the 60-line bridge), a chart library,
a TOML library for our own settings (JSON), a streaming JSON parser (`wire/scan`
is about 150 lines over bytes), SQLite, date-fns, commander, OTLP or
Prometheus exporters, Effect DevTools, the Schema AOT compiler, and Scalar.

---

## 15. Testing

**Helpers.**

- `@slopmax/test`: `it.effect` (with `TestClock` and `TestConsole`, scoped),
  `it.live`, `it.layer`. It also has `MemoryFileSystem.layer`, a
  `FileSystem.makeNoop` base with a `Map` of files: modes, `open({ flag: "wx" })`,
  `rename`, `O_APPEND` and `watch` events. And `TestHome.layer`, a scoped real
  temporary home for the few tests that need a real file system (locks across
  processes, `watch`, modes).
- `core/test/support/memory-upstream.ts`: `Upstream.layerHandler` with a small
  router
  (`on("POST /v1/messages", byBearer({ "tok-ok": sse(…), "tok-limited": status(429, …) }))`).
  It records every request and answers in process with no sockets. HAR-005..009's
  scripted providers are named fixtures here.
- `core/test/support/mock-provider.ts`: the same scripts on a real
  `Bun.serve` on port 0, plus the WebSocket script. Requests to `/` are
  answered 404 and not recorded (HAR-001, FS-016..018).
- `core/test/support/harness.ts`: the real daemon layer without schedules.
  `Harness.memory` calls `Server`'s `fetch` directly with a `Request`.
  `Harness.ports` runs on `127.0.0.1:0` against the mock provider. Both use
  `Settings.layerValue({ apiKey: "sm-test-key", strategy: "fill-first", refreshTokens: false })`
  (HAR-002), `Upstream.layerOrigins` (HAR-003) and the accounts of HAR-004
  (`fixtures.ts`). Clients: `harness.claude(body, headers?)`, `harness.codex(…)`,
  `harness.chat(…)`, `harness.socket(…)`, and a typed `harness.api`
  (`HttpApiClient`).
- `CliSandbox` (`apps/cli/test/sandbox.ts`): runs the CLI (the compiled binary
  in CI) with a cleared environment: temp `HOME`, `SLOPMAX_HOME`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`,
  `SLOPMAX_LISTEN=127.0.0.1:<free>`, a dead `HTTPS_PROXY`,
  `SLOPMAX_NO_SERVICE=1`, and stub `claude`, `codex`, `systemctl` and
  `security` on `PATH`. It runs `slopmax stop` on close (CLI-230/231).

**Levels.**

| Level     | How                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure      | wire (scan, taps, opening, formats, transcoders, retell), router, pool model, window math, pricing, ledger views, notify watch and nudges, report, verdicts and header shaping, agent text edits, classify, the UI's view model. Plain `test` over values. Times come from arguments and zones from a `DateTime.CurrentTimeZone` layer. Property tests with `fast-check` for splices and chunk splits. |
| Services  | `MemoryFileSystem`, `Lock.layerMemory`, `Settings.layerValue`, `Upstream.layerHandler`, `Pool.layerMemory`, a recording `ChildProcessSpawner` for systemctl, launchctl, security and the notify command                                                                                                                                                                                                |
| Time      | `TestClock` for token expiry, schedules, the 3 s held start, the 400 ms retry, block and throttle expiry, the stall sweeper, the 15 s ping, sign-in timeouts and the 250 ms status debounce                                                                                                                                                                                                            |
| Races     | the refresh race: two callers give one token POST; interrupting a caller mid-refresh still saves; another process's rotation (a second `Accounts` over the same `TestHome`) is seen. `Lock` across two processes, including a SIGKILLed holder and a reused pid. The relay settles exactly once when the stream ends, errors, the client cancels at random offsets, or it stalls.                      |
| Proxy e2e | all 47 scenarios of `tests/proxy.rs` and `tests/failover.rs` on `Harness.memory`. The WebSocket scenarios, three real-port smoke tests, and the frame-size round trips (plain, through a CONNECT proxy, and `wss` through it) on `Harness.ports`.                                                                                                                                                      |
| API       | `harness.api` for every `SlopmaxApi` endpoint and the hub with a T3 Code-shaped client. A test checks the API and the proxy share one `Pool`.                                                                                                                                                                                                                                                          |
| CLI       | `CliSandbox`: setup and undo restoring files byte for byte, import, keys, usage totals, start and stop, serve until stopped, every typical invocation parses                                                                                                                                                                                                                                           |
| UI        | view-model tests under `bun test`, component tests under happy-dom, and the live-setting table rendered from `SettingsView`                                                                                                                                                                                                                                                                            |
| Desktop   | one packaged-app smoke test under Xvfb with `playwright-core`'s `_electron`: against a demo daemon the window shows the running report; stopping it shows the offline report; an injected `Notice` requests a notification                                                                                                                                                                             |

Safety: no test binds or connects to 8317. The doctor's CLIProxyAPI probe port
is a parameter. Nothing reads `~/.slopmax`, because every layer takes its root
from the test.

**The 502 Rust tests.** `docs/parity/test-map.tsv` maps each one to a TS file
and test title, or to the reason it does not apply.
`tools/test/map-check.ts` fails CI when a mapped title does not exist or a row
has neither a test nor a reason. Tests are named for behavior in plain English
(CONVENTIONS), not with the Rust names. Expected coverage: the 47 proxy and
failover tests on the harness; wire (45) as pure tests; providers, auth, pool,
route, limits, usage, report, ledger, pricing, waste, notify, doctor,
background and service (about 300) beside their modules; common (17) through
`format` and `DateTime` round trips (nanosecond cases n/a); net (14) through
`upstream.test.ts` and `socks.test.ts`, with the frame and accept-key tests n/a
(Bun and `ws` frame the sockets; the relay round trips cover the behavior);
config TOML (9) replaced by `config.json` tests; `args.rs` (6) n/a; CLI
integration (28) on `CliSandbox`; app (39) through view tests, the daemon's told
state and API e2e; desktop (10) through view and prefs tests (GPUI process
tests n/a).

---

## 16. Performance budgets and CI gates

`tools/bench` reproduces DIST-012 (CLI-220..225's mock provider and bodies,
`oha`) and DIST-013's demo home. `bun tools/bench gates` fails CI past these
limits on Linux:

| Metric                                    | Budget                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| AOT binary size (`bun compile --trim`)    | ≤ 70 MiB, ≤ 26 MB as xz                                                                      |
| `--version`                               | ≤ 30 ms                                                                                      |
| `serve` to the first `/healthz` 200       | ≤ 60 ms                                                                                      |
| daemon idle RSS                           | ≤ 45 MB                                                                                      |
| daemon peak RSS, 32 concurrent × 300 KB   | ≤ 120 MB                                                                                     |
| small requests, 32 concurrent             | ≥ 70% of the raw probe on the same host (measured 72–89%; the full Effect HTTP stack is 35%) |
| 300 KB requests, 32 concurrent            | ≥ 80% of the raw probe on the same host (measured about 89%; the full stack is 49%)          |
| small requests, 1 at a time, p50 over raw | ≤ 0.15 ms                                                                                    |

The raw probe is `tools/bench/raw.ts` (`Bun.serve` + `fetch` + a byte tap, no
Effect), built with the same flags and run in the same job. Each figure is
the median of three runs, because throughput on a shared host varies by about
15%. The flags are RUNTIME.md's (`--bytecode`,
`--bytecode-order` profiles from `--version`, `status --json` and `serve`,
`--compile-jit-policy=4` reset to 1 after listen, `--no-compile-autoload-*`).
CI builds both the AOT binary and the `--no-aot --minify --bytecode` fallback
and runs the CLI tests on both. `bun compile --explain` runs on every build.

If a gate fails, the fix stays inside the seams of §1.3 (the relay, `send`,
the front door). Decisions never move out of Effect.

---

## 17. Build plan

Each chunk is for one agent and owns its files outright. A chunk is done when
its tests pass, `bun check -b` and oxlint are clean, its `test-map.tsv` rows
are filled in, and its parity IDs have `path:line` evidence. A chunk may start
against the interfaces in this document with test layers before the chunks it
depends on land, but it merges only after them.

| Key | Chunk                                | Owns                                                                                                                                                                                                                                                                                                       | Depends on                                                                         | Delivers (parity prefixes)                                                                                                                                                                                                      |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0  | Foundations                          | `ts/package.json`, `ts/tsconfig*.json`, `ts/.oxlintrc.json` (import boundaries, hot-path bans), `ts/mise.toml`, `ts/bunfig.toml`, every `package.json` version bump to effect 4.1.1, `tools/test/**` (`it`, `MemoryFileSystem`, `TestHome`, `map-check.ts`), `docs/parity/NOT-PORTED.md` (seeded from §18) | —                                                                                  | FS-015, DIST-005 (mise tasks)                                                                                                                                                                                                   |
| C1  | Domain and contract                  | `packages/domain/**`                                                                                                                                                                                                                                                                                       | C0                                                                                 | COM-001..021, CFG-001..016, CFG-030..032, LIM-001..018, REP-001, REP-007..013, LED-002, LED-050, NOTE-002/003, DOC-001, PROV-001..004 (facts), AGT-001 (facts), APP-064/065 (words), ADM-001..021 (the `SlopmaxApi` definition) |
| C2  | Wire bytes                           | `packages/wire/src/{scan,lines,tap,observe,opening,errors}.ts`, their tests                                                                                                                                                                                                                                | C1                                                                                 | WIRE-001..009, WIRE-013, WIRE-015, PRX-080..083, PRX-098..101                                                                                                                                                                   |
| C3  | Wire translation                     | `packages/wire/src/{common,format,messages,responses,chat,transcode,collect,compaction,replay,index}.ts`, their tests                                                                                                                                                                                      | C2                                                                                 | WIRE-010..012, WIRE-014, WIRE-020..065, PRX-086..089                                                                                                                                                                            |
| C4  | Engine storage and outbound          | `core/src/{home,lock,log,settings,accounts,upstream,socks}.ts`, plus stubs of `refresh.ts` (never refreshes) and `dial.ts` (always `Unreachable`) that C5 and C10 take over, their tests                                                                                                                   | C1                                                                                 | FS-001..014, CFG-017..029, CFG-033..035, ACC-001..024, NET-001..012, COM-011, PRX-018/019, PRX-102                                                                                                                              |
| C5  | Providers and sign-in                | `core/src/providers/**`, `core/src/{refresh,importers,browser}.ts`, their tests                                                                                                                                                                                                                            | C2, C4                                                                             | PROV-005..073, AUTH-001..035, IMP-001..012, LIM-019..026, CLI-212, CLI-217                                                                                                                                                      |
| C6  | Agents, service, background, doctor  | `core/src/agents/**`, `core/src/{service,background,doctor,port-holder}.ts`, their tests                                                                                                                                                                                                                   | C4 (C5 for import hooks and account checks)                                        | AGT-002..039, SVC-001..010, BG-001..013, DOC-002..018, NET-031                                                                                                                                                                  |
| C7  | Pool, router, quota, report, pricing | `core/src/{pool,router,quota,report,pricing}.ts`, their tests                                                                                                                                                                                                                                              | C5                                                                                 | POOL-001..037, ROUTE-001..010, REP-002..006, LED-040..046, PRX-017, PRX-021, PRX-041, PRX-072, PRX-095/096, DMN-014..017, DMN-021/022                                                                                           |
| C8  | Ledger, events, notifier             | `core/src/{ledger,ledger-views,events,notifier}.ts`, their tests                                                                                                                                                                                                                                           | C4                                                                                 | LED-001..039, LED-047..053, NOTE-001, NOTE-004..015, DMN-018/019, APP-060..063                                                                                                                                                  |
| C9  | The HTTP proxy                       | `core/src/proxy/{classify,auth,inbound,planner,forward,attempt,hold,relay,settle,live,models,count-tokens,replies}.ts`, `core/src/server.ts` (with `Relay` and `WebApp` slots: sockets get 426 and web paths 404 until C10 and C11 provide them), `core/test/support/memory-upstream.ts`, proxy unit tests | C3, C7, C8                                                                         | PRX-001..016, PRX-020, PRX-022..040, PRX-042..071, PRX-073, PRX-084..085, PRX-090/091, NET-010, NET-030                                                                                                                         |
| C10 | The Codex WebSocket relay            | `core/src/proxy/socket.ts`, `core/src/dial.ts`, relay tests                                                                                                                                                                                                                                                | C9                                                                                 | WS-001..017, NET-011, NET-040..042                                                                                                                                                                                              |
| C11 | API, hub, assets, daemon             | `core/src/api/**`, `core/src/daemon.ts`, `core/src/index.ts` (`CoreLive`, `Daemon`), their tests                                                                                                                                                                                                           | C6, C9 (C10 to wire the relay)                                                     | ADM-001..021, HUB-001..012, DMN-001..013, DMN-020, PRX-024, NET-020 (declared, §18)                                                                                                                                             |
| C12 | End-to-end harness and scenarios     | `core/test/support/{harness,mock-provider,fixtures,clients}.ts`, `core/test/e2e/**`                                                                                                                                                                                                                        | C9 to start; C10, C11 to finish                                                    | HAR-001..010, FS-016..019, the proxy and failover rows of `test-map.tsv`                                                                                                                                                        |
| C13 | CLI                                  | `apps/cli/**` (commands, terminal, print, setup wizard, `build.ts`, AOT and fallback builds, `embedded.ts` generation, `CliSandbox` and tests)                                                                                                                                                             | C11 (C6)                                                                           | CLI-001..217, CLI-230/231, AGT-016..018 and AGT-028..031 (as commands), DIST-004 (Bun budget)                                                                                                                                   |
| C14 | UI                                   | `apps/ui/**`                                                                                                                                                                                                                                                                                               | C1 (against a stub API built with `HttpApiBuilder` and fixtures); C11 to integrate | ADM-030..053, APP-001..009, APP-030..047 (UI flows), APP-070..105, DESK-013..101, DESK-125..145, DESK-155                                                                                                                       |
| C15 | Desktop                              | `apps/desktop/**`, `.github/workflows/ts-desktop.yml`                                                                                                                                                                                                                                                      | C13, C14                                                                           | DESK-001..012, DESK-105..122, DESK-150, DESK-160, DESK-165..170, APP-010..022, APP-036/037, APP-045/046                                                                                                                         |
| C16 | Bench, gates, distribution           | `tools/bench/**`, `.github/workflows/ts-{ci,release}.yml`, `ts/install.sh`, `ts/Dockerfile` (musl), release notes wiring                                                                                                                                                                                   | C9 (the mock and bodies can start after C1), C13                                   | CLI-220..225, DIST-001..016                                                                                                                                                                                                     |

Waves:

1. C0, then C1.
2. In parallel: C2, C4, C14 (the UI against a stub API), and C16's mock and
   bodies.
3. C3 (after C2), C5 (after C2 and C4), C6 (after C4), C8 (after C4).
4. C7 (after C5).
5. C9 (after C3, C7, C8). C12's mock provider and fixtures start alongside.
6. C10 and C11.
7. C12's scenarios, and C13.
8. C15 and the rest of C16 (gates on the AOT binary, workflows, install,
   Docker).

Rules for every agent:

- Never bind or connect to 8317. Never read or write `~/.slopmax`. Use no real
  accounts.
- Record every dependency and why in `package.json`'s `"//"` field.
- Keep `docs/parity/NOT-PORTED.md` current. An undeclared omission is a fail.
- A chunk that needs a change to a file another chunk owns asks for it. It
  does not edit the file.

---

## 18. Not ported, or changed on purpose

C0 seeds `docs/parity/NOT-PORTED.md` with these. Each one names the IDs it
touches.

- **CLI parser texts** (CLI-011..038): `effect/cli`'s help, errors, exit
  codes and completions replace the Rust parser's exact bytes. The features
  remain: aliases, rest arguments, `--help` anywhere, completions for three
  shells, exit 2 on usage errors.
- **`config.toml`** (CFG-021..025, the template, comment-preserving edits):
  replaced by `config.json` with a generated JSON Schema carrying every
  description. Codex's TOML is still edited in place, keeping comments.
- **Form-encoded admin bodies** (ADM-021, NET-020): JSON bodies validated by
  Schema.
- **URL layout**: the admin API moves to `/slopmax/api/*`, the dashboard to
  `/slopmax/`, and Claude Code to `<base>/claude`.
- **`exec` in `run`** (CLI-082, CLI-215): Bun cannot replace its process.
  slopmax spawns the agent with inherited stdio, forwards SIGINT, SIGTERM and
  SIGHUP, and exits with its code or 128+n.
- **Locks** (FS-012): lock files with pid and process-start-time liveness, not
  `flock`. They do not interoperate with Rust processes, and no files are
  shared with the Rust slopmax.
- **WebSocket framing and the raw HTTP client** (NET-040..042, NET-011): Bun
  frames inbound sockets and `ws` frames upstream ones. The accept-key and
  frame unit tests are n/a. The relay's round trips cover the behavior.
- **Inference connect timeout** (PRX-025, NET-001): `fetch` has no separate
  connect timeout. A refused connection fails at once. A black-holed one is
  bounded by the OS and then by the 600 s header wait.
- **TLS roots** (NET-007): system roots plus Bun's bundled roots, so
  `no system CA certificates found` never happens.
- **Pins, nudged, windows files** (FS-004, `pins.json`, `nudged.json`,
  `windows.jsonl`): folded into `state.json` (pins, told) and the ledger
  (`WindowEnded` records).
- **Desktop told file and `desktop.json`** (APP-061/062, DESK-150): the told
  set is the daemon's (`state.json`). Window preferences live in Electron's
  `userData/prefs.json`. Notifications are posted on every platform Electron
  supports, not only macOS (DESK-122 widened).
- **Desktop with the proxy stopped** (APP-015..044): the window shows the
  offline report and the doctor. Sign-in, account and setting changes, and
  usage history need the proxy running. The app starts it at launch, and the
  terminal commands work offline.
- **Two daemons on one home**: refused (`AlreadyServing`), since both would
  write `state.json`.
- **The bench rig** (CLI-220..225): moved from the binary to `tools/bench`,
  with the same mock, bodies and runs.
- **Rust build and size features** (CLI-010 `mimalloc`, DIST-002..004):
  replaced by Bun's allocator and the budgets in §16.
- **GPUI specifics**: the screenshot mode (DESK-160) becomes a
  `webContents.capturePage()` script in `tools/bench`. Slide-animation math
  becomes CSS transitions that honor `prefers-reduced-motion`.
- **Time precision** (COM-001/002): `DateTime` is in milliseconds, so the
  nanosecond round trips are n/a.

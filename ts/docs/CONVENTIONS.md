# Conventions for the TypeScript port

The TypeScript port is slopmax rebuilt on Effect 4, one package per Rust crate.
It must match the Rust one-to-one in behavior (the contract is `docs/parity/`),
and it must stay small, fast, and plain. These rules apply to every package.

## Layout

```
ts/
  packages/
    common   @slopmax/common   time, ids, the logger, short formats for people   (slopmax-common)
    wire     @slopmax/wire     API formats and translation; no I/O                 (slopmax-wire)
    net      @slopmax/net      outbound HTTP (pooling, proxies, origins), WebSocket and form helpers (slopmax-net)
    core     @slopmax/core     the engine: accounts, sign-in, pool, proxy, daemon  (slopmax-core)
    app      @slopmax/app      the desktop app apart from any UI: state, actions, view (slopmax-app)
  apps/
    cli      slopmax           the CLI binary                                       (slopmax)
    desktop  slopmax-desktop   the Electron app                                     (slopmax-desktop-gpui)
```

Dependencies point one way, as in Rust: common under net and wire, those under
core, core under app and the front ends. The core re-exports what front ends
need, so `apps/*` import from `@slopmax/core` and `@slopmax/app` only.

Each package: `src/` (one module per Rust module, same names in kebab-case is
not needed — keep the Rust file names, e.g. `rawjson.ts`, `claude-code.ts`),
`test/` mirroring `src/`, an `index.ts` that is the public surface, and a
`package.json` with `"type": "module"` and an `exports` map pointing at the
TypeScript sources (the apps bundle them; nothing is published).

## Effect

Effect 4.1 (`effect`, plus `effect/http`, `effect/cli`, `effect/socket`,
`effect/process`; platform layers from `@effect/platform-bun`, and
`@effect/platform-node` only where Electron's Node runs our code).

## Toolchain

Bun (latest, pinned in `ts/mise.toml`) is the runtime and the toolchain:
`bun install` (workspaces), `bun build --compile` (the CLI binary),
`bun test`, `bun check` (types), `bun fmt`. Bun has no linter, so oxlint
lints. The details and measurements behind each choice are in `RUNTIME.md`.

The CLI ships compiled ahead of time (`bun compile --trim`, Bun canary), which
needs the whole program to type check and avoids code generated from strings.
Follow the rules in `AOT.md`.

- **Pure code stays pure.** Parsers, codecs, the planner, placement, pricing,
  formatting, rawjson scanning: plain synchronous functions over plain data.
  Do not wrap pure logic in `Effect` — it costs allocations on the hot path and
  says nothing. Effect is for I/O, time, concurrency, resources, and errors that
  cross an I/O boundary.
- **Services** are classes, keyed by their package path, with a `make` and a
  `layer`:

  ```ts
  export class Store extends Context.Service<
    Store,
    {
      readonly load: (id: AccountId) => Effect.Effect<Account, StoreError>
    }
  >()("@slopmax/core/Store", {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return {
        load: Effect.fn("Store.load")(function* (id) {
          /* … */
        }),
      }
    }),
  }) {
    static readonly layer = Layer.effect(Store, Store.make)
  }
  ```

  Only make something a service when it holds state or does I/O that tests
  need to replace. A module of functions is fine otherwise.

- **Named effects** use `Effect.fn("Module.name")(function* (...) { … })`, so
  spans and stack traces carry the name.
- **Errors** that cross module boundaries are `Schema.TaggedError` classes
  (or `Data.TaggedError` when they never serialize). Recover with
  `Effect.catchTag`. Never throw from Effect code; never use `any`.
- **Data on disk and on the wire** that slopmax owns (accounts, state.json,
  pins, ledger lines, windows.jsonl, admin API bodies) is described with
  `Schema` and decoded with it, so a malformed file is a typed error, not a
  crash. Upstream API bodies on the hot path are scanned, not decoded (see
  Performance).
- **Time** comes from `Clock` (`Clock.currentTimeMillis`, `DateTime.now`) so
  tests drive it with `TestClock`. Timestamps are epoch milliseconds (`number`)
  in data, `Duration` for spans.
- **Timers and background tasks** are `Effect.repeat`/`Schedule` fibers forked
  into the daemon's `Scope` (`Effect.forkScoped`), never `setInterval`.
- **Watched state** (the pool, the app's snapshot) is `SubscriptionRef`; a UI
  or the daemon subscribes with `SubscriptionRef.changes`.
- **Resources** (listeners, sockets, file locks, child processes) are acquired
  with `Effect.acquireRelease` inside a `Scope`.
- **Platform** is provided at the edge. `@slopmax/core` depends on `effect`
  only (FileSystem, Path, HttpClient, HttpServer, Socket, ChildProcess are
  abstract services). The CLI provides the Bun or Node layers; Electron's main
  process provides the Node layers. Node-only APIs (`node:crypto`, `node:os`,
  `node:net` for things Effect lacks) are allowed in core when both Bun and
  Node implement them; isolate each in one small module.
- **Config** for slopmax itself is the TOML file, not Effect `Config`; env vars
  that Rust reads (`SLOPMAX_HOME`, …) are read through `Config` so tests can
  set them with a `ConfigProvider`.

## Performance

The hot path rules from the Rust carry over:

- Request bodies are `Uint8Array`s, never parsed whole. `rawjson` scans for the
  few values slopmax reads and stops once it has them; edits splice bytes.
- The stream tap reads SSE events in place and parses only those that mention
  usage or an error.
- Responses stream through; nothing buffers a whole answer.
- Commands that only talk to the local proxy do not load TLS roots or open
  pools they do not need.
- No dependency without a measured reason (smaller, faster, or more correct
  than a small module). List each one with its reason in the package's
  `package.json` `"//"` field.

## Tests

- `bun test`, with the shared `it.effect`/`it.layer` helpers (see
  `RUNTIME.md`) for effectful tests, plain `it` for pure ones, `TestClock`
  for time.
- Every Rust test is ported. **The test title is the Rust test function's
  name, verbatim** (`it("refresh_waits_for_the_lock", …)`), so
  `docs/parity/rust-tests.tsv` maps one-to-one. A Rust test that cannot apply
  (it tests a Rust-only mechanism) is listed in the package's
  `test/NOT-PORTED.md` with the reason, and whatever behavior it guarded is
  covered by another test.
- Integration tests run the real proxy against a mock provider on a local port,
  as `slopmax-core/tests/proxy.rs` does.
- Temporary homes go under the OS temp dir and are removed after.

## Style

- TypeScript strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.
- Readonly data, discriminated unions with `_tag` for sum types.
- Comments: as sparse as the Rust's and in the same plain voice; carry over
  the Rust's comments where they explain _why_.
- Names follow the Rust (`plan`, `pick`, `Verdict`, `Dialect`), camelCased.

# @slopmax/core: port notes

The TypeScript port of `crates/slopmax-core`, the engine. Several chunks port
it in turn; this file is their shared map. Each chunk adds its rows to the
tables below and its notes under its own heading.

| Chunk | What                                                                                                                                                  | Status |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A     | paths, fsx, testkit, config (+ TOML editor), limits, account, usage, pricing, waste, ledger, provider/mod, provider/credits, agent/mod, auth, rawjson | done   |
| B     | the Claude, Codex, keys, and compat providers; the Claude Code and Codex agents; import                                                               | done   |
| C     | pool, route, notify, report, service, background, summary, history                                                                                    | done   |
| D1    | the proxy hot path and the daemon                                                                                                                     | done   |
| D2    | admin, hub, dashboard, doctor                                                                                                                         | done   |

## Layout

One TS module per Rust module, same name; a Rust `snake_case` file name
becomes `kebab-case` (`claude_code.rs` → `claude-code.ts`).

- **`foo/mod.rs` → `foo/mod.ts`.** The module's own code, exactly what the
  Rust `mod.rs` holds (`provider/mod.ts`, `agent/mod.ts`, `auth/mod.ts`,
  `provider/claude/mod.ts`).
- **`foo/index.ts`** is the directory's namespace: it re-exports `mod.ts`
  and the submodules, and the package's `src/index.ts` re-exports it
  (`export * as provider from "./provider/index.ts"`). Code inside the
  package imports the module it needs (`../provider/mod.ts`), never an
  `index.ts`, so no cycle runs through a barrel.
- **`foo/registry.ts`** is the one place that lists the implementations
  (`ProviderId::get`, `AGENTS` in the Rust). Implementations import only
  `mod.ts`; the registry imports the implementations. See "Registries".
- **Tests** mirror `src/`: `src/provider/mod.ts` → `test/provider/mod.test.ts`.
  Shared test helpers live in `test/support/` (`fakes.ts`: stand-in providers; `temp.ts`: temp dirs removed after the file), fixture files in
  `test/fixtures/`. A test's title is the Rust test's name, verbatim; tests
  the Rust lacks go in a second `describe("…, beyond the Rust tests")`.
- **`src/testkit.ts`** is the Rust's `#[cfg(test)] mod testkit`: tests
  import it by path; `index.ts` does not export it.

| Rust                                    | TypeScript                                               | Chunk | Notes                                                                                                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib.rs`                                | `src/index.ts`                                           | A     | Modules as namespaces (`import_` for `import`); `Account`, `Store`, `Tokens`, `Config`, `Failure`, `Home`, `ProviderId`, `PROVIDERS`, `VERSION`, `USER_AGENT` at the top.                                                                  |
| (anyhow)                                | `src/error.ts`                                           | A     | New. `Failure { message, cause? }`: `message` is `{e}`, `chain(e)` is `{e:#}`; `fail`, `context`.                                                                                                                                          |
| (serde)                                 | `src/serde.ts`                                           | A     | New. Schema pieces for serde's rules on files slopmax owns: `opt`, `list`, `record`, `withDefault`, `defaulted`, `omitWhen`, `F64` (writes `40.0`), `Count`, `U32`, `U16`, `JsonValue`; `byteOrder` (Rust's string order, a `BTreeMap`'s). |
| (`CARGO_PKG_VERSION`)                   | `src/version.ts`                                         | A     | New. `VERSION`, `USER_AGENT` (`slopmax/<version>`).                                                                                                                                                                                        |
| `paths.rs`                              | `src/paths.ts`                                           | A     | `Home` (a value: `Home.at(dir)`, `Home.current`); env vars read through `Config` at each call; `join` is `Path::join` (paths kept as written, unlike `node:path`).                                                                         |
| `fsx.rs`                                | `src/fsx.ts`                                             | A     | The one module that touches the disk (`node:fs/promises`, so off the event loop). `writePrivate`, `writeJson`, `readJson`, `readText`, `readLines`, `appendLines`, `privateDir`, `lock` (flock through `bun:ffi`, scoped), `IoError`.      |
| `testkit.rs`                            | `src/testkit.ts`                                         | A     | `tempDir`, `scopedTempDir`, `noEnv`, `Mock` (scoped), `Seen`, `reply`, `json`.                                                                                                                                                             |
| `config.rs`                             | `src/config.ts`                                          | A     | Also holds `[notify]`'s schema (`NotifySettingsSchema`, `NotifyKindSchema`) and `SocketAddr`; `notify.ts` (C) imports them from here.                                                                                                      |
| (toml_edit)                             | `src/toml.ts`                                            | A     | New. The format-preserving TOML editor (see "config.toml").                                                                                                                                                                                |
| `limits.rs`                             | `src/limits.ts`                                          | A     |                                                                                                                                                                                                                                            |
| `account.rs`                            | `src/account.ts`                                         | A     | Also `Pins`/`PinsSchema` (the Rust's `pool::Pins`); `pool.ts` (C) imports them from here.                                                                                                                                                  |
| `usage.rs`                              | `src/usage.ts`                                           | A     |                                                                                                                                                                                                                                            |
| `pricing.rs`                            | `src/pricing.ts`                                         | A     |                                                                                                                                                                                                                                            |
| `waste.rs`                              | `src/waste.ts`                                           | A     |                                                                                                                                                                                                                                            |
| `ledger.rs`                             | `src/ledger.ts`                                          | A     |                                                                                                                                                                                                                                            |
| `provider/mod.rs`                       | `src/provider/mod.ts`                                    | A     | `ProviderId`, `Spec`, `Credential`, `Billing`, `matches`, `Reading`, `UsageError`, `usageBody`, `Verdict`, `Provider`, `defineProvider`, `install`.                                                                                        |
| (`ProviderId::get`)                     | `src/provider/registry.ts`                               | A     | `PROVIDERS`, in `ProviderId.ALL` order; importing it installs them.                                                                                                                                                                        |
| `provider/credits.rs`                   | `src/provider/credits.ts`                                | A     | `Credit`, `Outcome`, `ResetCredits`, `defineResetCredits`.                                                                                                                                                                                 |
| `provider/claude/*.rs`                  | `src/provider/claude/{mod,oauth,limits,wire,credits}.ts` | B     | `index.ts` is the `provider.claude` namespace (`oauth`, `limits`, `wire`; `credits` stays private, as in Rust).                                                                                                                            |
| `provider/codex/*.rs`                   | `src/provider/codex/{mod,oauth,limits,wire,credits}.ts`  | B     | `index.ts` is the `provider.codex` namespace, the same way.                                                                                                                                                                                |
| `provider/keys.rs`                      | `src/provider/keys.ts`                                   | B     | `KeyHeader` is `"XApiKey" \| "Bearer"`.                                                                                                                                                                                                    |
| `provider/compat.rs`                    | `src/provider/compat.ts`                                 | B     |                                                                                                                                                                                                                                            |
| (none)                                  | `src/provider/pending.ts`                                | A     | Deleted by B.                                                                                                                                                                                                                              |
| `agent/mod.rs`                          | `src/agent/mod.ts`                                       | A     | `Agent`, `Command`, `session`, `servable`, `Wiring`, `wiring`, `run`, `setup`, `undo`, `resolve`, `shellQuote`.                                                                                                                            |
| (`AGENTS`, `find`, `detect`)            | `src/agent/registry.ts`                                  | A     |                                                                                                                                                                                                                                            |
| `agent/claude_code.rs`                  | `src/agent/claude-code.ts`                               | B     | `accountFrom` and `SavedLogin` exported for tests.                                                                                                                                                                                         |
| `agent/codex.rs`                        | `src/agent/codex.ts`                                     | B     | `overrides`, `argv`, `accountFrom` exported for tests.                                                                                                                                                                                     |
| `auth/mod.rs`                           | `src/auth/mod.ts`, `src/auth/connect.ts`                 | A     | `connect.ts` holds `connect`, `ensureFresh` (and `follow`, `refreshAndSave`): they go through `ProviderId.get` and `import.ts`, which import `auth/mod.ts`.                                                                                |
| `auth/callback.rs`                      | `src/auth/callback.ts`                                   | A     | Also `browserLogin` (in `auth/mod.rs` in the Rust; it only needs the callback).                                                                                                                                                            |
| `auth/jwt.rs`, `auth/pkce.rs`           | `src/auth/jwt.ts`, `src/auth/pkce.ts`                    | A     | `jwt.encodeUnsigned` is new, for tests.                                                                                                                                                                                                    |
| `import.rs`                             | `src/import.ts`                                          | B     | `Source` is the CLI name (`"all" \| "claude-code" \| "codex" \| "cliproxyapi"`); `fromCliproxyapi` exported for tests.                                                                                                                     |
| `proxy/rawjson.rs`                      | `src/proxy/rawjson.ts`                                   | A     | `Seg` is a key (`string`) or an index (`number`).                                                                                                                                                                                          |
| `proxy/mod.rs` (header rules)           | `src/proxy/headers.ts`                                   | A     | `isHopByHop`, `header`, `userAgent`, `forwardable`, `affinity`, `returnable`: apart from the proxy so providers and agents can use them. D1 tests them under `proxy/mod`.                                                                  |
| `proxy/mod.rs` (the rest), `proxy/*.rs` | `src/proxy/mod.ts`, `src/proxy/app.ts`, `src/proxy/*.ts` | D1/D2 | See "Chunk D1". `mod.ts` dispatches; `app.ts` holds `App` and what the handlers share, so they import it without a cycle.                                                                                                                  |
| `pool.rs`                               | `src/pool.ts`                                            | C     | `Inner` (the pool as a value) and pure functions over it; `Pool` holds it in a `SubscriptionRef` (methods are Effects); `LivePool` service; `place` exported.                                                                              |
| `route.rs`                              | `src/route.ts`                                           | C     | Pure; `plan` returns `Result<Steps, NoRoute>`.                                                                                                                                                                                             |
| `notify.rs`                             | `src/notify.ts`                                          | C     | `Settings`/`Kind` re-exported from `config.ts`; `wants` and `send(settings, http, event)` are functions; `Watcher` is a class (stateful, not data).                                                                                        |
| `report.rs`                             | `src/report.ts`                                          | C     | `Report.withNext(report, inner, now)` takes the pool's `Inner`; `offline` is an Effect over `Home.current`.                                                                                                                                |
| `service.rs`                            | `src/service.ts`                                         | C     | `Manager` is `"systemd" \| "launchd"`; `file`, `install`, `uninstall`, `status`, `start` take it.                                                                                                                                          |
| `background.rs`                         | `src/background.ts`                                      | C     | `Daemon.make(config)`; `ensureRunning`, `launch`, `stop`, `installService`, `spawn` (through `proc.detached`), `currentExe` (fails when run from source, where the program is Bun).                                                        |
| `summary.rs`                            | `src/summary.ts`                                         | C     | `Totals` is a mutable accumulator (`Totals.add` fills it in place, `Totals.count` with the price looked up once); `rows` is a `Map`; `Summary.json` writes it; `build` reads the ledger, `summarize` is the pure part.                     |
| `history.rs`                            | `src/history.ts`                                         | C     | `build` (pure) and `load`; `Range` values are the JSON names (`today`, `week`, `month`), `Range.key` the query keys.                                                                                                                       |
| (`Command::output`)                     | `src/proc.ts`                                            | C     | New. `output(program, args, {env})` and `detached(program, args, log)` (`node:child_process`), `ExitStatus.display` as Rust prints it; used by `service.ts`, `notify.ts`, `background.ts`.                                                 |
| `daemon.rs`, `doctor.rs`                | `src/daemon.ts`, `src/doctor.ts`                         | D1/D2 | `daemon.ts` is D1's (see "Chunk D1").                                                                                                                                                                                                      |

## The shapes later chunks build on

### Registries (no import cycles)

`account.ts` asks an account's provider for its identity, and providers make
accounts, so `provider/mod.ts` cannot import the implementations. Instead
`ProviderId.get(id)` reads a table that `provider/registry.ts` fills when it
is imported (`install(provider)`); the package's `index.ts` imports the
registry, so anything that goes through `@slopmax/core` has every provider.
Tests that import modules by path import `provider/registry.ts` (or
`test/support/fakes.ts`, which re-exports it). `ProviderId.get` throws if the
registry was never loaded: a defect, not a quiet wrong answer.

- **B**: replace each skeleton with the full module, keeping its export
  name (`Claude`, `Codex`, `ANTHROPIC`, `OPENAI`, `XAI`, `Compat`,
  `ClaudeCode`, `Codex`); build providers with `defineProvider(parts)` and
  credits with `defineResetCredits(parts)`, which supply the Rust trait's
  defaults. Implementations import `provider/mod.ts`, `auth/mod.ts`,
  `auth/callback.ts`, `proxy/headers.ts`, `proxy/rawjson.ts`, never
  `registry.ts` or `auth/connect.ts`. Then delete `provider/pending.ts` and
  switch the stand-in tests (see `test/NOT-PORTED.md`) to the real
  implementations.
- `agent/registry.ts` lists the agents the same way, but as a plain array:
  agents import `agent/mod.ts` only, and nothing in `agent/mod.ts` needs the
  list.

### Data

- Files slopmax owns are `Schema` structs in camelCase with
  `Schema.encodeKeys` to the Rust's snake_case names, built from
  `serde.ts`'s pieces so absent/`null`/empty read and write as serde does.
  Read them with `fsx.readJson(path, Schema)` and write them with
  `fsx.writeJson(path, Schema, value)` (pretty, final newline, atomic, 0600) or `fsx.appendLines` (JSON lines).
- Timestamps are epoch milliseconds (`Timestamp` from `@slopmax/common`),
  written as Rust writes them through `TimestampFromString`. Durations are
  `SignedDuration` (milliseconds). Time comes from `Clock`
  (`Timestamp.now`); functions the Rust gives `Timestamp::now()` inside take
  `now` as an argument (`Account.make`, `Limits.merge`).
- Rust structs with methods are a type plus a same-named object of functions
  (`Limits.score(limits, now)`, `Window.label(w)`); sum types are
  `_tag` unions with constructors (`Verdict.Exhausted(until, model)`).
  Data is immutable: Rust's `&mut self` methods return the new value
  (`Account.assignId`, `Limits.merge`), `Store.update(id, change)` takes a
  function that returns the changed account, and `Agent.setup` returns what
  it saved rather than filling an `&mut Option<Value>`.
- Header maps are the web's `Headers`. `proxy/headers.ts`'s `header` is
  `headers.get(name)?.to_str().ok()`; `limits.ts`'s `header` also trims, as
  `limits.rs`'s does. `Headers.get` joins repeated values with `", "` where
  `HeaderMap::get` returns the first; nothing in chunk A reads a repeated
  header.

### Errors

- `Failure` is anyhow's error. `context("…")` wraps an error the way
  `.context` does; `chain(e)` prints `{e:#}`. Messages are the Rust's,
  byte for byte (`texts.debug` from `@slopmax/common` is `{:?}`).
- `RefreshError = Revoked | Transient` and `UsageError = Unauthorized |
Failure` are tagged errors; recover with `Effect.catchTag`.
- One helper each, not one per module: `error.lift(e)` is `?` on another
  error (its message, as a `Failure`), `auth/mod.ts`'s `transient(e)` makes
  a `Transient`, `client.isSuccess(status)` from `@slopmax/net` is
  `StatusCode::is_success`, `json.trimAscii` from `@slopmax/wire` is
  `<[u8]>::trim_ascii`, and `num.round` / `num.totalCmp` from
  `@slopmax/common` are `f64::round` / `f64::total_cmp`.
- `fsx.IoError` carries the system's code and Rust's wording
  (`No such file or directory (os error 2)`).

### Services, I/O, and time

Nothing in chunk A is a `Context.Service`. The Rust passes its state
explicitly (`&Store`, `&Home`, `&Client`) and so does the port: tests
replace them by construction (`Store.at(tempDir)`, `Home.at(dir)`,
`mock.client([...])` from `testkit.ts`) and replace the environment with a
`ConfigProvider` (`SLOPMAX_HOME`, `SLOPMAX_LISTEN`, `CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, `DISPLAY`, … are all read through `Config`; `testkit.noEnv`
empties it). The HTTP client is `@slopmax/net`'s `Client`
(`auth.httpClient(origins)` makes the one OAuth and usage calls use). The
daemon (D1) is where state that lives across requests becomes services.

- Effectful functions are `Effect.fn("module.name")` (`Store.list`,
  `Config.set`, `auth.ensureFresh`, `fsx.writePrivate`, …), so traces name
  them; `Store`'s methods are `Effect.fn` fields with `this: Store`.
- Disk I/O is asynchronous (`node:fs/promises`, which Bun runs on its
  thread pool), as the Rust does it in `spawn_blocking`: saving an account
  or writing the ledger never stalls the requests in flight. It goes
  through `fsx.ts` rather than Effect's `FileSystem` service because the
  lock needs `flock` on the file's descriptor, which `FileSystem` does not
  offer, and because a `FileSystem` requirement on every account, config,
  and ledger call would reach every caller in every chunk for no behavior
  the tests need to swap (they use temp dirs).
- Files are read as bytes and decoded as the Rust reads them: a config or
  text file that is not UTF-8 is `stream did not contain valid UTF-8`
  (`read_to_string`); JSON files report serde_json's error for the bytes;
  the ledger and `windows.jsonl` read as `lines().map_while(Result::ok)`
  (`\r\n` endings, stopping at a line that is not UTF-8).

### config.toml

`toml.ts` is a small format-preserving editor for the TOML slopmax reads and
writes: `Document.parse(text)` keeps every comment, blank line, and value as
written; `doc.set(key, item)`, `doc.remove(key)`, `Table`, `ArrayOfTables`,
and `Value.of(data)` edit it; `doc.toString()` prints unchanged items as read
and new ones where and how toml_edit 0.25.15 prints them; `doc.data` is plain
data for `Schema` decoding (integers as `bigint`). `test/toml.test.ts`
compares it with what toml_edit itself prints for the same edits
(`test/fixtures/toml-golden.rs` writes `toml-golden.jsonl`; regenerating it
offline gives the same file). The goldens include the edits `slopmax setup
codex` makes to Codex's `config.toml` (`codex_setup_*`), for chunk B.

### Locks and token refresh

- `fsx.lock(path)` holds `flock(LOCK_EX)` on `path` for the scope's
  lifetime. It is the lock Rust's `File::lock` takes, so a Rust and a
  TypeScript slopmax sharing a home take turns (the test checks it against
  util-linux `flock`). It opens the file once and retries `LOCK_NB` on it
  every 10 ms instead of blocking, so the event loop never blocks; under
  `TestClock` a contended lock waits for the clock, so lock tests use
  `it.live`.
- The cost: loading libc with `bun:ffi`'s `dlopen` keeps
  `bun compile --trim` from dropping the Bun and Node APIs the program
  never calls (`--explain` points at `fsx.ts`), about 9 MB more binary (a hello world:
  27.4 MB to 36.5 MB, measured by a judge). Bun has no `flock` of its own,
  and a lock that is not `flock` would not exclude a Rust slopmax sharing
  the home, so the decision (DECISIONS.md) stands; `AOT.md` should record
  the cost.
- `ensureFresh` takes the account's lock, re-reads, and refreshes in a
  fiber forked with `Effect.forkDetach`, which the caller only joins: a
  caller that is interrupted (a client hanging up) leaves the refresh to
  finish and save the rotated single-use token, as the Rust's
  `tokio::spawn` does ("a refresh the caller abandons still saves the
  rotated token").

## Tests

|                                                                                      | Count                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------- |
| Rust tests in chunk A's files                                                        | 88                                      |
| Ported with the Rust name                                                            | 88                                      |
| Added for contract clauses (incl. 10 TOML editor tests against toml_edit)            | 44                                      |
| Passing (`bun test` on chunk A's test files and `toml`, `serde`, `paths`; Bun 1.4.4) | 133 of 133 (with B's `swapRemove` test) |

`test/NOT-PORTED.md` lists none left out, the tests that stand on stand-ins
until chunk B, and the behavior left out on purpose.

## Deviations from the Rust

- `agent.run` spawns the agent and forwards signals instead of `exec`
  (DECISIONS.md; AGT-008 in `test/NOT-PORTED.md`).
- `fsx.lock` polls a non-blocking `flock` (above). The Rust blocks a thread.
- `Ledger.start` is scoped: its writer fiber stops when the daemon's scope
  closes, where Rust's task runs until the process ends.
- `Prompt`'s pasted lines are an Effect `Queue` (`Queue.end` says nothing
  more will come) in place of a tokio receiver.
- `agent.run`, interrupted (say, by `runMain` on a Ctrl-C), waits for the
  agent to exit before it ends, so the agent is never left behind; Rust has
  no such case, since the agent is the process.
- `rawjson.isValid` is a scanner of its own with serde_json's `IgnoredAny`
  rules (no depth limit, numbers and `\u` escapes unconverted, any byte but
  a control character in a string); it agrees with serde_json 1.0.151 on
  200,000 fuzzed inputs.
- Account and other owned JSON files decode through `JSON.parse` and
  `Schema`, which accept two things serde refuses: a duplicate field (the
  last wins) and an integer field written as a float (`"priority": 1.0`).
  slopmax writes neither; telling them apart needs a struct-aware reader.
- Error causes inside chains are Schema's and this TOML reader's words, not
  serde's and toml_edit's; the context around them (`invalid config
<path>`, `skipping <path>`) is the Rust's.
- `ProviderId.get` reads a table the registry fills (above), where Rust
  matches on the enum.

## Chunk B: providers, agents, import

### Files

| Rust                         | TypeScript                       | Tests (Rust → `test/`)            |
| ---------------------------- | -------------------------------- | --------------------------------- |
| `provider/claude/mod.rs`     | `src/provider/claude/mod.ts`     | `provider/claude/mod.test.ts`     |
| `provider/claude/oauth.rs`   | `src/provider/claude/oauth.ts`   | `provider/claude/oauth.test.ts`   |
| `provider/claude/wire.rs`    | `src/provider/claude/wire.ts`    | `provider/claude/wire.test.ts`    |
| `provider/claude/limits.rs`  | `src/provider/claude/limits.ts`  | `provider/claude/limits.test.ts`  |
| `provider/claude/credits.rs` | `src/provider/claude/credits.ts` | `provider/claude/credits.test.ts` |
| `provider/codex/mod.rs`      | `src/provider/codex/mod.ts`      | `provider/codex/mod.test.ts`      |
| `provider/codex/oauth.rs`    | `src/provider/codex/oauth.ts`    | `provider/codex/oauth.test.ts`    |
| `provider/codex/wire.rs`     | `src/provider/codex/wire.ts`     | `provider/codex/wire.test.ts`     |
| `provider/codex/limits.rs`   | `src/provider/codex/limits.ts`   | `provider/codex/limits.test.ts`   |
| `provider/codex/credits.rs`  | `src/provider/codex/credits.ts`  | `provider/codex/credits.test.ts`  |
| `provider/keys.rs`           | `src/provider/keys.ts`           | `provider/keys.test.ts`           |
| `provider/compat.rs`         | `src/provider/compat.ts`         | `provider/compat.test.ts`         |
| `agent/claude_code.rs`       | `src/agent/claude-code.ts`       | `agent/claude-code.test.ts`       |
| `agent/codex.rs`             | `src/agent/codex.ts`             | `agent/codex.test.ts`             |
| `import.rs`                  | `src/import.ts`                  | `import.test.ts`                  |

Registration is unchanged: `provider/registry.ts` and `agent/registry.ts`
already listed the export names the skeletons had (`Claude`, `Codex`,
`ANTHROPIC`, `OPENAI`, `XAI`, `Compat`, `ClaudeCode`, `Codex`), which the
full modules keep. `provider/index.ts` now points `claude` and `codex` at
their directories' `index.ts`.

### Added to chunk A's modules

- `proxy/headers.ts` `insert(headers, name, value)`: Rust's
  `HeaderValue::from_str` then `HeaderMap::insert`; a value with control
  characters (or past Latin-1, which `Headers` cannot carry) leaves the map
  as it was.
- `serde.ts` `swapRemove(object, key)`: serde_json's `Map::remove` with
  `preserve_order`, which the workspace enables: the last key moves into
  the removed one's place. Claude Code's `settings.json` edits and Codex's
  `rebind`/`shape` remove keys with it, so files and bodies come out in the
  order Rust writes them. Tested in `test/serde.test.ts`.
- `serde.ts` `i64(value)`: serde_json's `Value::as_i64`, an integer that
  fits (never a float, even `3.0`, which wire's reader keeps as written).
  Codex's usage spans and seconds, the CLIProxyAPI `priority`, and Claude
  Code's `expiresAt` read through it. Tested in `test/serde.test.ts`.
- `provider/mod.ts` `jsonBody(response)`: `Response::json::<Value>`, the
  body read by wire's serde-faithful `json.read` instead of `JSON.parse`;
  `usageBody` now uses it, as do the Claude reset listing, the Codex model
  catalog and device code, and the key check's model list.
- `fsx.ts` `readToString(path)`: `fs::read_to_string`, where a missing
  file is a NotFound error (Codex's `auth.json`, a linked CLIProxyAPI file).
- `toml.ts`: `isTable` is exported (the Codex agent used a copy). A new
  table set where dotted keys already name it (`a.b.c = 1`, then a table
  `a`) goes where the first of those keys is, since toml_edit holds them
  as that table; the tables under it are then written where toml_edit
  writes them. `agent/codex.ts` also drops dotted keys under
  `model_providers.slopmax` when it replaces or removes that table, as the
  Rust's `insert`/`remove` on the dotted table do. Tested against
  toml_edit 0.25.15's output in `test/agent/codex.test.ts`.
- `test/support/fakes.ts` keeps `installForFile` and the registry
  re-export; `FakeClaude`/`FakeCompat` and `test/support/compat.ts` are
  gone (the tests that used them run on the real providers).

### Tests

|                                                                             | Count                                  |
| --------------------------------------------------------------------------- | -------------------------------------- |
| Rust tests in chunk B's files                                               | 97                                     |
| Ported with the Rust name                                                   | 97                                     |
| Added for contract clauses (`…, beyond the Rust tests`), plus 2 for `serde` | 24 + 2                                 |
| Passing (`bun test` on chunk B's test files, Bun 1.4.4)                     | 121 of 121, and `serde.test.ts` 4 of 4 |

The chunk A and C tests that stood on stand-ins (`auth/mod`, `usage`,
`agent/mod`'s symlink test, `route`, `report`) now run against the real
providers and pass unchanged otherwise.

### Deviations from the Rust

- Upstream OAuth and credit answers that Rust reads with serde structs
  (`TokenResponse`, `Profile`, `DeviceCode`, `Claimed`, the Codex credit
  list, `auth.json`, Claude Code's `claudeAiOauth`, the CLIProxyAPI file)
  are `Schema` structs with serde's rules (`opt`, `withDefault`), so the
  same answers decode or fail. `DeviceCode`'s `usercode` alias is a second
  optional field; a body carrying both names is read rather than refused.
- Upstream bodies whose numbers matter are read with `jsonBody` (wire's
  `json.read`), and Claude Code's credentials and CLIProxyAPI files with
  `json.read` too, so `3.0` stays a float that `i64`/`json.u64` refuse as
  serde does. Bodies decoded straight into a `Schema` of strings
  (`TokenResponse`, `Profile`, `Claimed`, the Codex credit list) still go
  through the net client's `json()`; they hold no integers.
- JavaScript objects list integer-like keys (`"0"`, `"1"`) first, so
  `swapRemove` cannot keep serde_json's order for them; objects with only
  ordinary keys come out in Rust's order. Agents and providers never send
  such keys.
- Claude Code's `claudeAiOauth` is decoded as a `Schema` with `expiresAt`
  as any JSON, then checked with `i64`, which is serde's `Option<i64>`.
- Functions with `&mut Account` (`apply_profile`, `apply_claims`) return
  the new account; `Agent.setup` returns what it saved (PORT.md, Data).
- `Provider.identify` for Codex is `Effect.sync(applyClaims)`.
- The Codex device login's deadline and sleeps use `Clock`, so tests drive
  the fifteen-minute expiry with `TestClock`; Rust uses tokio's clock.
- `claude/credits.ts` and `codex/credits.ts` repeat their `mod.ts`'s base
  URL instead of importing it, so the two modules do not import each other.
- Claude Code's keychain read (macOS) runs `security` through
  `proc.output` (Rust's `Command::output`), which does not block the event
  loop and kills the child if the effect is interrupted. Only the Linux
  path runs in tests.
- Re-wrapped errors (`lift`) keep the message, not the error as `cause`:
  the net client's `HttpError.message` already holds the root cause, and
  Rust's `?` into anyhow adds no context of its own, so `{:#}` (`chain`)
  prints the same text either way. A `cause` would print it twice.

### Left for later

- D1: the proxy reads `provider.claude.wire.clientAgent` for the Claude
  Code user agent that `Credits.list`/`redeem` need, and
  `provider.codex.limits.{fromEvent,poolEvent}` for WebSocket rate-limit
  events.

## Chunk C: placement and reporting

### The pool

- **`Inner` is the pool as a value**: accounts, states, sessions, pins,
  agents, the round-robin counters, the lapse queues, `routing`, and
  `dirty`. `Inner.pick`, `Inner.observe`, … are pure and return the new
  value (and their answer); nothing is mutated, so a watcher holding an
  old `Inner` keeps seeing it as it was. Sessions are an Effect `HashMap`
  (persistent), so a pick costs the same at 10 or 10,000 live sessions
  (about 5 to 9 µs with 8 accounts, measured); the maps keyed by account
  are copied, as a pick already walks every account.
- **`Pool`** keeps the current `Inner` in a `SubscriptionRef`: each Rust
  method is a method returning an Effect (`pool.pick(req, now)`,
  `pool.observe(id, limits, now)`, `pool.snapshot(now)`), `pool.get` is
  the value now, and `pool.changes` streams it. `Pool.make(strategy,
ttl, state)` restores sessions as of the clock's now. `LivePool` is a
  `Context.Service` holding the daemon's `Pool` (`LivePool.layer(...)`).
  A change that returns the same `Inner` (a housekeeping pick, an agent
  already seen) is not published (`updateSome`/`modifySome`).
- `pick` fails with `Unavailable` (a tagged error with `until` and
  `reason`). `Pick`'s optional fields default as the Rust tests set them.
- `state.json` is `StateSchema`: written in the Rust's key order and
  omissions (accounts by id in byte order, agents in provider order);
  every field defaults, so an empty or older file loads.
- `place(strategy, ready, states, picked, now)` is the placement, pure and
  private, as in the Rust; scores compare with `f64::total_cmp`'s order.

### Reporting

- `Report`, `AccountReport`, `PoolReport`, `NextReport`, `notify.Event`,
  `summary.Totals`/`Summary` and `history.History` have Schemas that write
  serde's JSON byte for byte (tests compare whole strings); `Totals.cost`
  is rounded to micro-dollars on the way out, `History.cached` is an
  `f32` (computed with `Math.fround`, written as serde writes an `f32`).
- `Summary.rows` is a `Map` in byte order of its keys, and
  `Summary.json(summary, indent, extra)` writes the summary (compact, or
  pretty as `to_string_pretty`, with the CLI's `left_on_the_table` as an
  extra key). A JS object would put keys like `7` (an account's label, a
  model) first, where the Rust's `BTreeMap` keeps byte order.
- `history.build` and `summarize` look each entry's price up once
  (`Totals.priceOf`, then `Totals.count` for every total it goes in),
  where the Rust's `Totals::add` looks it up per total; same sums.
- `Condition`, `Note` are `_tag` unions with `describe`/`tone`; `Tone` is a
  string union.

### Processes

- `proc.output` runs a program with stdin empty and collects its output;
  interrupting it kills the child (`kill_on_drop`). The notification
  command's 30 s limit is `Effect.timeoutOrElse`, so it follows the clock.
- `proc.detached` (used by `background.spawn`) starts `<exe> serve` with
  `detached: true`: a new session (`setsid`), where the Rust makes a new
  process group (Node and Bun offer no `setpgid` alone; the parity
  catalogue's note 9 prescribes this). Either way it outlives the
  terminal and misses its Ctrl-C. Its output goes to `slopmax.log`,
  opened asynchronously and closed once the child has it.
- `service.ts` touches the disk only through `fsx` (`writePrivate`,
  `removeFile`, `exists`); errors that Rust wraps with `.context()` use
  `error.context`, so `{e:#}` keeps the cause beneath.

### Tests

| Rust file       | Rust tests | Ported (Rust name) |  Added | Passing (Linux, Bun 1.4.4) |
| --------------- | ---------: | -----------------: | -----: | -------------------------- |
| `pool.rs`       |         21 |                 21 |     10 | 31 of 31                   |
| `route.rs`      |          4 |                  4 |      2 | 6 of 6                     |
| `notify.rs`     |          5 |                  5 |      3 | 8 of 8                     |
| `report.rs`     |         12 |                 12 |      3 | 15 of 15                   |
| `service.rs`    |          7 |                  7 |      3 | 9 of 10, 1 skipped         |
| `background.rs` |          8 |                  8 |      1 | 9 of 9                     |
| `summary.rs`    |          3 |                  3 |      4 | 7 of 7                     |
| `history.rs`    |          8 |                  8 |      3 | 11 of 11                   |
| **Total**       |     **68** |             **68** | **29** | 96 of 97, 1 skipped        |

`lingering_is_a_linux_question` is `#[cfg(not(target_os = "linux"))]` in
the Rust, and `test.skipIf(linux)` here (see `test/NOT-PORTED.md`). The
route and report tests stand on `test/support/compat.ts` until chunk B's
compatible endpoint is more than a skeleton.

### Deviations from the Rust

- The pool's methods are Effects over a `SubscriptionRef` instead of
  methods behind a `Mutex`; `report.Report.withNext` takes the pool's
  `Inner` (`yield* pool.get`) rather than the pool, so it stays pure.
  Mutex poisoning (POOL-037) has no counterpart.
- `summary.build` reads the ledger as an Effect; `summary.summarize` is
  the pure part over entries.
- The detached proxy gets a new session rather than only a new process
  group (above).
- `background.currentExe` is `process.execPath` when this is a built
  slopmax (its main module is inside the binary, `/$bunfs/…`). Run from
  source the program is Bun, which cannot run `serve`, so it fails with
  `locating the slopmax binary` rather than start `bun serve`.
- `Daemon.shutdown` fails with the `HttpError` itself, as the Rust's
  `?` passes reqwest's error on.

### Left for later

- D1 (the daemon) builds on `LivePool`/`Pool`, `notify.Watcher` with
  `nudged.json`, `Pool.takeLapses` with `waste.append`, and the periodic
  `Pool.snapshot` → `state.json` write.
- ~~B: once `provider/compat.ts` has `api`, `dialects`, and `serves`,
  `test/support/compat.ts` can go.~~ Done by B.

## Left for later chunks

- ~~B: the providers and agents behind the skeletons, `import.ts`'s
  discovery and saving, deleting `provider/pending.ts`, and moving the
  stand-in tests onto the real implementations.~~ Done (see "Chunk B").
- C: `pool.ts` takes `Pins` from `account.ts`; `notify.ts` takes
  `NotifySettings`/`NotifyKind` from `config.ts` (and adds
  `DEFAULT_EVENTS`).
- ~~D1: `proxy/mod.ts` imports the header rules from `proxy/headers.ts` and
  ports `forwardable_drops_only_credentials_and_hop_by_hop` against them.~~
  Done (see "Chunk D1").

## Chunk D1: the proxy hot path and the daemon

### Files

| Rust                                                         | TypeScript                               | Tests (`test/`)                |
| ------------------------------------------------------------ | ---------------------------------------- | ------------------------------ |
| `proxy/mod.rs` (`handle`, `proxy`)                           | `src/proxy/mod.ts`                       | `proxy/mod.test.ts`            |
| `proxy/mod.rs` (`App`, `Target`, `route`, `caller`, replies) | `src/proxy/app.ts`                       | `proxy/mod.test.ts`            |
| `proxy/forward.rs`                                           | `src/proxy/forward.ts`                   | `proxy/forward.test.ts`        |
| `proxy/sse.rs`                                               | `src/proxy/sse.ts`                       | `proxy/sse.test.ts`            |
| `proxy/start.rs`                                             | `src/proxy/start.ts`                     | `proxy/start.test.ts`          |
| `proxy/transcode.rs`                                         | `src/proxy/transcode.ts`                 | `proxy/transcode.test.ts`      |
| `proxy/socket.rs`                                            | `src/proxy/socket.ts`                    | `proxy/socket.test.ts`         |
| `proxy/models.rs`                                            | `src/proxy/models.ts`                    | `proxy/models.test.ts`         |
| `proxy/warm.rs`                                              | `src/proxy/warm.ts`                      | (`integration/proxy.test.ts`)  |
| `daemon.rs`                                                  | `src/daemon.ts`                          | `daemon.test.ts`               |
| `tests/proxy.rs`                                             | —                                        | `integration/proxy.test.ts`    |
| `tests/failover.rs`                                          | —                                        | `integration/failover.test.ts` |
| (the tests' shared parts)                                    | —                                        | `integration/harness.ts`       |
| `proxy/admin.rs`, `proxy/hub.rs`                             | `src/proxy/admin.ts`, `src/proxy/hub.ts` | D2's (below)                   |

`proxy/index.ts` exports `App`, `handle`, `httpApp`, `Target`, `warm`
beside chunk A's header rules and `rawjson`; the package's `index.ts`
exports `daemon`.

### The shapes

- **`App`** (`app.ts`) is made by `App.make(config, home, state, origins)`
  in a scope (the ledger's writer runs until it closes). The config is a
  `SubscriptionRef` (`app.config`, `app.setConfig`, `app.reloadConfig`);
  `app.sync`, `app.ready(account)`, `app.report`,
  `app.showPool(provider, headers)` are Effects (`Effect.fn` fields named
  `App.*`; the getters call them). `entry(parts)` (a ledger `Entry`, absent
  parts left out) and `outcomeDebug` (`{outcome:?}`) are `app.ts`'s too,
  for forward, socket, warm, and the daemon. `app.record(entry)` is the
  Rust's `broadcast` + `ledger.record`. The live feed is a sliding
  `PubSub` of 256 (`app.feed`, scoped: each subscriber is counted, and
  nothing is encoded while there are none). `app.shutdown` is a `Deferred`
  the daemon waits on; `app.redeeming` the one-permit `Semaphore` every
  redemption takes. In-memory caches (catalogs, the replay store, the
  Codex version and model, warm marks) are plain fields: one thread, and
  each is read and written inside one synchronous step, as the Rust held
  its mutexes. Times come from `Clock`.
- **`handle(app, request)`** answers an `effect/http` request and needs
  the request (for WebSocket upgrades) and its scope (streamed answers,
  held starts, the upstream socket) in context, which `@slopmax/net`'s
  server gives; `httpApp(app)` reads the request from context. The
  daemon serves it with `server.serve(listener, httpApp(app), shutdown)`.
- **Bodies are Streams.** The inbound body is read once (≤ 256 MiB) into a
  `Uint8Array` and replayed per attempt. Native answers stream back as
  `HttpServerResponse.stream` of the upstream's `intoBody()` through
  `sse.tapped` (a `Stream.mapArray` pass-through that reports once: at the
  end, on failure, or when the client drops it, through `Stream.onExit`
  and the request scope's finalizer).
  `start.hold` pulls with a 3 s deadline on the `Clock`; a refusal's
  `held` ends with the chunk that carried it, as Rust's ends with that
  frame (chunks after it in the same pull are frames Rust never read).
  `transcode` re-encodes chunk by chunk and finishes with the decoder's
  end.
- **Failover** is a plain loop in `forward.forward` with early returns;
  upstream failures are data (`Failure`, `Verdict`), not Effect errors.
  The ledger's `ms` and first byte count from when the request's body is
  in, as Rust's `Inbound::new` does.
- **Hot-path costs:** the tap searches `data:` lines with needles encoded
  once; `caller` encodes each config's keys once (a `WeakMap` on the
  config, which is swapped whole) and compares with `timingSafeEqual`.
- **Daemon**: `daemon.start(app)` forks every task into the scope on
  `Schedule.fixed(period)` (runs at once, then every period; an overrun
  delays the next run, which follows at once; runs never overlap); each
  run reads the config. `redeemExpiring` and `saveState` are exported for
  the admin API and tests, beside `pollAll`, `pollOne`, `listCredits`
  (D2 moved them to `polls.ts`; `daemon.ts` re-exports them).

### With D2

- `src/proxy/admin.ts` and `src/proxy/hub.ts` are D2's. They import from
  `./app.ts` (`App`, `jsonReply`, `emptyReply`, `error`, `unauthorized`,
  `authorized`, `caller`, `constantTimeEq`, `headersOf`, `splitUrl`),
  never `./mod.ts`: oxlint's `import/no-cycle` is an error here.
- The admin API's needs are on `App` (`feed`, `shutdown`, `redeeming`,
  `report`, `sync`, `setConfig`, `reloadConfig`, `pool`, `store`, `home`,
  `authHttp`, `record`).
- The integration tests that go through `/slopmax/*` and
  `/v0/management/*` no longer wait on a `placeholder` export: they run
  unconditionally.

### Tests

| Rust file            | Rust tests | Ported (Rust name) |  Added | Passing (Linux, Bun 1.4.4) |
| -------------------- | ---------: | -----------------: | -----: | -------------------------- |
| `proxy/mod.rs`       |          4 |                  4 |      3 | 7 of 7                     |
| `proxy/forward.rs`   |          5 |                  5 |      3 | 8 of 8                     |
| `proxy/models.rs`    |          1 |                  1 |      0 | 1 of 1                     |
| `proxy/socket.rs`    |          3 |                  3 |      2 | 5 of 5                     |
| `proxy/sse.rs`       |          5 |                  5 |      2 | 7 of 7                     |
| `proxy/start.rs`     |          3 |                  3 |      2 | 5 of 5                     |
| `proxy/transcode.rs` |          2 |                  2 |      2 | 4 of 4                     |
| `tests/proxy.rs`     |         38 |                 38 |      2 | 40 of 40                   |
| `tests/failover.rs`  |          9 |                  9 |      0 | 9 of 9                     |
| `daemon.rs`          |          0 |                  0 |      6 | 6 of 6                     |
| (`rawjson.keys`)     |          — |                  — |      1 | 1 of 1                     |
| **Total**            |     **70** |             **70** | **23** | 93 of 93                   |

The harness (HAR-001..010) is the Rust's: one stand-in per test on
`127.0.0.1:0` recording path and query, headers, and body (`/` probes
answered 404 unrecorded; WebSockets recorded as `ws {uri}` and one
`ws message` per text frame), answering by method, path, and bearer token;
the proxy in-process on a second port (`App.make`, `pool.sync`, no daemon
loop), with `Origins` pointing every provider URL at the stand-in, and
temp homes `slopmax-it-{pid}-{token}` / `slopmax-failover-{token}` removed
when the test's scope closes. Every environment variable is hidden from
the clients (`testkit.noEnv`), so a proxy set on the machine is not used.

### Deviations from the Rust

- `proxy/mod.rs` is two modules (`mod.ts` dispatches, `app.ts` holds what
  the handlers share), to keep imports acyclic.
- The tap reports from `Stream.onExit` (the end, a failure, or the client
  hanging up mid-stream) and from a finalizer on the request's scope (a
  body the server never started reading), whichever comes first, in place
  of Rust's `Drop`.
- A held start whose 3 s run out while a read is under way keeps that
  read and lets the stream finish it, since interrupting a fetch body's
  read can lose its chunk. The bytes are the same.
- The client side of a relayed WebSocket is Bun's (`server.upgrade`):
  Bun writes the `101`'s `upgrade`, `connection`, and accept key (slopmax
  adds `openai-model`, `x-reasoning-included`, `x-models-etag`), answers
  pings itself (WS-012, see `test/NOT-PORTED.md`), and echoes a close.
  When the relay ends, the client is sent a bare close if its socket is
  still open, where Rust dropped the connection. If Bun refuses the
  upgrade after the upstream answered `101`, the client gets the 426
  refusal (Rust had already sent its `101` and only logged).
- A background task whose run fails unexpectedly logs it and runs again
  on schedule; a panic would have ended the Rust's task.
- Ctrl-C and SIGTERM are `process.once` listeners (Windows: SIGINT only).
- `models_named` counts top-level `model` keys with `rawjson.keys` (added
  to chunk A's module, with a test), decoding escaped keys as serde does.
- A request without a body reads as empty: `effect/http`'s
  `request.stream` refuses a web `Request` whose `body` is null.
- Texts that come from libraries are theirs: a request body that cannot
  be read, an upstream network error (`@slopmax/net`'s wording), and the
  reason `config.toml is invalid, keeping the last good one: {e}` gives
  (Effect Schema's, where Rust printed toml_edit's). A background task
  that fails unexpectedly logs its `Cause.pretty`.
- A header named more than once reads as its values joined by `", "`
  (the web's `Headers` keeps no first value), so a request or answer
  carrying `content-encoding` twice counts as encoded where Rust read only
  the first. Neither agents nor providers send it so.
- Tests: `idle_chatgpt_windows_are_warmed_once` waits (`eventually`) for
  the first answer's ledger entry before warming, since the tap reports as
  the stream's finalizer, a moment after the client has the last byte;
  `rejects_requests_without_the_slopmax_key` reads only the status of its
  HEAD request (below).

### Left for later

- ~~D2: `admin.ts` and `hub.ts` (placeholders answering 404 until then), and
  with them the eight skipped integration tests.~~ Done (see "Chunk D2").
- `@slopmax/net`: `Response.text()`/`bytes()` never finish on an answer
  without a body (a HEAD, a 204): `raw()` reads `new ReadableStream()`
  when fetch's `body` is null, which never closes. The proxy itself never
  reads such a body (HEAD is answered locally), so only that test is
  affected.
- The 256 MiB request limit (413, PRX-030) has no test of its own; a
  review probe checked it end to end (413 `request body is too large`,
  in the Messages and Chat shapes).

## Chunk D2: admin, hub, dashboard, doctor

### Files

| Rust                                                 | TypeScript                                                     | Tests (`test/`)                                    |
| ---------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `proxy/admin.rs`                                     | `src/proxy/admin.ts`                                           | `proxy/admin.test.ts`, `integration/proxy.test.ts` |
| `proxy/dashboard.html`                               | `src/proxy/dashboard.html` (a copy, byte for byte)             | `proxy/admin.test.ts`                              |
| `proxy/hub.rs`                                       | `src/proxy/hub.ts`                                             | `proxy/hub.test.ts`, `integration/proxy.test.ts`   |
| `doctor.rs`                                          | `src/doctor.ts`                                                | `doctor.test.ts`                                   |
| `daemon.rs` (`poll_all`, `poll_one`, `list_credits`) | `src/polls.ts` (moved from `daemon.ts`, which re-exports them) | `daemon.test.ts`, `integration/*`                  |

The package's `index.ts` exports `doctor`. `admin` and `hub` stay private
to the proxy, as in the Rust (`mod.ts` dispatches to their `handle`).

### The shapes

- **`admin.handle(app, request)`** and **`hub.handle(app, request)`**
  (`Effect.fn("admin.handle")`, `Effect.fn("hub.handle")`) return
  `Effect<HttpServerResponse>`; every failure is an answer, and nothing
  they run needs the request's scope (the feed's stream scopes its own
  subscription). Bodies are read from `app.ts`'s `bodyOf(request)` with
  `@slopmax/net`'s `body.read` (64 KiB).
  Replies built from Schema output (the report, the history, the doctor's
  sections) go through `JSON.stringify` of the encoded value, so serde's
  number forms (`43.0`) survive (`serde.F64` encodes to raw JSON); the
  usage summary is `Summary.json`.
- **The dashboard** is a text import (`with { type: "text" }`) of the
  copied page, so the bundle and the compiled binary carry it as Rust's
  `include_str!` does. It is encoded to UTF-8 once, at module load, and
  served as those bytes (the AOT binary stores the text as UTF-16). `ts/.prettierignore` names it, so `bun fmt` (which
  formats HTML) leaves it byte for byte; the admin test compares it with
  the Rust file when the Rust tree is there.
- **The live feed** is `Stream.unwrap(app.feed)`: the subscription lives
  as long as the response's stream, which the server interrupts when the
  client goes. Each pull waits for the next entry with
  `Effect.timeoutOption(15 s)`, sending `: keepalive` on a timeout, as the
  Rust's `select!` on a fresh sleep does.
- **Redemptions** (`accounts/{id}/redeem`, the hub's consume) run under
  `app.redeeming.withPermit`, with the report built inside, as the Rust
  holds the guard to the end of the function.
- **`reset-quota`**'s background poll is
  `Effect.forkIn(pollOne(…), app.scope)` (`tokio::spawn`): it outlives the
  request and is interrupted when the app's scope closes, as the tokio
  runtime stops its tasks at shutdown.
- **The doctor** is Effects over plain data: `check(config, store)`, and
  each section's check exported (`@internal`) for tests: `proxy(config,
status)`, `accountsSection`, `claudeCode(config, dir)`, `codex(config,
dir)`, `cliproxyapi(accounts, port)`, `network(http)`, `files(dir)`,
  `onPath(program)`, `unserved(sections, config, accounts)`. `Section` is
  `{ title, findings }` with `Section.make`/`Section.add`/`Section.json`;
  `Finding.fix` is `undefined` in memory and `null` in JSON
  (`SectionSchema`). `Level` is `"ok" | "note" | "warn" | "fail"`,
  ordered by `Level.compare`.

### Added to other chunks' modules

- `src/polls.ts` (new): `pollAll`, `pollOne`, `listCredits`, and what
  they need (`isDue`, the listing periods), moved out of `daemon.ts`
  unchanged. `daemon.ts` imports the proxy (`httpApp`) to serve it, and
  the admin API calls these, so with them in `daemon.ts` the imports
  would cycle (`import/no-cycle` is an error). `daemon.ts` re-exports
  them, so `daemon.pollAll` and friends still work; D1's tests pass
  unchanged.
- `proxy/app.ts`: `constantTimeEq` is exported (the Rust's
  `super::constant_time_eq`), for the hub's `x-management-key`;
  `bodyOf(request)` (the request's body stream, empty when the web
  `Request` has none) is shared by admin and hub (`forward.ts` still has
  its own copy of the expression and can use it); and `App.scope`, the
  scope `App.make` ran in, holds background work a request starts.
- `fsx.ts`: `metadata(path)` (`fs::metadata(path).ok()`: the mode and
  whether it is a file, following symlinks), for the doctor's file
  permissions and `$PATH` lookups. Tested in `test/fsx.test.ts`.
- `ts/.prettierignore`: the dashboard page (above).

### Tests

| Rust file        | Rust tests | Ported (Rust name) |  Added | Passing (Linux, Bun 1.4.4) |
| ---------------- | ---------: | -----------------: | -----: | -------------------------- |
| `proxy/hub.rs`   |          1 |                  1 |      6 | 7 of 7                     |
| `doctor.rs`      |         17 |                 17 |      5 | 22 of 22                   |
| `proxy/admin.rs` |          0 |                  0 |     14 | 14 of 14                   |
| (`fsx.metadata`) |          — |                  — |      1 | 1 of 1                     |
| **Total**        |     **18** |             **18** | **26** | 44 of 44                   |

The eight `tests/proxy.rs` tests that waited on this chunk now run:
`integration/proxy.test.ts` passes 40 of 40, and the whole package 488 of
489 (1 skipped: `lingering_is_a_linux_question`, off Linux only). The
admin tests cover every endpoint: the dashboard (headers, the page byte
for byte), auth and 404s, status, refresh, sync (and its 500), shutdown,
usage, history, settings (listing, refusals, the 64 KiB limit, query plus
body, comments kept), the live feed (its subscription counted while the
client reads, released when it goes), every account action and its
refusals, redeem's outcomes and statuses, adding accounts, client keys,
and the doctor. The hub tests cover auth in both headers, routes,
auth-files' shape and key order, `api-call` body parsing (aliases, an
array in field order, a field given twice under one name, two, or an
escaped one, an ignored key repeated, refusals), the inner statuses,
consume, and reset-quota with polls on and off. The doctor's added tests
include empty variables under `preserveEmptyStrings` and Effect's
default.

### Deviations from the Rust

- `poll_all`, `poll_one`, `list_credits` live in `polls.ts` (above).
- `api-call` and `reset-quota` bodies are read with wire's serde-faithful
  `json.read`, then checked by hand as serde's derive reads a struct: an
  object (unknown keys ignored, and may repeat; a field given twice,
  under one name or two of its aliases, refused, as serde's `duplicate
field`) or an array of the fields in order; each a string;
  `auth_index` required for `reset-quota`, every field defaulting to `""`
  for `api-call`. `JSON.parse` keeps a repeated key's last value, so the
  top-level keys are counted in the text (`rawjson.keys`, each decoded).
  `consume`'s `data` is read the same way.
- `GET history` runs on the event loop instead of in `spawn_blocking`:
  the file reads yield to other requests, but parsing the ledger lines
  and bucketing them (`history.load`'s synchronous part) do not, so a
  month of a heavy ledger holds other requests for as long as that
  takes. Moving it off the loop needs a Worker in `history.ts`; it is
  left until a measurement says it matters. A failure (only a defect can
  fail it) answers 500 with its message, as a failed join does.
- Environment variables the doctor reads (`PATH`, `ANTHROPIC_API_KEY`) go
  through Effect's `Config`, whose providers treat an empty value as
  unset by default, where Rust's `var_os` sees it as set:
  `ANTHROPIC_API_KEY=` warns in the Rust and not here (nor does
  `PATH=` mean the current directory), unless the front end provides
  `ConfigProvider.fromEnv({ preserveEmptyStrings: true })`, as `log.init`
  asks too. Under that provider both match the Rust (tested).
- The port check binds with `@slopmax/net`'s `server.bind` (Bun's
  listener) and reads `EADDRINUSE`, where the Rust binds a
  `std::net::TcpListener`. CLIProxyAPI's check connects with `node:net`
  (`@slopmax/net` does not export its TCP connect) bounded by
  `Effect.timeoutOption(300 ms)` on the `Clock`
  (`TcpStream::connect_timeout`); it never binds.
- Codex's `config.toml`: `model_provider` is read from the parsed
  document's items, and `[model_providers.slopmax]` must be a table, not
  an inline table (as toml_edit's `as_table` decides); its fields are read
  from the document's data, which covers headers and dotted keys alike.

### Left for later

- The CLI (`slopmax doctor`) prints `doctor.check`'s sections; the front
  ends call the API or the module directly.
- See the env-var note above for the CLI's `ConfigProvider`.

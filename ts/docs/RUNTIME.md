# Runtime and toolchain for the TypeScript port

Measured 2026-10-30 on linux-x64 (EC2, 8 vCPU, 31 GB, kernel 6.18, Amazon Linux 2023), with
Bun 1.4.4, Node 24.21.0, Effect 4.1.0 (`effect`, `@effect/platform-bun`, `@effect/platform-node`),
TypeScript 7.0.2, Electron 45.1.0 (Node 24.22.1, Chrome 156), Vite 8.3.5, electron-vite 6.0.0,
tailwindcss 4.3.3, React 19.3.1, oxlint 1.90.0, hyperfine 1.20.0 and oha 1.16.0 from mise.
Every probe lives in `/tmp/ts-runtime-probe` and reruns with the commands in [Reproducing](#reproducing).
Sizes are exact bytes. RSS is `/usr/bin/time -f %M` for short commands and `VmRSS` from
`/proc/<pid>/status` for servers; PSS is `Pss` from `/proc/<pid>/smaps_rollup`.

## Recommendation

| Piece                    | Choice                                                                                                                                                                                                                     | Why, in one line                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime (CLI and daemon) | **Bun 1.4.4**, one `bun build --compile` binary                                                                                                                                                                            | `--version` 6x faster than a Node SEA of the same program (29 vs 175 ms), a third of its memory after load (57 vs 163 MB), no install step                     |
| Compile flags            | `--minify --bytecode --format=esm --bytecode-order=<version,serve profiles> --compile-jit-policy=4 --no-compile-autoload-{dotenv,bunfig,tsconfig,package-json}`, then `Bun.unsafe.setJITPolicy(1)` once the listener is up | 89 → 29 ms for `--version`, 36.6 → 28.8 MB for it, same throughput                                                                                             |
| Target                   | `bun-linux-x64-baseline` (same bytes as the default x64 build in 1.4.4); `bun-linux-x64-musl` for Alpine images                                                                                                            | no cost for older CPUs; the musl build is 6.4 MB smaller                                                                                                       |
| Not used                 | `--compile-exec-argv=--smol`, `--bytecode-depth`, `--no-optimize-bytecode`, `strip`, lazy `import()` of the server                                                                                                         | no gain or worse (tables below); `strip` breaks the binary                                                                                                     |
| Package manager          | **bun install** with workspaces (isolated linker, the default)                                                                                                                                                             | 0.3–0.8 s installs; strict per-package `node_modules` like pnpm                                                                                                |
| Type checker             | **bun check** (`bun check -b` follows project references)                                                                                                                                                                  | the same errors as `tsc` 7.0.2, 4.3x faster                                                                                                                    |
| Effect diagnostics       | **@effect/tsgo** 0.63 (`effect-tsgo tsc` / `effect-tsgo diagnostics`) in CI                                                                                                                                                | `bun check` does not run TS plugins; `@effect/language-service` does not work with TS 7                                                                        |
| Tests                    | **bun test** + a 38-line `it.effect` / `it.layer` helper (`@slopmax/test`) over `bun:test` and `effect/testing`                                                                                                            | `@effect/vitest` cannot run under `bun test`; the helper does, with `TestClock`                                                                                |
| Formatter                | **bun fmt** (Prettier-compatible), `printWidth = 120`, `semi = false` in `bunfig.toml`                                                                                                                                     | 62 files in 0.11 s; needs `.gitignore` to cover build output                                                                                                   |
| Linter                   | **oxlint 1.90** (Bun has none), with `@shadcn/lint` loaded as a JS plugin                                                                                                                                                  | native rules in 54 ms; shadcn's rules work through `jsPlugins`                                                                                                 |
| Desktop bundler          | **Bun.build** for main, preload, and renderer (HTML entrypoint, React 19, Tailwind via a 20-line plugin)                                                                                                                   | 0.27 s vs 1.22 s for electron-vite; outputs within 3%                                                                                                          |
| Desktop packager         | **@electron/packager** 20.3 (asar, `en-US` locale only)                                                                                                                                                                    | same bytes as electron-builder, 3.0 s vs 5–6 s to package                                                                                                      |
| Where the engine runs    | **(b) the bundled Bun CLI as a child process**, talked to over its admin API, as the Rust app does                                                                                                                         | the daemon outlives the window and is the same binary as the CLI and the login service; costs 113 MB on disk (37 MB as xz) and ~40 MB PSS more than in-process |

Bun replaces npm/pnpm, tsc (for checking), Prettier, Vite/esbuild, vitest, and `node` for the CLI and daemon (Electron's main process stays on Electron's own Node).
It does not replace a linter (oxlint), Effect's own diagnostics (@effect/tsgo), or the Electron
packager. Two Bun gaps need small workarounds in slopmax's code: SOCKS5 proxies for outbound
requests and `flock` (see the [capability matrix](#effect-41-capabilities-on-bun-and-node)).

Headline numbers against the Rust build (from ARCHITECTURE.md, not rerun here): the Rust binary is
under 6 MB, idles at 7 MB and answers `--version` in 2 ms. The TS CLI binary is 112,974,000 bytes
(39.5 MB as xz), idles at 40–41 MB, and answers `--version` in 29 ms. The desktop app is 392.6 MB
unpacked with the CLI inside (125.6 MB as tar.xz), and uses about 360 MB PSS across its processes.

## 1. The CLI as a single-file executable

Probe: an Effect 4 program with `effect/cli` (`serve`, `get <url>`) and `effect/http`: an
`HttpServer` with a streaming SSE route, a `POST /proxy/*` route that forwards the raw body with
`HttpClient` and streams the answer back, and `/healthz`. Entry `cli/src/main-bun.ts` provides
`@effect/platform-bun`; `cli/src/main-node.ts` provides `@effect/platform-node` (undici client).
The load is 1000 `POST /proxy/fast/v1/messages` at 10 concurrent through the probe to a Node mock
that answers 3 small SSE events (`oha -n 1000 -c 10`).

### Size and speed of each build

`--version` is the hyperfine mean of 60 runs (10 warmups); serve-ready is spawn to first
`/healthz` 200. Throughput varies ±15% between runs on this shared box; only large gaps mean anything.

| Build                                                     |           Bytes |                                       `--version` ms | `--version` RSS MB | serve ready ms | idle RSS MB | RSS after 1000 req MB |    req/s |   p50 ms |
| --------------------------------------------------------- | --------------: | ---------------------------------------------------: | -----------------: | -------------: | ----------: | --------------------: | -------: | -------: |
| plain `--compile`                                         |     109,877,424 |                                            95.0 ±7.3 |               37.4 |            135 |        44.0 |                  58.8 |     2011 |     3.84 |
| `--minify`                                                |     109,471,920 |                                            89.5 ±7.7 |               36.6 |            123 |        43.6 |                  59.0 |     1710 |     4.60 |
| `--minify --target=bun-linux-x64-baseline`                |     109,471,920 |                                            83.8 ±4.8 |               36.4 |            109 |        43.4 |                  58.8 |     2132 |     3.53 |
| `--minify` + `--no-compile-autoload-*`                    |     109,471,920 |                                            92.3 ±8.7 |               36.2 |            129 |        43.5 |                  58.8 |     1605 |     5.10 |
| `--minify --compile-exec-argv=--smol`                     |     109,471,920 |                                            95.7 ±8.5 |               38.1 |            124 |        43.1 |                  59.1 |     1601 |     4.87 |
| `--minify --compile-jit-policy=4` (never reset)           |     109,471,920 |                                            80.4 ±2.5 |               33.2 |            116 |        41.8 |                  57.9 |     1755 |     4.65 |
| `--minify --bytecode` (cjs)                               |     113,014,960 |                                            32.0 ±1.8 |               35.4 |             58 |        42.4 |                  58.5 |     1728 |     4.71 |
| `--minify --bytecode --format=esm`                        |     113,014,960 |                                            33.3 ±3.2 |               34.5 |             66 |        42.2 |                  58.3 |     1915 |     4.05 |
| `--bytecode --bytecode-depth=1` (cjs)                     |     111,950,000 |                                            43.8 ±4.6 |               36.4 |             73 |        43.4 |                  58.9 |     1947 |     4.14 |
| `--bytecode --no-optimize-bytecode` (cjs)                 |     113,080,496 |                                            34.6 ±3.4 |               35.5 |             57 |        42.8 |                  57.8 |     1933 |     3.59 |
| `--bytecode --bytecode-order` (cjs)                       |     112,974,000 |                                            32.6 ±2.2 |               33.5 |             63 |        41.2 |                  56.9 |     2017 |     3.86 |
| `--bytecode --format=esm --bytecode-order`                |     112,974,000 |                                            31.2 ±1.5 |               32.9 |             62 |        41.0 |                  56.8 |     1964 |     3.97 |
| + `--no-compile-autoload-*`                               |     112,974,000 |                                            32.1 ±2.4 |               32.6 |             63 |        41.1 |                  56.8 |     1918 |     4.28 |
| **+ `--compile-jit-policy=4`, reset to 1 after listen**   | **112,974,000** |                                        **29.0 ±1.7** |           **28.8** |         **55** |    **39.9** |              **57.0** | **1971** | **3.83** |
| + `--compile-jit-policy=16`, reset to 1 after listen      |     112,974,000 |                                            29.8 ±2.5 |               27.9 |             59 |        39.5 |                  57.7 |     2041 |     4.07 |
| + `--compile-jit-policy=4`, never reset                   |     112,974,000 |                                            30.7 ±1.8 |               28.8 |             60 |        38.8 |                  56.0 |     1456 |     6.18 |
| + `--compile-jit-policy=16`, never reset                  |     112,974,000 |                                            30.4 ±2.3 |               28.0 |             53 |        36.3 |                  53.4 |     1227 |     7.18 |
| + `--compile-exec-argv=--smol`                            |     112,974,000 |                                            40.9 ±3.7 |               33.8 |             66 |        41.3 |                  57.1 |     1994 |     4.02 |
| `--target=bun-linux-x64-musl`                             |     103,060,904 | needs musl's loader; not runnable on this glibc host |                    |                |             |                       |          |          |
| _reference:_ `bun` on the 349,583-byte minified bundle    |               — |                                            84.9 ±3.4 |               38.7 |            126 |        44.8 |                  59.5 |     1749 |     4.23 |
| _reference:_ Node 24 SEA (CJS bundle, `useCodeCache`)     |     128,257,216 |                                          174.8 ±16.4 |               69.6 |            172 |        72.0 |                 163.2 |     1015 |     8.65 |
| _reference:_ `node` on the 1,186,873-byte minified bundle |               — |                                           207.2 ±7.8 |               78.1 |            240 |        79.7 |                 156.1 |     1157 |     7.73 |
| _reference:_ same, `NODE_COMPILE_CACHE` warm              |               — |                                           179.4 ±7.9 |               72.4 |            205 |        75.5 |                 167.2 |     1156 |     8.00 |

What the table says:

- **`--bytecode` is the one large lever**: 85–90 ms → 31–33 ms for `--version` and serve ready
  in half the time, for 3.5 MB more binary. ESM and CJS bytecode are within noise; ESM is the
  format the rest of the code base uses.
- **`--bytecode-order`** (profiles recorded with `BUN_BYTECODE_ORDER_OUT` from `--version` and
  `serve`, version first) shaves 41 KB and 1–2 MB of RSS. Keep it; regenerate the profiles in CI.
- **`--compile-jit-policy=4`** keeps run-once startup code in the interpreter: another 3 ms and
  4 MB off `--version`. Left at 4 it costs a third of the proxy's throughput, so the daemon calls
  `Bun.unsafe.setJITPolicy(1)` once its listener is up (`Layer.tap` on the server layer in
  `cli/src/main-bun.ts`), which restores throughput and keeps the startup gain. 16 is no better than 4.
- **`--smol`, `--bytecode-depth=1`, `--no-optimize-bytecode`**: no memory gain, slower start.
- **`--no-compile-autoload-*`** changes nothing measurable, but stops a stray `.env` or
  `bunfig.toml` in the user's working directory from changing slopmax's behavior. Keep it for that.
- **Baseline vs modern**: in 1.4.4 the `bun-linux-x64`, `-modern` and `-baseline` runtimes are
  byte-identical (sha256 `10702245…ac235`, 107,308,936 bytes, from both npm packages), so
  `--target=bun-linux-x64-baseline` costs nothing and runs on pre-AVX2 CPUs.
- **musl** is 6,411,016 bytes smaller (its runtime is 100,902,216 bytes) but needs `/lib/ld-musl-x86_64.so.1`;
  it suits the Docker image, not a download for glibc desktops.
- **`strip`** saves 50 KB and turns the binary back into plain `bun` (the embedded `.bun` payload
  is lost). Do not strip.
- **Lazy `import()` of the server code** (`cli/src/main-bun-lazy.ts`): 34.0 ms vs 30.0 ms. Bun
  bundles it into the same graph and `effect/cli` plus `BunServices` are the cost anyway.

Where the 29–31 ms goes (bytecode, ESM, measured with throwaway programs): a compiled
`console.log` is 6.1 ms; importing `effect` and running one effect 8.5 ms; importing
`effect/cli` 15.6 ms; importing `@effect/platform-bun`'s `BunServices` 15.9 ms; a bare
`effect/cli` command tree answering `--version` 28.3 ms. The CLI's floor is Effect's module
initialization, not slopmax's code. Commands that only print could answer before Effect loads,
but every real command (status, setup, run) needs it, so this is the number to expect.

### Compressed sizes

| Binary                                                                     |           Bytes |        gzip -9 |         xz -9e |
| -------------------------------------------------------------------------- | --------------: | -------------: | -------------: |
| Bun 1.4.4 runtime alone                                                    |     107,308,936 |     51,625,424 |     38,075,928 |
| CLI, plain                                                                 |     109,877,424 |     51,797,234 |     38,214,480 |
| CLI, `--minify`                                                            |     109,471,920 |     51,747,108 |     38,181,968 |
| CLI, `--minify --bytecode --format=esm`                                    |     113,014,960 |     53,520,701 |     39,486,300 |
| **CLI, recommended flags**                                                 | **112,974,000** | **53,499,240** | **39,503,228** |
| CLI, musl                                                                  |     103,060,904 |     48,206,130 |     36,486,664 |
| Node 24.21 runtime alone                                                   |     126,595,440 |     44,346,883 |     29,303,020 |
| Node SEA of the same CLI                                                   |     128,257,216 |     43,596,491 |     29,393,856 |
| Claude Code 2.1.312 (`~/.local/share/mise/installs/claude/2.1.312/claude`) |     293,592,432 |    130,684,714 |     93,588,248 |

The Bun runtime is 107.3 MB of the 113 MB; the probe's own payload (the ELF `.bun` section) is
3,852,675 bytes with bytecode. Claude Code is the same Bun 1.4.4 runtime (its binary reports
`Bun v1.4.4 (Linux x64)`) with a 178,170,312-byte `.bun` payload. Node's runtime compresses about
9 MB better than Bun's, which is the only column Node wins.

## 2. Bun as the whole toolchain

Probe monorepo: `/tmp/ts-runtime-probe/mono`, laid out as `ts/docs/CONVENTIONS.md` says:
`packages/{common,wire,net,core,app}`, `apps/{cli,desktop}`, and `tools/test` (`@slopmax/test`).
The packages hold small but real Effect 4.1 code: `Schema.Class`/`Schema.TaggedError` accounts
decoded from JSON, a `Store` service on `FileSystem` with atomic writes, a `Pool` on
`SubscriptionRef` with typed `NoAccount` errors, a daemon with `Effect.repeat(Schedule)` fibers
forked into its scope, admin and proxy routes on `HttpRouter`, an `Http` client service with
origin rewriting and `retryTransient`, and the app's snapshot service. The CLI and the desktop app
both import `@slopmax/core`.

### bun install

`bun install` resolves the 7 workspaces (274 packages with the desktop's packagers) in 0.31–0.76 s
with a warm cache. Bun 1.4.4 uses the isolated linker for workspaces: each package gets its own
`node_modules` with only what it declares, so a missing dependency fails as it would with pnpm.
Electron 45 no longer has a postinstall step; its binary downloads on first use, or with
`bun node_modules/electron/install.js` (4.5 s). A later `bun add` re-extracts the package and
drops that download, so run `install.js` after installs (packagers use the zip in
`~/.cache/electron` and are unaffected).

### bun test and Effect

`@effect/vitest` does not run under `bun test`: Bun maps `vitest` to its own `bun:test` shim,
and `@effect/vitest` reads `vitest`'s `TestRunner.getCurrentSuite` at import
(`TypeError: undefined is not an object (evaluating 'V.TestRunner.getCurrentSuite')`).
Vitest 5 itself runs on Bun (`bun --bun vitest run`: 617 ms vs 878 ms on Node for one file),
so keeping vitest is possible, but it adds a test runner Bun already has.

The replacement, `mono/tools/test/src/index.ts` (38 lines), gives the same shape over `bun:test`:

```ts
import { it } from "@slopmax/test"

it("human_formats_short_spans", () => { /* pure */ })                    // bun:test as is
it.effect("until_counts_down_with_the_clock", () =>                     // TestClock + TestConsole, scoped
  Effect.gen(function* () {
    yield* TestClock.setTime(1_000)
    const before = yield* until(61_000)
    yield* TestClock.adjust("30 seconds")
    expect(Duration.toSeconds(before) - Duration.toSeconds(yield* until(61_000))).toBe(30)
  }))
it.live("…", () => …)                                                   // real clock, scoped
it.layer(Pool.layer)("Pool", (it) => {                                  // one build per describe block
  it.effect("blocked_account_returns_when_its_block_ends", () => …)
})
```

`it.effect` provides `TestClock` and `TestConsole` and runs the body in a `Scope`;
`it.layer` builds the layer once in `beforeAll` (merged with the test services) and closes its
scope in `afterAll`; a failure throws `Cause.pretty`, so `bun test` shows the Effect trace.
Rust test names map one to one, as CONVENTIONS.md asks. The suite (14 tests, 7 files) runs in
0.36 s, including `reload_runs_every_two_seconds_on_the_test_clock`, which forks
`Effect.repeat(Schedule.spaced("2 seconds"))` and advances `TestClock` by 10 s with no real time
passing (6 runs counted). One lesson from it: a fiber waiting on real I/O (a file read) is not
waiting on the clock, so `TestClock.adjust` runs ahead of it; the schedule test gives the
`Store` a synchronous fake, and file I/O is tested in a separate `it.layer` block.

### bun check

| Command                                                            | Projects/files                   | Time (hyperfine, 10 runs) |
| ------------------------------------------------------------------ | -------------------------------- | ------------------------: |
| `bun check -b` (7 project references)                              | 26 files                         |                    352 ms |
| `bun check -p tsconfig.flat.json`                                  | 26 files, `skipLibCheck`         |                    121 ms |
| `tsc -p tsconfig.flat.json` (7.0.2)                                | same                             |                    523 ms |
| `bun check -p tsconfig.flat-nolibskip.json`                        | 839 files, `skipLibCheck: false` |                    446 ms |
| `tsc -p tsconfig.flat-nolibskip.json`                              | same                             |                  1,966 ms |
| `tsc -b` (clean, emits declarations)                               | 7 projects                       |                    873 ms |
| `effect-tsgo tsc -p tsconfig.flat.json` (Effect-patched tsc 7.0.2) | 26 files + Effect diagnostics    |                    918 ms |

`bun check` reported exactly what `tsc` reported in every run: a clean pass on the Effect code,
the same real errors while writing it (`Config.string` → `Config.String`,
`HttpServerResponse.text` being a value not an Effect, a widened literal in
`SubscriptionRef.set`), and, with `skipLibCheck: false`, the same four errors line for line
(`bun-types` 1.4.4's `overrides.d.ts` and `globals.d.ts` against `@types/node` 24). Keep
`skipLibCheck: true`.

`bun check` does not load TypeScript plugins, and `@effect/language-service` says it does not
support TypeScript 7 ("use `@effect/tsgo` instead"). `@effect/tsgo` 0.63 supports 7.0.2 and
oxlint 1.90; `effect-tsgo diagnostics --project <tsconfig>` found, on the probe code:
146 `unstableApiUsage` warnings, 16 `schemaNumber`, 14 `schemaClassMissingBrand`, 7
`runOfExitToRunExit`. The `unstableApiUsage` ones are worth knowing about: the modules under
`effect/http`, `effect/cli`, `effect/process`, `effect/socket`, `TestConsole` and the platform
layers are importable from the 4.1.0 package but their functions are tagged `@stability unstable`.
Plan: `bun check` for the edit loop and pre-commit, `effect-tsgo diagnostics` in CI with
`unstableApiUsage` turned down to a message.

### bun fmt

`bun fmt` (Prettier-compatible; `bun fmt --doctor` says every file is formatted natively)
formats the 62 source files in 0.11 s and `--check` is idempotent. Config goes in `bunfig.toml`
(`[fmt] printWidth = 120, semi = false`). It reads ignores from `.gitignore`/`.prettierignore`:
before the probe had a `.gitignore` it rewrote bundles and the packaged app's
`LICENSES.chromium.html`, so add `dist/`, `out/`, `pkg/`, `resources/` there first.

### Linter: oxlint, with shadcn's rules

`bun` has no linter. oxlint 1.90 with `typescript`, `unicorn`, `oxc`, `import` (incl.
`import/no-cycle`) and `react` lints the monorepo in 54 ms (native rules only). It caught one
real issue (an unused import in `core/src/proxy.ts`). Two config notes: oxlint walks into
`node_modules/.bun` (Bun's isolated store) unless `ignorePatterns` lists `**/node_modules/**`,
and `react/react-in-jsx-scope` must be off for the React 19 JSX transform.

shadcn's lint rules are `@shadcn/lint` 0.2.3, an ESLint-API plugin that documents oxlint support
(oxlint ≥ 1.80). Loaded with `"jsPlugins": ["@shadcn/lint"]` they all ran on a fixture
(`apps/desktop/lint-fixture/bad.tsx`): `no-arbitrary-values` ("p-[13px]" → "use p-3.25"),
`no-raw-colors`, `no-unknown-classes` ("rounded-huge"), `no-inline-styles`, reading the theme from
`settings.shadcn.tailwindStylesheet`. With the JS plugin the run takes 836 ms on Node as the JS
host, 688 ms with `bun --bun oxlint`. `@effect/tsgo` can also patch oxlint to add Effect rules
(`effect-tsgo oxlint --type-aware`), not tried here.

## 3. The Electron 45 desktop app

Probe: `/tmp/ts-runtime-probe/mono/apps/desktop`. One 420×560 window, a tray icon,
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a CJS preload exposing
`window.slopmax.{version,onSnapshot}` through `contextBridge`; the renderer is React 19 with
Tailwind 4.3.3. Electron's main runs `@slopmax/app` (the snapshot service, on
`FetchHttpClient`) and pushes snapshots to the window. Verified under Xvfb: the renderer shows
the live daemon state ("Proxy up, 0 accounts") in all three engine placements, with Tailwind's
colors applied and the tray created.

### Bun's bundler vs electron-vite

|                                 |      Bun.build (`build-bun.ts`) | electron-vite 6 / Vite 8 (`electron.vite.config.ts`) |
| ------------------------------- | ------------------------------: | ---------------------------------------------------: |
| Build time (hyperfine, 10 runs) |                      266–310 ms |                                             1,219 ms |
| main (entry + lazy chunks)      | 2,211 + 254,969 + 142,258 + 741 |                    2,570 + 312,000 + 148,230 + 1,050 |
| preload (CJS)                   |                             177 |                                                  170 |
| renderer JS                     |                         212,469 |                                              219,632 |
| renderer CSS (Tailwind 4.3.3)   |                           7,041 |                                                6,020 |

**Pick Bun.build.** Same output within a few percent, 4x faster, no Vite/Rollup tree in the
dependencies, and the same bundler the CLI uses. The main bundle is split so `import()` of the
in-process engine and the app state loads Effect only when needed. Two findings:

- `bun-plugin-tailwind` 0.1.2 vendors tailwindcss **4.1.14**, not the project's 4.3.3. The probe
  replaces it with `tailwind-plugin.ts` (20 lines on `@tailwindcss/node` `compile` and the
  `@tailwindcss/oxide` scanner), which uses the installed version.
- electron-vite leaves the renderer unminified unless `build.minify: true` is set (566 KB → 220 KB).

What Vite still does better is the dev loop (HMR for the renderer, main-process restart). Bun's
answer is `bun --hot`/`Bun.serve` HTML routes for the renderer and a few lines of watch-and-restart
for main; not built here.

### Packaging

| Variant                                                                 | Unpacked bytes |   tar.gz -9 |  tar.xz -9e |      Time |
| ----------------------------------------------------------------------- | -------------: | ----------: | ----------: | --------: |
| @electron/packager, asar, `en-US.pak` only (engine in process)          |    279,375,768 | 121,381,509 |  88,199,852 |     3.0 s |
| electron-builder `--dir`, asar, `electronLanguages: ["en-US"]`          |    279,375,760 |           — |           — | 5.1–6.3 s |
| packager + the Bun CLI in `resources/` (engine as child)                |    392,583,260 | 174,984,172 | 125,608,800 |     3.0 s |
| packager + the CLI's Node bundle in `resources/` (ELECTRON_RUN_AS_NODE) |    279,840,708 | 121,533,434 |  88,318,092 |     2.9 s |

`app.asar` is 624,812 bytes; the rest is Electron: the `electron` binary alone is 234,458,440
bytes, then `resources.pak` 13.6 MB, `icudtl.dat` 10.8 MB, `LICENSES.chromium.html` 5.6 MB,
SwiftShader/Vulkan 7.1 MB, `libffmpeg.so` 2.8 MB. Pruning locales takes 55 files down to one.
Packager and builder produce the same bytes; packager is faster, and
Forge drives packager underneath, so it adds a CLI and makers but no size win. electron-builder
earns its place only for installers (AppImage, deb, dmg, auto-update), which this probe did not
build.

### Time to first window and memory

Spawn to `ready-to-show` under Xvfb with Mesa (software GL), packaged app, no engine, 5 runs:
**391–462 ms, median 415 ms**; of that, 180–232 ms is inside main after it starts.

Memory 6 s after the window shows. Chromium's processes share most pages, so the RSS sum
counts the Electron binary seven times; **PSS sum is the real cost**.

| Flags (no engine)                                                              | Processes | RSS sum MB | PSS sum MB |
| ------------------------------------------------------------------------------ | --------: | ---------: | ---------: |
| default                                                                        |         7 |        734 |        309 |
| `app.disableHardwareAcceleration()`                                            |         8 |        733 |        291 |
| `--disable-gpu --disable-software-rasterizer`                                  |         8 |        732 |        289 |
| `--in-process-gpu`                                                             |         6 |        666 |        307 |
| `--renderer-process-limit=1`                                                   |         7 |        737 |        310 |
| `--js-flags=--lite-mode`                                                       |         7 |        735 |        309 |
| lean set (no GPU, process limit, five features off, `--max-old-space-size=96`) |         8 |        735 |        291 |

Per process (RSS, default): main 204, zygotes 94/94/22, GPU 97, renderer 104, network service
118 MB. Only turning the GPU off helps (−18 MB PSS: the GPU process drops to 71 MB and a 24 MB
broker appears); nothing changed the first-window time. A status window does not need GPU
compositing, so call `app.disableHardwareAcceleration()`; recheck on macOS, where the GPU path differs.

## 4. Where the engine runs

The same packaged app, the daemon placed three ways (`SLOPMAX_ENGINE`), plus the daemon alone.
"After load" is after 1000 proxied requests through the daemon.

| Placement                                     | Disk (unpacked) |          tar.xz | First window ms | PSS sum idle MB | PSS sum after load MB | RSS sum idle MB |
| --------------------------------------------- | --------------: | --------------: | --------------: | --------------: | --------------------: | --------------: |
| no engine (baseline)                          |     279,375,768 |      88,199,852 |             415 |             309 |                     — |             734 |
| (a) in Electron's main on Node                |     279,375,768 |      88,199,852 |             531 |             321 |                   353 |             750 |
| **(b) bundled Bun CLI as a child**            | **392,583,260** | **125,608,800** |             577 |         **361** |               **373** |             791 |
| (c) CLI bundle under `ELECTRON_RUN_AS_NODE=1` |     279,840,708 |      88,318,092 |             601 |             359 |                   392 |             897 |
| (a) with the lean flags                       |                 |                 |             475 |             304 |                   336 |             744 |
| (b) with the lean flags                       |                 |                 |             518 |             342 |                   357 |             790 |
| (c) with the lean flags                       |                 |                 |             512 |             340 |                   377 |             894 |

| The daemon alone                              | `--version` ms | idle RSS / PSS MB | after load RSS / PSS MB |
| --------------------------------------------- | -------------: | ----------------: | ----------------------: |
| Bun binary (`resources/slopmax`)              |             39 |           42 / 40 |                 58 / 56 |
| Electron binary with `ELECTRON_RUN_AS_NODE=1` |            225 |         148 / 142 |               193 / 187 |
| Node 24.21 (`node slopmax-node.mjs`)          |            172 |           74 / 50 |               181 / 154 |

The first-window times with an engine include starting it before the window; the probe's main
does that first, and creating the window first would hide most of the difference.

**Recommendation: (b).** In-process (a) is the cheapest, by 113 MB on disk and about 40 MB of
PSS, but it ties the proxy to the app: quitting or updating the app cuts every Claude Code and
Codex session going through it, and the login service (`slopmax service install`) and the terminal
commands need the CLI binary anyway. (b) keeps the shape the Rust app has today: the app starts
the bundled CLI's proxy if none runs, the proxy keeps running without the window, the same binary
serves the terminal (the app can link it onto `PATH` rather than ship it twice), and the daemon
gets Bun's memory profile: 56 MB PSS under load, against 154 MB on Node. (c) saves the disk but
is the worst on memory and startup, runs a 234 MB Electron binary as a background service, and
requires leaving Electron's `RunAsNode` fuse on, which Electron's security guidance says to turn off.

What (b) means for the shared core: the daemon and CLI run the core on Bun only. Electron's main
still runs `@slopmax/app` on Node 24.22 (it did in every probe), so whatever the app calls
directly must work on Node too. Two ways to keep that small: route the app's actions through the
daemon's admin API (as `POST /slopmax/sync` already is), or keep the core's I/O behind Effect's
platform services (it already depends on `effect` only) and run its tests on both runtimes in CI.
The one piece that does not port is `flock` (below): Node has none, so file writes that need the
lock belong in the daemon or the CLI.

## Effect 4.1 capabilities on Bun and Node

Each row is a working program in `/tmp/ts-runtime-probe/caps/src`, run unchanged on both
runtimes (`src/platform.ts` picks the layers). Results: `caps/results/caps.txt`.

| Capability                                                                            | Bun 1.4.4      | Node 24       | The pattern that works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) proxy pass-through, streamed                                                      | works          | works         | `new Uint8Array(yield* req.arrayBuffer)` → `HttpClient.execute(HttpClientRequest.post(url).pipe(bodyUint8Array(bytes)))` → `HttpServerResponse.stream(res.stream, …)`. Upstream sends 5 SSE events 300 ms apart; the client gets the first at 319 ms (Bun) / 342 ms (Node), 1.2 s before the last, each within 0–6 ms of the upstream's send time. `TCP_NODELAY` is on by default for accepted and outbound sockets on both (strace: `setsockopt(…, TCP_NODELAY, [1])`, also for a bare `node:http` server).                                           |
| (b) WebSocket upgrade, relayed to an upstream WebSocket with a custom `Authorization` | works          | works         | `const client = yield* req.upgrade`; `Socket.makeWebSocket(url, { headers: { authorization } })` with `BunSocket.layerWebSocketConstructor` / `NodeSocket.layerWebSocketConstructor`; relay with each side's `reader.pull` → other side's `writer.write`, `Effect.raceFirst` of the two pumps, all in `Effect.scoped`. The upstream saw the swapped header; text frames stay text.                                                                                                                                                                     |
| (c) outbound through an HTTP CONNECT proxy (to HTTPS)                                 | works          | works         | Bun: `BunHttpClient.layerOptions({ proxy: "http://…", tls: { ca } })`. Node: `NodeHttpClient.layerUndiciNoDispatcher` + `Layer.succeed(NodeHttpClient.Dispatcher)(new ProxyAgent({ uri, requestTls: { ca } }))`.                                                                                                                                                                                                                                                                                                                                       |
| (c) outbound through SOCKS5                                                           | **workaround** | works         | Bun's `fetch` rejects `socks5://` (`UnsupportedProxyProtocol`), and `import "undici"` on Bun is Bun's built-in stand-in with no `Socks5ProxyAgent`. Workaround: `src/socks-bridge.ts` (45 lines of `node:net`), a loopback CONNECT proxy that dials out through SOCKS5; point `proxy` at it. Node: `new Socks5ProxyAgent(url, { requestTls: { ca } })` from undici 8.12 (prints an experimental warning).                                                                                                                                              |
| (d) raw request body as bytes, replayed                                               | works          | works         | `req.arrayBuffer` gives the exact bytes (300 KB of random, non-UTF-8 data, sha256 equal); the same `Uint8Array` sent upstream twice.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| (e) `effect/cli`                                                                      | works          | works         | `Command.make(name, { flags, args }, handler)`, `Command.withSubcommands` nested two deep, `Flag.Int/String/Boolean/Literals`, `withAlias`, `withDefault`, `Flag.optional`, `Argument.String/Path`, `Argument.optional`, `Argument.variadic({ min: 1 })`, automatic `--no-<flag>` for booleans; `--help` per subcommand, `--completions bash`, a bad choice exits 1 with "Expected: "claude" \| "codex"". Help always lists five global flags (`--wizard`, `--completions`, `--log-level`, …) and does not show default values.                        |
| (f) child processes (`effect/process`)                                                | works          | works         | `ChildProcessSpawner`: `.string(cmd, { includeStderr })`, `.exitCode(cmd)` (3 for `exit 3`), `.streamLines(cmd)` (lines arrive as printed, 200 ms apart), `.spawn(cmd)` in a scope: closing the scope kills the child (checked in `/proc`). `ChildProcess.make("sh", ["-c", …])` or the template form.                                                                                                                                                                                                                                                 |
| (g) atomic file replace                                                               | works          | works         | `fs.writeFileString(tmp, data, { mode: 0o600 })` then `fs.rename(tmp, file)`: 400 reads racing 200 replacements of a 64 KB file saw no torn file; mode 0600.                                                                                                                                                                                                                                                                                                                                                                                           |
| (g) exclusive-create lock file                                                        | works          | works         | `fs.open(lock, { flag: "wx" })`: a second create fails. Not released if the holder crashes, so it needs a PID/age check.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| (g) `flock(2)`                                                                        | **workaround** | not available | Effect's `FileSystem` has no lock, and neither Bun nor Node exposes `flock`. On Bun, `src/flock.ts` (30 lines) calls libc's `flock` through `bun:ffi` with `LOCK_EX \| LOCK_NB` and an `Effect.retry(Schedule.spaced("25 millis"))`, inside `acquireRelease`. It sees a lock held by util-linux `flock` (the same call Rust's `File::lock` makes, so the Rust and TS builds can share `~/.slopmax` lock files) and gets it within 10 ms of the holder being SIGKILLed (the kernel drops the lock with the process). Works inside a `--compile` binary. |

All of (a)–(g) also passed inside a `bun build --compile` binary where tried ((b) and (g)).

## Reproducing

Tools come from mise; `source /tmp/ts-runtime-probe/tools/env.sh` puts bun 1.4.4, node 24.21.0,
hyperfine 1.20.0 and oha 1.16.0 on `PATH` (the same as
`mise exec bun@1.4.4 node@24.21.0 hyperfine@1.20.0 oha@1.16.0 -- …`) and points
`SLOPMAX_HOME` at a throwaway directory. Ports used: 18787–18809, 19100–19103, 19443, Xvfb `:99`.
Nothing touches `~/.slopmax` or port 8317. Scripts kill only the PIDs they start.

```sh
source /tmp/ts-runtime-probe/tools/env.sh

# 1. CLI builds and measurements
cd /tmp/ts-runtime-probe/cli
bun install
./build.sh                          # dist/bin/* (every variant, Node SEA, bytecode-order profiles)
./measure.sh                        # results/runtime.tsv (all), or ./measure.sh best-jit4 node-sea …
PROBE_NO_JIT_RESET=1 ./measure.sh best-jit4 best-jit16 min-jit4   # the "never reset" rows
./compress.sh dist/bin/best-noauto-bc-order …   # results/compressed.tsv (xz -9e is slow)

# 2. Toolchain on the monorepo
cd /tmp/ts-runtime-probe/mono
bun install
bun test                            # 14 pass, with @slopmax/test (tools/test/src/index.ts)
bun check -b --no-script            # project references
hyperfine -N "bun check -p tsconfig.flat.json --no-script" "./node_modules/.bin/tsc -p tsconfig.flat.json"
./node_modules/.bin/effect-tsgo diagnostics --project packages/core/tsconfig.json
bun fmt --no-script --check
./node_modules/.bin/oxlint          # flags lint-fixture/bad.tsx through @shadcn/lint
cd /tmp/ts-runtime-probe/vitest-under-bun && bun test   # shows @effect/vitest failing under bun test

# 3–4. Desktop app
cd /tmp/ts-runtime-probe/mono/apps/desktop
bun node_modules/electron/install.js   # once, after any bun install/add
bun build-bun.ts                       # or: ./node_modules/.bin/electron-vite build
./package.sh                           # builds the app, both engine forms, and pkg/{packager-a,b,c,builder-a}
./measure-all.sh                       # results/desktop.tsv (first window, RSS/PSS per placement and flags)
./engines.sh                           # results/engines.tsv (the daemon alone, three runtimes)
./compress.sh                          # results/compressed.tsv
# one run by hand, printing the renderer's text:
Xvfb :99 -nolisten tcp & XPID=$!
DISPLAY=:99 bun measure-desktop.ts check pkg/packager-b/slopmax-desktop-linux-x64/slopmax-desktop "" SLOPMAX_ENGINE=child SLOPMAX_PROBE_DOM=1
kill $XPID

# 5. Effect capability probes (starts its own test servers)
cd /tmp/ts-runtime-probe/caps
bun install
./run-all.sh                           # results/caps.txt; or e.g. bun src/b-websocket.ts / node src/b-websocket.ts
```

Probe sources worth reading first: `cli/src/core.ts` (the CLI probe), `mono/packages/core/src/`
(the shared core), `mono/tools/test/src/index.ts` (the test helper),
`mono/apps/desktop/src/main.ts` (the three engine placements), `mono/apps/desktop/tailwind-plugin.ts`,
`caps/src/socks-bridge.ts`, `caps/src/flock.ts`.

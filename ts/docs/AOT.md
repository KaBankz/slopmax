# Bun's ahead-of-time compiler

Bun merged ahead-of-time compilation on 2026-10-27 ([oven-sh/bun#45631]):
`bun compile` (short for `bun build --compile --aot`) type checks the whole
program and compiles it to machine code, so the executable has no JIT. It is
experimental and, as of 2026-10-30, only in canary builds: Bun 1.4.4 (released
2026-10-22) accepts `--aot` and ignores it.

[oven-sh/bun#45631]: https://github.com/oven-sh/bun/pull/45631

## Install

Canary through mise's GitHub backend, apart from the pinned stable Bun:

```toml
[tools]
"github:oven-sh/bun" = { version = "canary", asset_pattern = "bun-linux-x64.zip" }
```

Measured with `1.4.4-canary.1+da867c60b`.

## First measurements (linux-x64, 2026-10-30)

An Effect 4.1 program: `effect/cli` with a `serve` subcommand, `effect/http`
router with a text route and a streaming SSE route, `@effect/platform-bun`.
Probe source: `/tmp/fxprobe/srv.ts`.

| Build                                              |   Binary |      xz | `--version` | Idle RSS | RSS after 20k requests | req/s, 32 at once |
| -------------------------------------------------- | -------: | ------: | ----------: | -------: | ---------------------: | ----------------: |
| `bun compile --trim` (AOT)                         |  62.1 MB | 23.2 MB |       25 ms |    38 MB |                  50 MB |             38.9k |
| `bun compile --no-aot --minify --bytecode`         | 144.0 MB | 53.1 MB |       36 ms |    40 MB |                  59 MB |             36.5k |
| Bun 1.4.4 `build --compile --minify` (hello world) | 109.3 MB |         |             |          |                        |                   |
| Rust slopmax (for scale)                           |   5.9 MB |         |        2 ms |     7 MB |                        |                   |

A hello world compiles to 25.6 MB with `--trim` (68 MB without).

- `--trim` removes the Bun and Node APIs the program never calls (90.7 MB of
  them here). It is what makes AOT binaries small.
- The build takes ~15 s and all cores for a 352-module bundle; it is not cached.
- Effect compiles as is. One warning: Effect's HTTP router builds a `RegExp`
  from strings (`effect/dist/http/FindMyWay/internal/router.js:162`), which
  runs in the interpreter. Only routes with regex parameters reach it.
- Type errors stop the build, so the port must pass `bun check` cleanly.

## Rules for the port, so it compiles well

- Strict types everywhere; no `any` on hot paths. Typed code compiles to
  fixed-offset loads; untyped code falls back to runtime lookups.
- No `eval`, `new Function`, or dependencies that generate code from strings
  (zod 4 without `jitless`, ajv, fast-json-stringify). Effect `Schema` does not
  generate code.
- No patching of built-in prototypes (they are read-only in an AOT binary).
- No dynamic `import()` of computed paths.
- Check errors with `instanceof` or `_tag`, never by `error.message` (AOT
  messages quote less source).
- `bun compile --explain` lists slow paths worst first; run it on the CLI
  before measuring.

## Caveats

- Experimental and canary-only. Benchmarks report AOT and JIT builds side by
  side, and the shipped build falls back to `--no-aot` if AOT breaks a feature.
- AOT builds only for the host platform: macOS binaries are built on macOS CI.

## Found while porting

- `bun:ffi`'s `dlopen` (the `flock` in `@slopmax/core`'s `fsx.ts`) keeps
  `--trim` from removing unused APIs: a hello world grows from 27.4 MB to
  36.5 MB. Measure the CLI with and without it before choosing how locks work.
- A dynamic `import()`, even of a fixed path, makes the bundler wrap every
  module it reaches in a lazy initializer: the CLI grew from 75.7 MB to
  84.4 MB that way. `slopmax --version` answers fast without one instead:
  `main.ts` imports `version.ts` first, which prints and exits before the
  rest of the program is evaluated.
- `--trim-locales=en` saves 4.7 MB and `--no-compile-function-source` 2.3 MB
  (nothing in slopmax reads a function's source or formats for other locales).

## The slopmax binary (2026-10-31, linux-x64, `1.4.4-canary.1+da867c60b`)

`mise run compile` (`bun build.ts compile`: `bun compile --trim
--trim-locales=en --no-compile-function-source --no-compile-autoload-*`,
with the web dashboard embedded), measured on a shared host under load
(load average about 20 on 8 cores):

| Metric                                                               | Measured                                                                                                | Budget (ARCHITECTURE.md §16) |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Binary                                                               | 71,284,968 bytes (68.0 MiB), 93.8 MB of Bun APIs trimmed                                                | ≤ 70 MiB                     |
| As `xz -9`                                                           | 23,852,464 bytes                                                                                        | ≤ 26 MB                      |
| Third-party packages inside                                          | effect, @effect/platform-bun, @effect/platform-node-shared, @decimalturn/toml-patch (`ws` is Bun's own) | the §14 list                 |
| `--version` (hyperfine, 50 runs)                                     | 22.4 ± 7.3 ms (min 15.9), 26 MB RSS                                                                     | ≤ 30 ms                      |
| Daemon idle RSS (30 s after start)                                   | 58 MB (12 MB anonymous, 46 MB the binary's code paged in)                                               | ≤ 45 MB                      |
| Daemon peak RSS, 32 at once × 300 KB, 3,000 requests to a local mock | 153 MB (back to 62 MB after)                                                                            | ≤ 120 MB                     |
| Build time                                                           | about 80–135 s, every core                                                                              |                              |

The fallback (`mise run build`: `--no-aot --minify --bytecode --format=esm`,
bytecode laid out by profiles of `--version`, `status --json` and `serve`)
is 118,188,208 bytes and answers `--version` in 61 ± 12 ms on the same host.

Every CLI test (`bun test apps/cli/test` with `SLOPMAX_BIN=apps/cli/dist/slopmax`)
passes on the AOT binary. `bun compile` warns only about regular expressions
built from strings inside Effect's Schema and HTTP router and
@decimalturn/toml-patch; none come from slopmax's own code. The daemon's
memory is over budget; most of the idle figure is machine code touched while
the engine's modules initialize.

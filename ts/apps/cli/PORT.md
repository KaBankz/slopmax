# slopmax (the CLI): port notes

The TypeScript port of `crates/slopmax`: the `slopmax` binary. It parses
the command line, asks and prints; `@slopmax/core` does the work, and the
hidden `app-host` command runs `@slopmax/app`'s engine for the desktop
shell.

## Files

| Rust                         | TypeScript                                               | Notes                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.rs`                | `src/main.ts`                                            | Provides `BunServices`, the `Terminal`, `log.layer` (`info` for `serve`, else `warn`), and `ConfigProvider.fromEnv({ preserveEmptyStrings: true })`; prints `error: {e:#}`. |
| (`lib`)                      | `src/index.ts`                                           | The modules as namespaces (`args`, `commands`, `term`, `ui`), for tests and the AOT check.                                                                                  |
| `src/args.rs`                | `src/args.ts`                                            | The table-driven parser, pure: `parse` returns `Result<Parsed, UsageError>`; `Matches.get(name, parse)` is `FromStr` (`i32`, `usize`, `Shell.parse`, …).                    |
| `src/commands.rs`            | `src/commands.ts`                                        | `APP` (the table), `run` (an Effect returning the exit code), `key`, `endpoint`, `settings`, `onOff`, `setup`; `APP_HOST`.                                                  |
| `src/commands/accounts.rs`   | `src/commands/accounts.ts`                               | `import` is `importLogins` (`import` is a keyword).                                                                                                                         |
| `src/commands/background.rs` | `src/commands/background.ts`                             | Also `anyhow`: an error that is not a `Failure` as one (its message), for the core calls that fail with `IoError` or `HttpError`.                                           |
| `src/commands/doctor.rs`     | `src/commands/doctor.ts`                                 |                                                                                                                                                                             |
| `src/commands/init.rs`       | `src/commands/init.ts`                                   | `Answers` is `"Ask" \| "Defaults"`; `Plan.empty()` is `Plan::default()`.                                                                                                    |
| `src/commands/status.rs`     | `src/commands/status.ts`                                 | `render` is pure; `json` is `to_string_pretty` of the encoded `Report`.                                                                                                     |
| `src/commands/usage.rs`      | `src/commands/usage.ts`                                  | JSON through the core's `Summary.json` with `left_on_the_table` added, so rows keep byte order.                                                                             |
| `src/term.rs`                | `src/term.ts`                                            | `Terminal` (a `Context.Service`): one stdin reader, secrets, sign-in pastes; `confirm`, `ask`, `choose`, `chooseMany`, `parseChoices`.                                      |
| `src/ui.rs`                  | `src/ui.ts`                                              | Styles, `bar`, `pad`, `visibleWidth`; `init` decides color once; `print`/`println`/`eprint`/`eprintln`/`flush`.                                                             |
| `tests/cli.rs`               | `test/cli.test.ts`, `test/support/sandbox.ts`            | The sandbox of CLI-230/231, unchanged.                                                                                                                                      |
| `examples/bench.rs`          | `bench/bench.ts`                                         | `upstream`, `proxy`, `bodies` (CLI-220..225); the bodies are byte for byte the Rust rig's.                                                                                  |
| `scripts/bench.sh` (repo)    | `bench/bench.sh`                                         | The same requests, rows, and startup runs, on `dist/slopmax` and `dist/bench`; `UPSTREAM_RIG` puts another rig's mock (say, the Rust's) in front of both proxies.           |
| (cargo build)                | `package.json` `compile`, `compile:jit`, `compile:bench` | See "The binary".                                                                                                                                                           |
| (release workflow)           | `scripts/package.sh`                                     | `slopmax-<target>.tar.gz` (binary at the root) and `.sha256`, the names `install.sh` fetches.                                                                               |

## The binary

- `bun run compile` (or `mise run compile`): `bun compile --no-script --trim
--no-compile-autoload-dotenv --no-compile-autoload-bunfig`, ahead of time,
  with Bun canary (`$BUN_CANARY`, else the `bun` on PATH, which `mise run
compile` makes the canary). `--no-script` keeps `bun compile` from running
  this package's own `compile` script. 69,859,560 bytes; about 19 to 40 s.
- `bun run compile:jit`: `scripts/compile-jit.sh`, Bun 1.4.4 with RUNTIME.md's
  flags (`--minify --bytecode --format=esm --compile-jit-policy=4
--no-compile-autoload-*`), built twice so `--bytecode-order` lays the
  bytecode out by what `--version` and `serve` load (profiles recorded with
  `BUN_BYTECODE_ORDER_OUT` in a throwaway home on a port the system picks).
  115,534,000 bytes; about 6 s. `serve` calls `Bun.unsafe.setJITPolicy(1)`.
- Both write `dist/slopmax`, print `slopmax 0.3.0` for `--version` (the
  core's `VERSION`, which matches the workspace), and pass the whole suite.
  A quick look (hyperfine, 40 runs, this shared box): `--version` 37 ms AOT,
  64 ms JIT, 5.5 ms for the Rust debug build. The benchmark phase measures
  properly (`bench/bench.sh`).
- `bun compile --explain` finds nothing in the CLI's own code that matters
  (each entry about 0 % of the time); the largest cause is Effect's
  generators, which the Effect runtime calls. `bun check --aot` reports no
  errors on `src/index.ts`, `src/main.ts`, and `bench/bench.ts`; the four
  warnings are regular expressions inside Effect.

## Tests

| Rust file                | Rust tests | Ported (Rust name) |  Added | Passing (Linux, Bun 1.4.4, against the AOT `dist/slopmax`) |
| ------------------------ | ---------: | -----------------: | -----: | ---------------------------------------------------------- |
| `src/args.rs`            |          6 |                  6 |      4 | 10 of 10                                                   |
| `src/commands.rs`        |          2 |                  2 |      2 | 4 of 4                                                     |
| `src/commands/init.rs`   |          1 |                  1 |      1 | 2 of 2                                                     |
| `src/commands/status.rs` |          3 |                  3 |      1 | 4 of 4                                                     |
| `src/term.rs`            |          1 |                  1 |      0 | 1 of 1                                                     |
| `src/ui.rs`              |          2 |                  2 |      2 | 4 of 4                                                     |
| `tests/cli.rs`           |         28 |                 28 |      7 | 35 of 35                                                   |
| **Total**                |     **43** |             **43** | **17** | **60 of 60**                                               |

The suite also passes against the JIT build (60 of 60). With no binary
built it runs the sources under Bun, where the seven tests that need a
built slopmax (a background proxy, `env`, `--` as argv) are skipped; see
`test/NOT-PORTED.md`. The added tests: exact usage-error and help layouts,
option edge cases, `FromStr` errors, color codes and character widths, the
table's column layout, the hidden `app-host`, `run`'s terminal and exit
code, the colors at a terminal and under `NO_COLOR`, a secret typed at a
pty, and a bare `slopmax` at a pty starting the setup.

Beyond the tests, the TS binary and the Rust one were run side by side on
over a hundred command lines and scenarios (every help page, every error the
parser and the commands give, imports, status tables over seeded
`state.json`, usage over a seeded ledger and `windows.jsonl`, setup runs,
keys, config changes, the background proxy, and colored output at a pty):
stdout, stderr, and exit codes match byte for byte, but for timestamps
(milliseconds, as DECISIONS.md settles) and random keys and ids.

## Deviations from the Rust

- **`slopmax run`** spawns the agent with this process's terminal, forwards
  SIGINT, SIGTERM, and SIGHUP, and exits with its code (the core's
  `agent.run`), where Rust `exec`s. The CLI never reads stdin on that path,
  so the agent has it to itself.
- **Secrets at a terminal** are read with stdin in raw mode, since Bun has no
  termios: Enter ends the line, Backspace and Ctrl-U edit it, arrow keys and
  other escape sequences are dropped, Ctrl-D on an empty line ends input,
  and Ctrl-C (which raw mode no longer turns into a signal) restores the
  terminal and raises SIGINT. Rust turns only echo off and lets the terminal
  edit the line. A line typed before the prompt is the answer in both.
- **One stdin reader** is the `Terminal` service's: started on first use
  (never for `run`, `serve`, or `app-host`), it splits stdin into lines in an
  Effect `Queue`; a sign-in's pastes are a second queue fed from it by a
  fiber that lives as long as the sign-in's scope. A piped secret reads the
  rest of stdin whole (`Bun.stdin.text()`), or, if questions already started
  the reader, its remaining lines joined by `\n`.
- **`--args` and other long names of a trailing list** (`run --args`): Rust
  finds the `Rest` argument by name and panics (`unreachable!`); the port
  reports `unexpected argument '--args'` with exit 2.
- **A defect** (a bug) prints `slopmax panicked: {cause}` and exits 101, as
  a Rust panic exits 101.
- **`serve`** resets the JIT policy before the daemon starts, not once its
  listener is up as RUNTIME.md describes, because the core's `daemon.run`
  owns the listener; startup code before that point runs with the normal
  JIT. No effect in the AOT build.
- **From source** (`bun src/main.ts`), Bun takes a first `--` out of argv,
  and the program is Bun, so `env`, `start`, `run`, `dashboard`, and setup's
  Background step fail with `locating the slopmax binary`. The built binary
  behaves as the Rust's.
- **`logs`** finds the log with `stat` and reads ranges of it by offset;
  Rust opens it once and seeks. The output is the same, including a log
  truncated or replaced while followed.
- **Help column widths** are measured in UTF-8 bytes and padded in
  characters, as the Rust's `len()` and `{:width$}` do (the same for the
  ASCII the table holds).
- **The bench mock** answers through `Bun.serve` directly rather than
  `@slopmax/net`'s server, so the mock costs as little as it can; paths,
  headers, bodies, and one SSE frame per chunk are the Rust mock's. Its
  credit dates have millisecond precision.
- **Errors from the core that are not `Failure`s** (`IoError`, `HttpError`,
  `RefreshError`) become `Failure`s with their message, which already holds
  their causes, so `{e:#}` reads the same.

## Left for later

- macOS: the keychain branch of `import` and `open` for the dashboard are
  asserted only on macOS (as in the Rust) and were not run here.
- Releases: AOT builds for the host only, so the macOS assets come from
  macOS CI; `install.sh` names Linux assets `unknown-linux-musl`, which for
  the TS binary means a `--target=bun-linux-*-musl` JIT build (or a glibc
  build under another name with `install.sh` changed in step).
  `scripts/package.sh` makes the archive and checksum for whatever
  `dist/slopmax` holds.
- DIST-004's budgets for the TS build (dependency count, binary size) and
  the CI jobs that keep them are not set up yet.
- `--bytecode-order` profiles are recorded at build time on the build
  machine; CI should run `scripts/compile-jit.sh` as it is.

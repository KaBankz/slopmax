# Rust tests not ported

None. All 43 Rust tests of `crates/slopmax` are ported with their Rust
names and pass:

| Rust file                | Tests | TypeScript                     |
| ------------------------ | ----: | ------------------------------ |
| `src/args.rs`            |     6 | `test/args.test.ts`            |
| `src/commands.rs`        |     2 | `test/commands.test.ts`        |
| `src/commands/init.rs`   |     1 | `test/commands/init.test.ts`   |
| `src/commands/status.rs` |     3 | `test/commands/status.test.ts` |
| `src/term.rs`            |     1 | `test/term.test.ts`            |
| `src/ui.rs`              |     2 | `test/ui.test.ts`              |
| `tests/cli.rs`           |    28 | `test/cli.test.ts`             |

## Tests that need the built binary

`test/cli.test.ts` runs `SLOPMAX_BIN`, else `dist/slopmax` (`bun run
compile` or `bun run compile:jit`), else the sources under Bun. Run from
source, the program is Bun, which cannot start `slopmax serve` in the
background or print `env`'s path to itself (the core's
`background.currentExe` fails with `locating the slopmax binary`), so these
five are skipped there and pass against either build:
`env_prints_shell_setup_for_each_agent`,
`the_background_proxy_starts_reports_and_stops`,
`unattended_setup_imports_routes_wires_and_starts_the_proxy`,
`unattended_setup_leaves_alone_an_agent_it_has_no_account_for`,
`unattended_setup_that_misses_part_of_what_was_asked_says_so` (and two of
the added tests, `run_hands_the_agent_the_terminal_and_returns_its_code` and
`a_first_argument_of_dashes_is_an_unexpected_argument`).

## macOS-only assertions

`import_brings_over_codex_and_cliproxyapi_logins` (the keychain stub) and
`the_background_proxy_starts_reports_and_stops` (`open` for the dashboard)
assert their macOS branches only on macOS, as the Rust does; on Linux they
check the rest.

## Behavior left out on purpose

- **CLI-010, the `mimalloc` feature.** It only swaps Rust's allocator; Bun
  has its own. Nothing to port.
- **CLI-082/CLI-215, `run` replacing the process.** Neither Bun nor Node
  can `exec`. The core's `agent.run` spawns the agent with this process's
  terminal, passes SIGINT, SIGTERM, and SIGHUP on, and returns its exit
  status (128 + the signal when one ended it), which becomes slopmax's. The
  added `run_hands_the_agent_the_terminal_and_returns_its_code` covers
  stdin, the arguments, and the code; signal forwarding was checked by hand
  under a pty (a SIGTERM reached the agent, whose code came back).
- **CLI-197, echo off through termios.** Bun has no termios; the secret is
  read with the terminal in raw mode instead (see PORT.md). The added
  `secrets_are_typed_without_echo_at_a_terminal` runs `login xai` in a pty:
  nothing typed shows and Backspace edits the key. Ctrl-C at the prompt
  (raw mode turns the terminal's own handling off) was checked by hand: it
  restores the terminal and ends slopmax by SIGINT.

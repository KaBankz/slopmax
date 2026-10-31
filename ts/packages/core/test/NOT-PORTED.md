# Rust tests not ported

## Chunk A (foundation)

None. All 88 tests of chunk A's Rust files are ported with their Rust names
and pass:

| Rust file             | Tests | TypeScript                   |
| --------------------- | ----: | ---------------------------- |
| `paths.rs`            |     0 | `test/paths.test.ts`         |
| `fsx.rs`              |     3 | `test/fsx.test.ts`           |
| `testkit.rs`          |     1 | `test/testkit.test.ts`       |
| `config.rs`           |     9 | `test/config.test.ts`        |
| `limits.rs`           |     5 | `test/limits.test.ts`        |
| `account.rs`          |     5 | `test/account.test.ts`       |
| `usage.rs`            |     8 | `test/usage.test.ts`         |
| `pricing.rs`          |     6 | `test/pricing.test.ts`       |
| `waste.rs`            |     3 | `test/waste.test.ts`         |
| `ledger.rs`           |     1 | `test/ledger.test.ts`        |
| `provider/mod.rs`     |     7 | `test/provider/mod.test.ts`  |
| `provider/credits.rs` |     0 | (covered by `provider/mod`)  |
| `agent/mod.rs`        |     4 | `test/agent/mod.test.ts`     |
| `auth/mod.rs`         |    19 | `test/auth/mod.test.ts`      |
| `auth/callback.rs`    |    10 | `test/auth/callback.test.ts` |
| `auth/jwt.rs`         |     2 | `test/auth/jwt.test.ts`      |
| `auth/pkce.rs`        |     2 | `test/auth/pkce.test.ts`     |
| `proxy/rawjson.rs`    |     3 | `test/proxy/rawjson.test.ts` |

## Chunk B (providers, agents, import)

None. All 97 tests of chunk B's Rust files are ported with their Rust names
and pass:

| Rust file                    | Tests | TypeScript                             |
| ---------------------------- | ----: | -------------------------------------- |
| `provider/claude/mod.rs`     |     7 | `test/provider/claude/mod.test.ts`     |
| `provider/claude/oauth.rs`   |    11 | `test/provider/claude/oauth.test.ts`   |
| `provider/claude/wire.rs`    |     3 | `test/provider/claude/wire.test.ts`    |
| `provider/claude/limits.rs`  |     7 | `test/provider/claude/limits.test.ts`  |
| `provider/claude/credits.rs` |     8 | `test/provider/claude/credits.test.ts` |
| `provider/codex/mod.rs`      |     7 | `test/provider/codex/mod.test.ts`      |
| `provider/codex/oauth.rs`    |     9 | `test/provider/codex/oauth.test.ts`    |
| `provider/codex/wire.rs`     |     3 | `test/provider/codex/wire.test.ts`     |
| `provider/codex/limits.rs`   |     6 | `test/provider/codex/limits.test.ts`   |
| `provider/codex/credits.rs`  |     2 | `test/provider/codex/credits.test.ts`  |
| `provider/keys.rs`           |     9 | `test/provider/keys.test.ts`           |
| `provider/compat.rs`         |     7 | `test/provider/compat.test.ts`         |
| `agent/claude_code.rs`       |    10 | `test/agent/claude-code.test.ts`       |
| `agent/codex.rs`             |     7 | `test/agent/codex.test.ts`             |
| `import.rs`                  |     1 | `test/import.test.ts`                  |

The stand-ins chunk A and C used until these modules were ported are gone:
`auth/mod.rs`'s and `usage.rs`'s tests run against the real Claude and
compatible-endpoint providers, `agent/mod.rs`'s
`setup_edits_a_symlinked_config_in_place` against the real
`ClaudeCode.setup`, and the route and report tests against the real
`provider/compat.ts` (`test/support/compat.ts` is deleted).
`test/agent/mod.test.ts` keeps a recording agent for its own tests of the
shared backup handling, which are about `agent/mod.ts`, not Claude Code.

## Tests that run differently

- `config.rs` `processes_started_together_agree_on_the_key` runs its eight
  loads as concurrent fibers (each opens the lock file itself, so they
  contend as threads do in Rust) and also as four separate Bun processes.
- `fsx.rs` `new_directories_are_private` and
  `write_private_round_trips_and_restricts_permissions` check Unix modes; the
  engine runs on Linux and macOS only (DECISIONS.md), so there is no Windows
  branch.
- AGT-024: Claude Code's macOS keychain login is read with `security`
  through `proc.output`, as the Rust runs it with `Command::output`; only
  the Linux path (`.credentials.json`) runs in these tests.

## Behavior left out on purpose

- AGT-008: `agent.run` cannot replace the process (`exec`) on Bun. It
  spawns the agent with this process's terminal, forwards SIGINT, SIGTERM,
  and SIGHUP, and returns its exit code (128 + the signal when one ended
  it), as DECISIONS.md settles for `slopmax run`.

## Chunk C (placement and reporting)

None left out. All 68 tests of chunk C's Rust files are ported with their
Rust names:

| Rust file       | Tests | TypeScript                |
| --------------- | ----: | ------------------------- |
| `pool.rs`       |    21 | `test/pool.test.ts`       |
| `route.rs`      |     4 | `test/route.test.ts`      |
| `notify.rs`     |     5 | `test/notify.test.ts`     |
| `report.rs`     |    12 | `test/report.test.ts`     |
| `service.rs`    |     7 | `test/service.test.ts`    |
| `background.rs` |     8 | `test/background.test.ts` |
| `summary.rs`    |     3 | `test/summary.test.ts`    |
| `history.rs`    |     8 | `test/history.test.ts`    |

- `service.rs` `lingering_is_a_linux_question` is compiled only off Linux
  in the Rust (`#[cfg(not(target_os = "linux"))]`); here it is
  `test.skipIf(process.platform === "linux")`, so it runs on macOS.
  `slopmax_no_service_hides_the_manager` checks the Linux-independent part
  (no `USER`, no answer) everywhere.
- `route.rs` and `report.rs` tests that use compatible endpoints ran on
  `test/support/compat.ts` until chunk B ported `provider/compat.ts`; they
  now run on the real provider.
- POOL-037 (a poisoned mutex stays usable) has nothing to test: the pool
  holds no lock that a failure could poison.

## Chunk D1 (the proxy hot path and the daemon)

None left out. All 70 tests of chunk D1's Rust files are ported with their
Rust names:

| Rust file              | Tests | TypeScript                                                      |
| ---------------------- | ----: | --------------------------------------------------------------- |
| `proxy/mod.rs`         |     4 | `test/proxy/mod.test.ts`                                        |
| `proxy/forward.rs`     |     5 | `test/proxy/forward.test.ts`                                    |
| `proxy/models.rs`      |     1 | `test/proxy/models.test.ts`                                     |
| `proxy/socket.rs`      |     3 | `test/proxy/socket.test.ts`                                     |
| `proxy/sse.rs`         |     5 | `test/proxy/sse.test.ts`                                        |
| `proxy/start.rs`       |     3 | `test/proxy/start.test.ts`                                      |
| `proxy/transcode.rs`   |     2 | `test/proxy/transcode.test.ts`                                  |
| `tests/proxy.rs`       |    38 | `test/integration/proxy.test.ts`                                |
| `tests/failover.rs`    |     9 | `test/integration/failover.test.ts`                             |
| `daemon.rs`, `warm.rs` |     0 | (`test/daemon.test.ts`, `idle_chatgpt_windows_are_warmed_once`) |

- Eight `tests/proxy.rs` tests go through slopmax's own API
  (`/slopmax/*`) or the CLIProxyAPI-compatible one (`/v0/management/*`),
  which chunk D2 ports: `claude_limit_resets_are_listed_and_spent_as_claude_code`,
  `credits_are_listed_kept_and_redeemed_soonest_first`,
  `the_dashboard_api_reports_acts_and_streams`,
  `hub_clients_read_usage_and_redeem_credits_without_a_relay`,
  `settings_change_through_the_api_and_apply_at_once`,
  `the_history_api_charts_what_went_through`,
  `history_says_what_resets_left_on_the_table`, and
  `the_api_does_what_the_cli_does_for_keys_endpoints_and_the_doctor`.
  They are written in full and, with D2 in, run and pass, as does the
  last clause of `client_keys_are_held_to_their_models` (a client key
  gets 401 from `/slopmax/status`).
- WS-012 "a ping from the client is answered with a pong": Bun frames the
  client's side of the relay and answers pings itself, so they never reach
  the relay (whose own pong would be a second one). The relay keeps the
  Rust's branch for them; NET-041/042's tests in `@slopmax/net` check
  Bun's answer.

## Chunk D2 (admin, hub, dashboard, doctor)

None left out. All 18 tests of chunk D2's Rust files are ported with their
Rust names and pass:

| Rust file        | Tests | TypeScript                                  |
| ---------------- | ----: | ------------------------------------------- |
| `proxy/hub.rs`   |     1 | `test/proxy/hub.test.ts`                    |
| `doctor.rs`      |    17 | `test/doctor.test.ts`                       |
| `proxy/admin.rs` |     0 | `test/proxy/admin.test.ts` (endpoint tests) |

- The eight `tests/proxy.rs` tests that waited on `/slopmax/*` and
  `/v0/management/*` (listed under chunk D1) now run and pass, and
  `client_keys_are_held_to_their_models` checks its last clause.
- `doctor.rs`'s tests run against Effects (`it.live`, real time and
  sockets): the proxy checks against a stand-in on a throwaway port or a
  port just freed, the CLIProxyAPI check against a throwaway listener or a
  freed port. Nothing binds or connects to 8317; the API's doctor test
  has no account following CLIProxyAPI, so its check is skipped.
- `account_files_others_can_read_are_flagged` is `#[cfg(unix)]` in the
  Rust; the engine runs on Linux and macOS only, so it always runs.
- ADM-012's keepalive (`: keepalive` after 15 s without an answered
  request) is not tested: the feed runs on the server's real clock.
  `test/proxy/admin.test.ts` checks the feed's headers, its
  `: connected` line, the `data:` frame of a broadcast entry, and that
  the subscription is released when the client goes.

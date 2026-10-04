# Changelog

Every version has a signed tag and a GitHub release, whose notes come from this file.

## [Unreleased]

### Added

- Agents see the pool's usage instead of the serving account's. Codex's `x-codex-*` headers and `codex.rate_limits` socket events, and Claude's `anthropic-ratelimit-unified-*` headers, report each window's average use across the provider's working accounts and the soonest reset. `slopmax status` and the dashboard show the pool as a row of its own.
- The log notes when a session moves to another account.
- CLIProxyAPI's management calls for quota tools (`auth-files`, `api-call`, `reset-quota` under `/v0/management/`), so apps such as T3 Code can show every pooled account's usage and redeem reset credits. `api-call` answers only those tools' usage and reset-credit calls, and never relays a request with an account's token.
- `/slopmax/status` reports each provider's pool, and the dashboard and `slopmax status` draw their pool rows from it.
- `mise run bench` measures what the proxy adds to a request (latency, throughput, memory) against a local mock provider, and how fast slopmax starts.
- A `mimalloc` build feature for proxies that many clients share: more throughput under many concurrent streams, for a few times the memory. The Docker image uses it.

### Changed

- Large requests cost less: slopmax reads a request body only as far as the values it needs, and finds the ends of strings with SIMD search. The stream tap finds lines and keywords the same way and no longer copies most lines. A 300 KB Claude Code request now takes about 2 ms through the proxy instead of 3.5 ms, and throughput on large requests doubled.
- `slopmax status`, `run`, and the other commands that only talk to the local proxy start about 15 ms sooner (2 ms instead of 18): they no longer load the system's trusted certificates.

### Fixed

- Streamed answers reach the agent as they arrive. The proxy's own connections now set `TCP_NODELAY`; without it, small writes waited for the agent to acknowledge the previous one, which added about 40 ms to every response.
- Only reset credits for Codex's own windows (`codex_rate_limits`) are counted and redeemed. A credit of another kind could be spent on Codex's windows, which it does not reset.

## [0.2.0] - 2026-10-04

A rebuild on a lean stack, with providers and agents behind registries.

### Added

- `slopmax init`, a guided setup: imports, sign-ins, wiring Claude Code and Codex, and starting at login. A bare `slopmax` runs it when there are no accounts.
- `slopmax doctor`, which checks the setup end to end and names the fix for each finding.
- `slopmax service install|uninstall|status`: a systemd user unit or a launchd agent.
- Linked imports from CLIProxyAPI. slopmax adopts the tokens CLIProxyAPI rotates and never refreshes them itself, so both proxies can run during a switch-over. `slopmax own` hands refreshing to slopmax.
- Codex's WebSocket transport, relayed to ChatGPT on the session's account.
- Failover when a Codex stream opens with a refusal inside a 200 response.
- A usage ledger, and `slopmax usage` with API-equivalent cost.
- Notifications by webhook or command when accounts are limited, recover, or need signing in again.
- An admin API under `/slopmax/` and an embedded dashboard (`slopmax dashboard`).
- Client keys (`[[keys]]`, `slopmax key`), `slopmax logs`, and `slopmax completions`.
- Routing by model to API keys (Anthropic, OpenAI, xAI) and to OpenAI- or Anthropic-compatible endpoints, with aliases, fallbacks, selectors, and opt-in paid overflow.
- Translation between Messages, Responses, and Chat: Claude Code on GPT models through ChatGPT, Chat clients on ChatGPT, and Codex on Chat-only APIs, with Codex's remote compaction emulated. `/v1/models` lists what the accounts serve.
- Opt-in warming of idle ChatGPT windows (`warm_windows`).
- Upstream HTTP CONNECT and SOCKS5 proxies.
- CI, release builds (static Linux and macOS, x86_64 and aarch64), `install.sh`, and a Dockerfile.

### Changed

- Claude Code requests reach Anthropic as Claude Code sent them, apart from the account's token and the OAuth beta flag. 0.1.0's per-account rewriting of `metadata.user_id` and the billing-header checksum is gone.
- Claude accounts serve Claude Code only.
- Built on hyper and rustls, with in-house time, logging, command-line, and form code: 64 crates instead of about 150, and a binary under 6 MB instead of 7.0 MB.
- Session bindings survive their account being blocked, and restarts.

### Fixed

- A fast-mode refusal that needs usage credits no longer benches every account in turn.
- Token usage is counted for non-streaming responses.
- slopmax creates its directories private (0700).

## [0.1.0] - 2026-10-04

The first version.

- Pools Claude and ChatGPT subscriptions behind one local proxy for Claude Code and Codex. A session stays on its account until that account is spent, then moves on before the agent sees an error.
- New sessions go to the quota that resets soonest (`reset-first`), or by `fill-first` or `least-used`, within priority tiers. `slopmax use` prefers one account.
- Signs in with each provider's OAuth flow (browser or device code), or imports logins from Claude Code, Codex, and CLIProxyAPI.
- Tracks 5-hour and weekly windows from the usage APIs and from response headers, shown by `slopmax status`.
- Redeems ChatGPT reset credits on request, before they expire, and optionally when every account is spent.
- `slopmax run`, `env`, and `setup` (with `--undo`) connect Claude Code and Codex.
- Adapted Claude requests to the serving account (`metadata.user_id` and the billing-header checksum). 0.2.0 removed this.

[Unreleased]: https://github.com/KaBankz/slopmax/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/KaBankz/slopmax/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/KaBankz/slopmax/releases/tag/v0.1.0

# Changelog

Every version has a signed tag and a GitHub release, whose notes come from this file. Versions follow [Semantic Versioning](https://semver.org): a minor release adds features, a patch release only fixes. Before 1.0, a minor release may also change something you rely on, and its notes say what.

## [Unreleased]

### Added

- Claude's limit resets, such as the one Pro and Max accounts got at Claude Opus 5.5's launch, are listed and redeemed as ChatGPT's are: on request (`slopmax redeem`), in the last three hours before one would expire unused, and when every Claude account is spent (`redeem_when_exhausted`). Claude lists and spends them for Claude Code alone, so slopmax makes those two calls with the user agent Claude Code last sent through it, and neither before Claude Code has sent a request.
- The dashboard's API can rename (`/slopmax/accounts/<id>/label`) and remove (`…/remove`) accounts, and `POST /slopmax/sync` applies changes made on disk at once instead of at the proxy's next check.
- A `round-robin` strategy hands each new session to the account handed one longest ago. An agent's housekeeping, such as Claude Code listing models before a session, takes no turn.
- `session_affinity = false` places every request by the strategy, for load balancing at the cost of the prompt cache. A request can decide for itself with the header `x-slopmax-affinity: on` or `off`. The session's last account is still remembered, so state another account minted is dropped when a request lands elsewhere. slopmax's own `x-slopmax-*` headers never reach a provider.
- A passing server error (500, 502, 503, 504, or 529) is retried once on the same account, keeping the session's cache, before it reaches the client.
- The proxy applies a changed config.toml without a restart; only the address needs one. Background tasks such as polling and redeeming read the config each time they run.
- `GET` and `POST /slopmax/settings` read and change the strategy, session affinity, and the redeem settings while the proxy runs, keeping config.toml's comments. `GET /slopmax/history` serves the same usage analytics the desktop app charts: tokens, cost, failovers, caching, speed, and the split by account, model, and agent.
- API prices for GPT-6 Sol and Luna, so ChatGPT usage is costed beside Claude's.
- `slopmax setup` takes you from nothing to a running proxy: choose the kinds of accounts to pool and sign in or add keys, choose the strategy and session affinity, wire the agents, and start the proxy at login. With `--yes`, or without a terminal, it asks nothing and takes flags instead (`--import`, `--login`, `--keys-from-env`, `--strategy`, `--affinity`, `--agents`, `--no-service`), so an agent or a script can run it. `slopmax init` is its alias, and `slopmax setup <agent>` still wires one agent.
- `slopmax config` lists the settings that apply while the proxy runs, shows one, or changes one and has the proxy apply it at once.
- Left on the table: slopmax notes each window that resets with how much of it was used, and values the unused part of each week at the plan's price (list prices, or `[plan_prices]`). `slopmax usage`, the dashboard, and the app show it by account.
- Two notifications, on by default: `reset-expiring`, a limit reset lapsing within the day that slopmax won't redeem by itself, and `quota-unused`, a week resetting within the day with a quarter or more unused. `slopmax status`, the dashboard, and the app list them, and the app posts them.
- Each pool says where a new session would go and why (`slopmax status`, `/slopmax/status`), and shows its model-scoped windows, such as a weekly Fable cap.

### Changed

- Reset credits are now called limit resets, as claude.ai calls Claude's; on Claude, credits are money.
- The dashboard counts an account's limit resets as listed, and offers Redeem on any account that holds one, not just ChatGPT's.
- The source is a Cargo workspace: the `slopmax` CLI on top of `slopmax-core`, the engine it shares with the coming desktop app, and three small libraries beneath. Installing from source now names the package: `cargo install --locked --git https://github.com/KaBankz/slopmax slopmax`.
- Removing an account through the dashboard's API also drops its pin, as `slopmax remove` does.
- Without a running proxy, `slopmax status --refresh` shows a failed usage poll as the account's last error instead of a warning line above the table.
- The page the browser lands on after signing in says to return to slopmax, not to the terminal.

### Fixed

- When several slopmax processes started at once on a fresh home, each could write its own `api_key`, leaving a proxy with a key no client had.
- A request no longer tries an account whose sign-in another process found revoked, before the proxy reloads its accounts.
- A browser sign-in that could neither receive the callback nor read a pasted address now fails at once instead of waiting 10 minutes.
- A demo (`mise run demo`) can no longer install the real login service; `SLOPMAX_NO_SERVICE` hides the service manager.
- In `slopmax init`, the answer to the question after a browser sign-in could be swallowed by input the sign-in kept waiting for.

## [0.3.0] - 2026-10-04

Agents and quota tools such as T3 Code see the pool as one account, and requests pass through the proxy much faster.

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

[Unreleased]: https://github.com/KaBankz/slopmax/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/KaBankz/slopmax/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/KaBankz/slopmax/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/KaBankz/slopmax/releases/tag/v0.1.0

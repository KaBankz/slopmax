<img src="assets/icon.svg" width="64" height="64" alt="">

# slopmax

Created in [T3 Code](https://t3.codes).

slopmax pools your Claude and ChatGPT subscriptions behind one local proxy, so Claude Code and Codex keep working when an account runs out. Each session stays on one account until that account is spent, then moves to the next. New sessions go to the quota that resets soonest, so less of it goes unused.

- One Rust binary. No runtime, database, or browser extension.
- Signs in with each provider's own OAuth flow, or imports logins from Claude Code, Codex, and CLIProxyAPI.
- Tracks every account's 5-hour and weekly windows, from the usage APIs and from the headers on every response.
- Fails over before the agent sees an error, and streams every response back as it arrives.
- Redeems ChatGPT reset credits on request, and before they expire unused.

## Install

```sh
cargo install --locked --git https://github.com/KaBankz/slopmax
```

From a checkout, [mise](https://mise.jdx.dev) provides the toolchain (Rust 1.89 or newer):

```sh
mise install
mise run install    # cargo install --path . --locked
```

## Quick start

```sh
slopmax login claude    # opens the sign-in page; repeat for each account
slopmax login codex     # --device signs in with a code instead
slopmax import          # or copy logins from Claude Code, Codex, and CLIProxyAPI

slopmax run claude      # Claude Code through the pool (starts the proxy if needed)
slopmax run codex       # Codex through the pool
slopmax                 # every account's usage and status
```

## Status

```
CLAUDE                PLAN       5H                      WEEK                    STATUS
 1 work@example.com   max 20x    ████░░░░░░  43% 3h19m   █████░░░░░  49% 1d23h   ● active · 2 sessions · 41 req · 1.2M tok
   └ 7d Fable                                            ██████░░░░  58% 1d23h
 2 home@example.com   max 5x     ██████████ 100% 1h02m   ███████░░░  71% 4d2h    limited · back in 1h02m
 3 team@example.com   team       ░░░░░░░░░░   0%         ░░░░░░░░░░   0%         ready · priority -1

CODEX                 PLAN       5H                      WEEK                    STATUS
 4 me@example.com     pro        █░░░░░░░░░  12% 4h10m   ███░░░░░░░  29% 5d17h   ● active · 1 session · 3 reset credits · 9 req · 310.4k tok

strategy reset-first · proxy running
```

Each window shows how much is used and when it resets. Limits scoped to one model, such as a weekly cap on a Claude model, are listed under their account. `--watch` keeps the display updated, `--refresh` polls the providers first, and `--json` prints the report for scripts.

## Connecting agents

|                                 | Claude Code                                         | Codex                                                      |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `slopmax run <agent> [args…]`   | runs `claude` with the proxy's environment          | runs `codex` with `-c` overrides for a slopmax provider    |
| `eval "$(slopmax env <agent>)"` | exports that environment in the current shell       | defines a `codex` function that goes through `slopmax run` |
| `slopmax setup <agent>`         | writes the `env` block of `~/.claude/settings.json` | adds and selects a provider in `~/.codex/config.toml`      |

`slopmax setup <agent> --undo` puts back exactly what setup replaced. The edited file then holds the slopmax key, so setup keeps it private (mode 0600).

- **Claude Code** gets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, the slopmax key. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` lets them win over `settings.json`, and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` fills `/model` with the account's models.
- **Codex** gets a custom model provider at `http://127.0.0.1:7567/codex` with `wire_api = "responses"`. It is named `OpenAI`, so Codex keeps first-party behavior such as remote compaction.

Other clients can use the proxy directly. `/claude/*` and `/codex/*` map to the two providers, and bare `/v1/*` paths are routed by shape (`/v1/messages` to Claude, `/v1/responses` to Codex). Authenticate with `api_key` from the config, as a bearer token or `x-api-key`.

## How it works

### Accounts

`slopmax login` runs the same OAuth flow as the official client: PKCE with a localhost callback, or a device code for Codex. Each account is a private JSON file in `~/.slopmax/accounts/`, named after a hash of the account's identity, so signing in again or re-importing updates the account instead of adding a copy. `slopmax import` reads Claude Code's `~/.claude/.credentials.json` (or the macOS keychain), Codex's `~/.codex/auth.json`, and CLIProxyAPI's `~/.cli-proxy-api/*.json`, keeping CLIProxyAPI's priorities and device ids.

The proxy refreshes tokens ahead of expiry: an hour early for Claude, a day for Codex. Refreshes happen under a file lock, so the proxy and a CLI command never spend the same refresh token twice. When a provider rejects a refresh, the account is flagged for re-login and leaves the rotation.

### Usage

Every response carries rate-limit headers (`anthropic-ratelimit-unified-*`, `x-codex-*`), and slopmax updates the serving account's windows from them as requests flow. The proxy also polls each account's usage endpoint every `poll_mins` minutes and right after a window resets. While an account is blocked it polls every 10 minutes, because quota often comes back before the stated reset.

### Switching

Each request names its session: Claude Code's session id, or Codex's `session-id`. A session stays on its account for as long as that account can serve it, which keeps prompt caches warm. It moves only when the account refuses, fills up, or signs out, and it is forgotten after `session_ttl_mins` idle minutes. A new session goes to the account chosen with `slopmax use`, if that one can serve. Otherwise it goes to the highest priority tier, and within the tier the strategy decides.

When the provider refuses a request (a rejected 5-hour or weekly window, `usage_limit_reached`, an invalid token), slopmax sets that account aside, until its reset when its quota is spent, and retries on the next one. This happens only before the agent has received anything; once a response starts streaming, it passes through untouched. When every account is spent, the agent gets its own native usage-limit error with the earliest reset time, and shows it as usual.

Each request is adapted to the account serving it:

- **Claude.** The account's token replaces the slopmax key and the OAuth beta flag is added. The body's `metadata.user_id` gets the account's device and account ids, and the billing header checksum is recomputed. Everything else stays byte for byte as Claude Code sent it.
- **Codex.** The account's token and workspace id are set. Encrypted reasoning items and `previous_response_id` only work on the account that created them, so they are dropped when a session moves, along with Codex's sticky routing header.

### Resets

Unused quota is lost when its window resets. The default `reset-first` strategy therefore puts new sessions on the account whose started window resets soonest, earliest deadline first, and saves fresh windows for later. `fill-first` drains accounts in priority order instead, and `least-used` spreads sessions across the least used accounts. A block lasts until the provider's stated reset, unless a fresh reading shows room sooner.

ChatGPT accounts can hold reset credits, which reset an account's windows on the spot. slopmax redeems them:

- on request, with `slopmax redeem <account>`;
- in the last three hours before one would expire unused, if the account has usage to reset (`redeem_expiring_credits`, on by default);
- when every Codex account is spent, then retries the request on the reset account (`redeem_when_exhausted`, off by default).

## Commands

| Command                             | Description                                                            |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `slopmax [status]`                  | Accounts, usage windows, and resets (`--watch`, `--refresh`, `--json`) |
| `slopmax login <claude\|codex>`     | Connect an account (`--label`, `--device`, `--no-browser`)             |
| `slopmax import [source]`           | Copy logins from `claude-code`, `codex`, `cliproxyapi`, or `all`       |
| `slopmax use <account\|auto>`       | Prefer an account for new sessions, or let slopmax choose              |
| `slopmax label <account> <name>`    | Rename an account                                                      |
| `slopmax priority <account> <tier>` | Higher tiers are used first; negative tiers hold an account in reserve |
| `slopmax enable\|disable <account>` | Put an account in or take it out of rotation                           |
| `slopmax remove <account>`          | Forget an account                                                      |
| `slopmax redeem <account>`          | Redeem a ChatGPT reset credit (`--yes` skips the prompt)               |
| `slopmax start\|stop`               | Run the proxy in the background, or stop it                            |
| `slopmax serve`                     | Run the proxy in the foreground                                        |
| `slopmax run <agent> [args…]`       | Launch Claude Code or Codex through the proxy                          |
| `slopmax env <agent>`               | Print shell setup for `eval`                                           |
| `slopmax setup <agent> [--undo]`    | Point an agent's own config at the proxy, or restore it                |

`<account>` is the number shown by `slopmax status`, or the account's id, email, or label.

## Configuration

`~/.slopmax/config.toml` is written on first run, with each setting explained. `SLOPMAX_HOME` moves the whole directory.

| Setting                   | Default          | Description                                                     |
| ------------------------- | ---------------- | --------------------------------------------------------------- |
| `listen`                  | `127.0.0.1:7567` | Proxy address                                                   |
| `api_key`                 | generated        | Key agents present to the proxy                                 |
| `strategy`                | `reset-first`    | `reset-first`, `fill-first`, or `least-used`                    |
| `session_ttl_mins`        | `60`             | Idle minutes before a session's account is forgotten            |
| `poll_mins`               | `5`              | Minutes between usage polls per account (`0` turns polling off) |
| `refresh_tokens`          | `true`           | Refresh OAuth tokens before they expire                         |
| `redeem_expiring_credits` | `true`           | Redeem a ChatGPT reset credit before it expires unused          |
| `redeem_when_exhausted`   | `false`          | Redeem one when every Codex account is spent                    |

The background proxy logs to `~/.slopmax/slopmax.log`. `SLOPMAX_LOG` sets the log filter, for example `SLOPMAX_LOG=slopmax=debug`.

## Compared with CLIProxyAPI and opencodex

slopmax was designed after a close read of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and [opencodex](https://github.com/lidge-jun/opencodex). Both pool accounts and do a great deal more. slopmax stays small: two agents, two upstreams, and a scheduler built around reset times.

|                        | slopmax                                            | CLIProxyAPI                                    | opencodex                                              |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| Built with             | Rust, one binary                                   | Go                                             | TypeScript on Bun                                      |
| Scope                  | Claude Code and Codex on subscription logins       | Many providers, translated between API formats | Codex and Claude Code plus other providers, with a GUI |
| Default account choice | The quota that resets soonest                      | Round-robin within priority tiers              | One active account, switching at 80% used              |
| Usage data             | Usage endpoints and response headers               | Response headers, for display                  | Usage endpoint and response headers                    |
| Session stickiness     | Built in                                           | Opt-in                                         | Built in                                               |
| Reset credits          | On request, before expiry, and when spent (opt-in) | —                                              | Before expiry (opt-in), plus Claude reset grants       |

## Caveats

- An imported login shares its refresh token with the tool it came from. Refresh tokens rotate on use, so once one tool refreshes, the other is signed out. Sign in with `slopmax login` for an independent session, or set `refresh_tokens = false` while the other tool still owns the login.
- Claude reset grants are not supported yet; only ChatGPT reset credits are.
- There is no WebSocket transport. Codex learns this on its first attempt and falls back to HTTP streaming.
- Requests go out through rustls, without imitating any client's TLS fingerprint.
- Pooling subscription accounts may conflict with a provider's terms of service. Use slopmax at your own discretion.

## Development

```sh
mise run check    # rustfmt, clippy with warnings denied, and the tests
mise run build    # optimized release binary
```

`tests/proxy.rs` runs the proxy end to end against a mock provider.

## License

[MIT](LICENSE)

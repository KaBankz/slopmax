<img src="assets/icon.svg" width="64" height="64" alt="">

# slopmax

Created in [T3 Code](https://t3.codes).

slopmax pools your Claude and ChatGPT subscriptions behind one local proxy, so Claude Code and Codex keep working when an account runs out. Each session stays on one account until that account is spent, then moves to the next. New sessions go to the quota that resets soonest, so less of it goes unused.

- One Rust binary under 6 MB. No runtime, database, or browser extension.
- Signs in with each provider's own OAuth flow, or takes over logins from Claude Code, Codex, and CLIProxyAPI. A guided `slopmax init` does it all, and `slopmax doctor` says what to fix.
- Tracks every account's 5-hour and weekly windows, from the usage APIs and from the headers on every response.
- Fails over before the agent sees an error, and streams every response back as it arrives.
- Routes by model to API keys (Anthropic, OpenAI, xAI) and to any OpenAI- or Anthropic-compatible endpoint, with aliases and fallbacks.
- Translates between API formats, so Claude Code can run GPT models on your ChatGPT accounts and any OpenAI client can use them.
- Records every request, with `slopmax usage` totals and what they would have cost on the API, and notifies you when accounts need attention.

## Install

On Linux and macOS, the install script fetches the latest release, checks its checksum, and puts `slopmax` in `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/KaBankz/slopmax/main/install.sh | sh
```

Or build it with Cargo (Rust 1.89 or newer):

```sh
cargo install --locked --git https://github.com/KaBankz/slopmax
```

From a checkout, [mise](https://mise.jdx.dev) provides the toolchain: `mise install`, then `mise run install`.

In a container, accounts and settings live in the `/data` volume:

```sh
docker build -t slopmax .
docker run -d --name slopmax -p 127.0.0.1:7567:7567 -v slopmax:/data slopmax
docker exec -it slopmax slopmax login codex --device
```

## Quick start

```sh
slopmax             # the first time, a guided setup
```

`slopmax init` walks through it step by step:

1. It finds the agents you have and the logins they hold, and offers to bring them over. If CLIProxyAPI is running, its logins are linked rather than copied (see [Accounts](#accounts)), so both can run while you switch.
2. It signs you in to more accounts. Without a browser, Codex signs in with a code and Claude by pasting the final URL back.
3. It installs the proxy as a service that starts at login.
4. It points Claude Code and Codex at the proxy, keeping a backup for `--undo`.

Or by hand:

```sh
slopmax login claude    # opens the sign-in page; repeat for each account
slopmax login codex     # --device signs in with a code instead
slopmax setup claude    # point Claude Code (and every app that runs it) at slopmax
slopmax setup codex
slopmax service install # keep the proxy running
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

XAI                   BILLING    MODELS                                          STATUS
 5 xAI API key …x9Qe  per token  grok-*                                          ready

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

- **Claude Code** gets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, the slopmax key. Every app that runs Claude Code reads `~/.claude/settings.json`, so `setup` covers the CLI, the Agent SDK, IDE extensions, and GUI wrappers such as T3 Code, Conductor, Orca, and Superset. The Claude desktop app is the exception: it starts its bundled Claude Code with its own environment, so it cannot be pointed at a proxy.
- **Codex** gets a model provider at `http://127.0.0.1:7567/codex` with `wire_api = "responses"` and `supports_websockets = true`. It is named `OpenAI`, so Codex keeps first-party behavior such as remote compaction. The Codex desktop app reads the same `config.toml`; restart it after `setup`. If it rewrites the file, `slopmax doctor` notices.

Any other client can use the proxy as an OpenAI- or Anthropic-style API at `http://127.0.0.1:7567/v1`, authenticating with `api_key` from the config as a bearer token or `x-api-key`: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, and `/v1/models`.

## Accounts

Each account is a private JSON file in `~/.slopmax/accounts/`, named after a hash of the account's identity, so signing in again or re-importing updates the account instead of adding a copy.

- **Subscriptions.** `slopmax login claude` and `slopmax login codex` run the same OAuth flow as the official clients: PKCE with a localhost callback, a pasted redirect URL on a machine without a browser, or a device code for Codex. The proxy refreshes tokens ahead of expiry (an hour early for Claude, a day for Codex) under a file lock, so no two processes spend the same refresh token. When a provider rejects a refresh, the account is flagged for re-login and leaves the rotation.
- **API keys.** `slopmax login anthropic`, `openai`, or `xai` asks for the key at a hidden prompt, or reads it from stdin (`slopmax login xai < key.txt`), so it never lands in your shell history. It is checked against the provider's model list before it is saved.
- **Compatible endpoints.** `slopmax login compat --url http://localhost:11434/v1` adds any API that speaks OpenAI Chat Completions (the default), Responses (`--dialect responses`), or Anthropic Messages (`--dialect messages`). Its models are read from the endpoint, or named with `--models 'qwen3-*,llama4'`.
- **Imports.** `slopmax import` reads Claude Code's `~/.claude/.credentials.json` (or the macOS keychain), Codex's `~/.codex/auth.json`, and CLIProxyAPI's `~/.cli-proxy-api/*.json`. An imported login shares its refresh token with the tool it came from, and refresh tokens rotate on use, so whichever refreshes first signs the other out. Logins from CLIProxyAPI are therefore *linked*: slopmax follows the file CLIProxyAPI keeps refreshing and never refreshes them itself, so both can run while you switch over. Once CLIProxyAPI is stopped, `slopmax own all` hands refreshing to slopmax.

## Routing

A request's model picks who serves it: every provider with an account that serves the model, subscriptions first. Claude models go to Claude accounts, GPT models to ChatGPT accounts, `grok-*` to xAI keys, and a compatible endpoint's models to it.

- **Paid overflow.** API keys that cover a subscription's models (an OpenAI key behind ChatGPT, an Anthropic key behind Claude) serve those models only when asked for by name, or when you have no such subscription. With `paid_overflow = true` they also take over once every subscription account is limited.
- **Selectors.** A model name can pick a provider or one account: `openai/gpt-6-sol`, `work/gpt-6-sol`.
- **Aliases and fallbacks.** In the config, `[aliases]` renames models and `[fallbacks]` lists models to try once one is limited everywhere:

  ```toml
  [aliases]
  fast = "gpt-6-sol-mini"

  [fallbacks]
  "claude-opus-5-5" = ["gpt-6-sol"]     # Claude Code carries on with GPT
  "gpt-6-sol" = ["openai/gpt-6-sol"]    # then on the API key
  ```

Claude subscriptions and Anthropic keys serve Claude Code only: Anthropic allows subscription logins in Claude Code alone, and slopmax applies the same rule to keys. A Claude model requested by any other client is refused with an explanation.

## Translation

When the account a request is routed to speaks another API format, slopmax translates the request and translates the answer back as it streams. Requests in a format the account speaks are forwarded as the client sent them.

| Client                                 | Upstream                                    | For example                                                 |
| -------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| Claude Code (Messages)                 | ChatGPT, OpenAI, xAI, compatible endpoints  | `slopmax run claude --model gpt-6-sol`                      |
| OpenAI clients (Chat Completions)      | ChatGPT accounts                            | Cursor, Open WebUI, scripts using the OpenAI SDK            |
| Codex (Responses)                      | xAI and Chat-only endpoints                 | `slopmax run codex -m grok-4`                               |

Nothing is ever translated into Anthropic's format: Claude models only ever see requests Claude Code wrote.

Running Claude Code on GPT:

```sh
slopmax run claude --model gpt-6-sol
```

or `/model gpt-6-sol` in a running session. Claude Code does not know GPT's context window and assumes 200k tokens; set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the model's real window to use all of it. Background tasks still use your Claude accounts' small model unless you set `ANTHROPIC_DEFAULT_HAIKU_MODEL` too.

What crosses: text, images, documents, tool definitions and calls, tool results, the requested reasoning effort, structured output schemas, and token usage. What does not:

- The model's reasoning is not shown in Claude Code. Claude Code would send it back to Anthropic, which rejects thinking it did not sign. slopmax keeps the upstream's encrypted reasoning itself and restores it on the next turn, for the same account only.
- Anthropic's server tools (web search, code execution) run only on Anthropic and are left out.
- Token counts for translated models are estimates.
- Codex compacts long conversations remotely. A model reached by translation cannot, so slopmax asks it for a summary instead and hands that to Codex as the compacted history.

## How it works

### Usage

Every response carries rate-limit headers (`anthropic-ratelimit-unified-*`, `x-codex-*`), and slopmax updates the serving account's windows from them as requests flow. The proxy also polls each subscription's usage endpoint every `poll_mins` minutes and right after a window resets. While an account is blocked it polls every 10 minutes, because quota often comes back before the stated reset.

### Switching

Each request names its session: Claude Code's session id, Codex's `session-id`, or for other clients a session header or `prompt_cache_key`. A session stays on its account for as long as that account can serve it, which keeps prompt caches warm. It moves only when the account refuses, fills up, or signs out, and it is forgotten after `session_ttl_mins` idle minutes. A new session goes to the account chosen with `slopmax use`, if that one can serve. Otherwise it goes to the highest priority tier, and within the tier the strategy decides.

When the provider refuses a request (a rejected 5-hour or weekly window, `usage_limit_reached`, an invalid token), slopmax sets that account aside, until its reset when its quota is spent, and retries on the next one. ChatGPT sometimes refuses inside a stream that has already started with a 200, so slopmax holds the first moments of a Codex stream back to catch that. Failover happens only before the agent has received anything; once a response starts streaming, it passes through untouched. When every account is spent, the agent gets its own native usage-limit error with the earliest reset time, and shows it as usual.

Codex talks to ChatGPT over a WebSocket when it can, which keeps the conversation warm upstream and starts answers sooner than HTTP streaming. slopmax relays the socket to ChatGPT's own on one account, reading usage from the rate-limit events ChatGPT sends on it. A socket stays on its account; if that account runs out mid-turn, slopmax closes the socket, and Codex retries on a new one that opens on another account. Models that need translation, and `websockets = false`, send Codex back to HTTP streaming.

Each request is adapted to the account serving it, and nothing more:

- **Claude.** The account's token replaces the slopmax key, and the OAuth beta flag that subscription tokens require is added. Nothing else changes: the body, including Claude Code's billing header and `metadata.user_id`, reaches Anthropic byte for byte as Claude Code sent it. slopmax does not imitate Claude Code or alter what it says about itself.
- **Codex.** The account's token and workspace id are set. Encrypted reasoning items and `previous_response_id` only work on the account that created them, so they are dropped when a session moves, along with Codex's sticky routing header.
- **Keys and endpoints.** The key replaces the slopmax key.

### Resets

Unused quota is lost when its window resets. The default `reset-first` strategy therefore puts new sessions on the account whose started window resets soonest, earliest deadline first, and saves fresh windows for later. `fill-first` drains accounts in priority order instead, and `least-used` spreads sessions across the least used accounts. A block lasts until the provider's stated reset, unless a fresh reading shows room sooner.

ChatGPT starts a 5-hour window at an account's first request, so an account left idle after a reset gets its next reset late. With `warm_windows = true`, slopmax sends an idle ChatGPT account one tiny request as soon as its window resets, using the model Codex last used, so the next reset comes sooner when the account is needed. Claude accounts are never warmed: slopmax sends Claude only what Claude Code writes.

ChatGPT accounts can hold reset credits, which reset an account's windows on the spot. slopmax redeems them:

- on request, with `slopmax redeem <account>`;
- in the last three hours before one would expire unused, if the account has usage to reset (`redeem_expiring_credits`, on by default);
- when every Codex account is spent, then retries the request on the reset account (`redeem_when_exhausted`, off by default).

## Usage and cost

Every answered request is recorded in `~/.slopmax/usage/`, one JSON line each in monthly files: the account, model, tokens, latency, and time to first token.

```
$ slopmax usage 7d --by model
MODEL                 REQ     INPUT    OUTPUT  CACHE READ  CACHE WRITE   API COST
claude-opus-5-5       412    310.2k    188.0k      102.4M         2.9M     $39.98
gpt-6-sol              96     88.1k     41.7k       12.0M            0          —
total                 508    398.3k    229.7k      114.4M         2.9M    $39.98+
```

`API cost` is what the same tokens would cost on the pay-as-you-go API, at Anthropic's list prices and any you set under `[prices]` in the config. Requests to models without a price are counted apart and marked `+`. Group `--by day`, `model`, or `account`, over `today`, `7d`, `30d`, or `all`, or print `--json`.

## Dashboard

`slopmax dashboard` opens a page that shows every account's windows and reset countdowns, usage and cost by day, model, or account, and a live feed of answered requests. It can enable, disable, pin, reprioritize, and redeem. The page is one file built into the binary and loads nothing from elsewhere. It takes the slopmax key from its address's `#fragment`, which browsers never send to a server. On a remote machine, forward the port first (`ssh -L 7567:127.0.0.1:7567 host`).

The same data is available as JSON under `/slopmax/` (`status`, `usage`, `events`, `accounts/<id>/<action>`), with the slopmax key.

## Other machines

Set `listen = "0.0.0.0:7567"` to serve your network, and give each machine or tool its own key, so you can revoke them one at a time:

```sh
slopmax key add laptop                    # prints the new key
slopmax key add ci --models 'gpt-*'       # a key limited to some models
slopmax key remove laptop
```

Client keys can use the proxy but not slopmax's own API, and `slopmax doctor` notes when the proxy listens beyond this machine.

## Notifications

A webhook or a command hears when every account of a kind is limited (so requests fail), when it recovers, and when an account needs signing in again. Add `limited` and `available` to `events` to hear about each account too.

```toml
[notify]
webhook = "https://hooks.slack.com/services/…"     # JSON with "text" and "content" for Slack and Discord
command = 'notify-send slopmax "$SLOPMAX_MESSAGE"'  # also gets SLOPMAX_EVENT, _PROVIDER, _ACCOUNT, _UNTIL
```

`slopmax notify` sends a test.

## Commands

| Command                              | Description                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `slopmax [status]`                   | Accounts, usage windows, and resets (`--watch`, `--refresh`, `--json`)        |
| `slopmax init`                       | Guided setup of accounts, agents, and the service (`--yes` takes the defaults) |
| `slopmax login <provider>`           | Sign in, or enter an API key (`--label`; `--device`, `--no-browser`; `--url`, `--dialect`, `--models` for `compat`) |
| `slopmax import [source]`            | Copy logins from `claude-code`, `codex`, `cliproxyapi`, or `all` (`--own`)    |
| `slopmax own <account\|all>`         | Refresh an account slopmax has been following from CLIProxyAPI               |
| `slopmax use <account\|auto>`        | Prefer an account for new sessions, or let slopmax choose                     |
| `slopmax label <account> <name>`     | Rename an account                                                             |
| `slopmax priority <account> <tier>`  | Higher tiers are used first; negative tiers hold an account in reserve        |
| `slopmax enable\|disable <account>`  | Put an account in or take it out of rotation                                  |
| `slopmax remove <account>`           | Forget an account                                                             |
| `slopmax redeem <account>`           | Redeem a ChatGPT reset credit (`--yes` skips the prompt)                      |
| `slopmax service install\|uninstall\|status` | Run the proxy as a systemd user unit or launchd agent                 |
| `slopmax start\|stop`                | Run the proxy in the background (through the service, if installed), or stop it |
| `slopmax serve`                      | Run the proxy in the foreground                                               |
| `slopmax run <agent> [args…]`        | Launch Claude Code or Codex through the proxy                                 |
| `slopmax env <agent>`                | Print shell setup for `eval`                                                  |
| `slopmax setup <agent> [--undo]`     | Point an agent's own config at the proxy, or restore it                       |
| `slopmax usage [range]`              | Token totals and API-equivalent cost (`--by`, `--json`)                       |
| `slopmax dashboard`                  | Open the dashboard in a browser (`--print` shows its address)                 |
| `slopmax logs [-f]`                  | The background proxy's log (`-n` lines, `-f` to follow)                       |
| `slopmax key [list\|add\|remove] [name]` | Keys for other machines and tools (`--models` limits what a key may use)  |
| `slopmax notify`                     | Send a test notification                                                      |
| `slopmax doctor`                     | Check the setup and say how to fix problems                                   |
| `slopmax completions <shell>`        | Print a completion script for bash, zsh, or fish                              |

`<account>` is the number shown by `slopmax status`, or the account's id, email, or label. `<provider>` is `claude`, `codex`, `anthropic`, `openai`, `xai`, or `compat`.

## Configuration

`~/.slopmax/config.toml` is written on first run, with each setting explained. `SLOPMAX_HOME` moves the whole directory.

| Setting                   | Default          | Description                                                         |
| ------------------------- | ---------------- | ------------------------------------------------------------------- |
| `listen`                  | `127.0.0.1:7567` | Proxy address                                                       |
| `api_key`                 | generated        | Key clients present to the proxy                                    |
| `strategy`                | `reset-first`    | `reset-first`, `fill-first`, or `least-used`                        |
| `session_ttl_mins`        | `60`             | Idle minutes before a session's account is forgotten                |
| `poll_mins`               | `5`              | Minutes between usage polls per account (`0` turns polling off)     |
| `refresh_tokens`          | `true`           | Refresh OAuth tokens before they expire                             |
| `redeem_expiring_credits` | `true`           | Redeem a ChatGPT reset credit before it expires unused              |
| `redeem_when_exhausted`   | `false`          | Redeem one when every Codex account is spent                        |
| `websockets`              | `true`           | Relay Codex's WebSockets to ChatGPT's                               |
| `warm_windows`            | `false`          | Start idle ChatGPT accounts' 5-hour windows as soon as they reset   |
| `paid_overflow`           | `false`          | Let API keys take over a subscription's models once it is limited   |
| `proxy`                   | none             | Upstream proxy (`http://`, `socks5://`, `socks5h://`), else `HTTPS_PROXY` |
| `[aliases]`, `[fallbacks]` | none            | Model renames, and models to try once one is limited everywhere     |
| `[prices]`                | none             | API prices for `slopmax usage`, beyond Anthropic's built-in list    |
| `[notify]`                | none             | Webhook, command, and events for notifications                      |
| `[[keys]]`                | none             | Client keys, made with `slopmax key add`, each possibly limited to some models |

The background proxy logs to `~/.slopmax/slopmax.log`. `SLOPMAX_LOG` sets the log level, for example `SLOPMAX_LOG=debug`.

## Compared with CLIProxyAPI and opencodex

slopmax was designed after a close read of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and [opencodex](https://github.com/lidge-jun/opencodex). Both pool accounts and translate between APIs, and both do a great deal more. slopmax aims for the same everyday features in one small binary, with a guided setup and a scheduler built around reset times.

|                        | slopmax                                                        | CLIProxyAPI                                    | opencodex                                              |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| Built with             | Rust, one binary                                               | Go                                             | TypeScript on Bun                                      |
| Setup                  | `slopmax init`, `slopmax doctor`                               | Config file                                    | Desktop app and CLI                                    |
| Default account choice | The quota that resets soonest                                  | Round-robin within priority tiers              | One active account, switching at 80% used              |
| Usage data             | Usage endpoints and response headers                           | Response headers, for display                  | Usage endpoint and response headers                    |
| Session stickiness     | Built in                                                       | Opt-in                                         | Built in                                               |
| Translation            | Through one common form: Messages, Responses, and Chat clients | Pairwise translators between many formats      | Responses-centered, with Claude Code inbound           |
| Claude requests        | From Claude Code only, unchanged but for the credential        | From any client, rewritten to pass as Claude Code | From any client, with Claude Code's identity added   |
| Reset credits          | On request, before expiry, and when spent (opt-in)             | —                                              | Before expiry (opt-in), plus Claude reset grants       |

## Caveats

- Anthropic's terms allow Claude subscription logins in Claude Code only, and pooling subscription accounts may conflict with a provider's terms of service. slopmax serves Claude accounts to Claude Code alone and forwards its requests unchanged, but whether to pool accounts is your call.
- Claude reset grants are not supported; only ChatGPT reset credits are.
- Requests go out through rustls, without imitating any client's TLS fingerprint.

## Development

```sh
mise run check    # rustfmt, clippy with warnings denied, and the tests
mise run build    # optimized release binary
```

`tests/proxy.rs` runs the proxy end to end against mock providers. [ARCHITECTURE.md](ARCHITECTURE.md) maps the code and walks through adding a provider, an agent, or an API format.

## License

[MIT](LICENSE)

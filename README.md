<p align="center">
  <img src="assets/icon/icon.png" width="112" height="112" alt="slopmax">
</p>

<h1 align="center">slopmax</h1>

<p align="center">
  <b>All your Claude, ChatGPT, and Grok subscriptions, pooled into one that never runs out.</b>
</p>

<p align="center">
  <a href="https://github.com/KaBankz/slopmax/releases/latest"><img src="https://img.shields.io/github/v/release/KaBankz/slopmax" alt="Latest release"></a>
  <a href="https://github.com/KaBankz/slopmax/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/KaBankz/slopmax/ci.yml?branch=master&label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/KaBankz/slopmax" alt="MIT license"></a>
</p>

slopmax is a tiny local proxy that sits between your coding agent and your accounts. **Claude Code, Codex, and Grok Build** keep working when an account hits its limit: the next account picks up before the agent sees an error. To the agent, all your accounts look like one big account.

```sh
curl -fsSL https://raw.githubusercontent.com/KaBankz/slopmax/master/install.sh | sh
```

Then run `slopmax setup`, and you're done.

## Why slopmax

- **Failover the agent never sees.** Usage limits, revoked logins, and server errors are retried on the next account before the agent sees an error. Only when every account is spent does the agent get its own limit error, with the earliest reset time.
- **Your prompt cache stays warm.** Each session sticks to one account until that account can't serve it, so cached prompts keep paying off. A conversation that does move, even mid tool call, carries its history with it.
- **Many accounts, one account.** The agent sees the pool's combined usage, so Codex's limit warnings describe all your accounts, not whichever one happened to answer.
- **No quota left unused.** The `reset-first` strategy spends the quota that is about to expire. slopmax can redeem limit resets before they lapse, and shows what the quota you didn't use was worth.
- **Claude Code's requests go through unchanged.** slopmax swaps in the account's credential and the OAuth flag it needs, and never rewrites requests to impersonate Claude Code.
- **One command to set up.** `slopmax setup` brings over the logins Claude Code and Codex already have, signs in to more, connects your agents, and starts the proxy at login. `slopmax doctor` tells you what to fix.
- **See everything.** A terminal UI, a web dashboard, live usage windows for every account, token totals with what they would have cost on the API, and notifications by webhook or command.
- **Use it on every machine.** One hub keeps the accounts, and your other machines reach it [over Tailscale](docs/hub.md), holding no tokens of their own.
- **Updates without downtime.** On Linux and macOS, `slopmax update` hands the listening socket to the new version, and requests already running finish on the old one.
- **Extras.** Run Claude Code on GPT, keep API keys as paid overflow, or add any OpenAI- or Anthropic-compatible endpoint ([models](docs/models.md)).

## Fast and small

|                       |                                                         |
| --------------------- | ------------------------------------------------------- |
| Added latency         | about **1 ms** per request (p50)                        |
| Throughput            | **1,600 requests/s** with 32 at once, on 2 vCPUs        |
| Memory                | about **5 MB** idle                                     |
| Startup               | `slopmax status` in ~2 ms; the proxy serves after 22 ms |
| Install               | **one self-contained binary** (~12 MB): no runtime, no database |

Written in Rust on tokio, hyper, and rustls. `mise run bench` measures it; see [ARCHITECTURE.md](ARCHITECTURE.md#performance) for how.

## At a glance

```
CLAUDE                PLAN       5H                      WEEK                    STATUS
 1 work@example.com   ultra      —                       █████░░░░░  49% 1d23h   ● active · 2 sessions · 41 req · 1.2M tok
 2 home@example.com   max        ██████████ 100% 1h02m   ███████░░░  71% 4d2h    limited · back in 1h02m
 3 team@example.com   team       ░░░░░░░░░░   0%         ░░░░░░░░░░   0%         ready · priority -1
   pool               3 accts    ███░░░░░░░  33% 1h02m   ████░░░░░░  40% 1d23h   what the agents see

CODEX                 PLAN       5H                      WEEK                    STATUS
 4 me@example.com     pro        —                       ███░░░░░░░  29% 5d17h   ● active · 1 session · 9 req · 310.4k tok

strategy reset-first · proxy running
```

## Install

**Linux and macOS:**

```sh
curl -fsSL https://raw.githubusercontent.com/KaBankz/slopmax/master/install.sh | sh
```

It installs to `~/.local/bin`, and says so if that isn't on your `PATH` yet.

**mise:** `mise use -g github:KaBankz/slopmax`

**Windows:** unzip `slopmax-x86_64-pc-windows-msvc.zip` (or `aarch64`) from the [latest release](https://github.com/KaBankz/slopmax/releases/latest) into a folder on your `PATH`.

**Cargo, Docker, and updating:** see [docs/install.md](docs/install.md).

## Quick start

```sh
slopmax setup          # import logins, sign in, connect agents, start the proxy
slopmax                # watch every account in the terminal UI
slopmax dashboard      # or in the browser
```

Prefer doing it by hand?

```sh
slopmax login claude            # repeat for each account; also codex, grok, or an API key
slopmax agent connect claude    # point Claude Code (and every app that runs it) at slopmax
slopmax proxy install           # keep the proxy running from login on
```

Or skip `agent connect` and launch through slopmax: `slopmax run claude`, `slopmax run codex`.

## How slopmax compares

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and [opencodex](https://github.com/lidge-jun/opencodex) also pool accounts behind a local proxy, and both reach many more providers and clients. slopmax does one job: making several subscriptions of one provider feel like a single account to Claude Code, Codex, and Grok Build. It spends quota before it resets, leaves Claude Code's requests as they were sent, and fits in one small binary.

|                        | slopmax                                                                                         | CLIProxyAPI                                                                 | opencodex                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- |
| Built with             | Rust: one binary of about 12 MB, about 5 MB of memory when idle                                 | Go: a 69 MB binary                                                          | TypeScript on Bun, with a desktop app              |
| Setup                  | `slopmax setup` walks through it or runs unattended; `slopmax doctor` checks it                 | A config file and login flags                                               | Desktop app and CLI                                |
| Default account choice | Fill-first, in an order you set; or the used quota that resets soonest, least-used, round-robin | Round-robin or fill-first within priority tiers                             | One active account, switching at 80% used          |
| Usage data             | Usage endpoints and response headers; agents are shown the pool's combined usage                | Response headers, kept for display                                          | Usage endpoint and response headers                |
| Session stickiness     | Built in; off for the proxy or one request (`x-slopmax-affinity`)                               | Opt-in                                                                      | Built in                                           |
| Retries                | Failover on limits, revoked logins, and server errors (after one retry on the same account)     | Retries on listed statuses across accounts                                  | Failover on limits                                 |
| Config changes         | Applied live, also from the dashboard and terminal UI                                           | Hot reload                                                                  | From its app                                       |
| Translation            | Through one common form: Messages, Responses, and Chat clients                                  | Pairwise translators between many formats                                   | Responses-centered, with Claude Code inbound       |
| Claude requests        | From Claude Code only, unchanged but for the credential                                         | From any client, rewritten to pass as Claude Code                           | From any client, with Claude Code's identity added |
| Limit resets           | Claude's and ChatGPT's: on request, before expiry, and when spent (opt-in)                      | —                                                                           | Before expiry (opt-in), plus Claude reset grants   |
| Quota for other tools  | CLIProxyAPI's quota calls, for T3 Code and others, without relaying tokens                      | A management API whose `api-call` sends any request with an account's token | Its own API, for its apps                          |

## Documentation

| | |
| --- | --- |
| [Install and update](docs/install.md) | Every install method, Docker, and zero-downtime updates |
| [Setup and agents](docs/setup.md) | Guided and unattended setup, and wiring Claude Code, Codex, Grok Build, and other clients |
| [How it works](docs/how-it-works.md) | Sessions, failover, routing strategies, limit resets, and how usage is read |
| [Accounts](docs/accounts.md) | Subscriptions, API keys, compatible endpoints, and importing logins |
| [Status, usage, and dashboard](docs/monitoring.md) | The terminal UI, dashboard, usage and cost, the API, and notifications |
| [Other machines](docs/hub.md) | One hub for all your machines, over Tailscale or your network |
| [Models and API keys](docs/models.md) | Paid overflow, aliases, fallbacks, and Claude Code on GPT |
| [Commands and configuration](docs/configuration.md) | Every command and every setting |
| [CLI reference](docs/cli/README.md) | Each command's help page, generated from the binary |
| [Development](docs/development.md) and [architecture](ARCHITECTURE.md) | Building, testing, benchmarks, and how the code fits together |

## Caveats

- Anthropic's terms allow Claude subscription logins in Claude Code only, and pooling subscription accounts may conflict with a provider's terms of service. slopmax serves Claude accounts to Claude Code alone and forwards its requests unchanged, but whether to pool accounts is your call.
- Claude lists and spends limit resets for Claude Code alone. For those two calls, slopmax sends the user agent Claude Code last sent through it; everything else it sends says slopmax.
- Requests go out through rustls, without imitating any client's TLS fingerprint.

## License

[MIT](LICENSE)

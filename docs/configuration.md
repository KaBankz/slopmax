# Commands and configuration

## Commands

Things are nouns with verbs under them, and a noun alone shows its things: `slopmax account` lists the accounts, `slopmax proxy` says whether the proxy runs. `slopmax <command> --help` explains each command, with examples, and [the CLI reference](cli/README.md) has every page in one place.

| Command | What it does |
| --- | --- |
| `slopmax` | The terminal UI at a terminal, the accounts' standing when piped, or the guided setup the first time |
| `slopmax setup` | Set everything up step by step, or unattended with flags (alias `init`) |
| `slopmax status` | Accounts, usage windows, and resets (`--watch`, `--refresh`, `--json`) |
| `slopmax tui` | Open the terminal UI: the dashboard's pages in this terminal |
| `slopmax dashboard` | Open the dashboard in a browser (`--no-browser` prints its address) |
| `slopmax login <provider>` | Connect an account: sign in, or enter an API key (shortcut for `account add`) |
| `slopmax account [list]` | The accounts, numbered |
| `slopmax account add\|import\|adopt` | Connect an account; copy the logins other tools hold; take over refreshing one slopmax follows |
| `slopmax account use\|rename\|priority\|order` | Prefer an account (`--auto` lets slopmax choose); name it; set its tier; set the order new sessions use accounts in |
| `slopmax account enable\|disable\|check` | Put an account in or out of rotation; lift slopmax's hold on it and read its usage again |
| `slopmax account redeem\|remove` | Spend a limit reset; forget an account (both ask first, or take `--yes`) |
| `slopmax usage [range]` | Token totals and API-equivalent cost (`--by day\|model\|account\|machine`) |
| `slopmax requests [range]` | The requests the proxy answered, newest first (`--failed`, `--account`, `--model`, `-n`) |
| `slopmax run <agent> [args…]` | Launch Claude Code, Codex, or Grok Build through the proxy (shortcut for `agent run`) |
| `slopmax agent [list]` | The agents, and whether each points at slopmax |
| `slopmax agent connect\|disconnect <agent>` | Point an agent's own config at the proxy, or restore what that replaced |
| `slopmax agent env <agent>` | Print shell setup for `eval` |
| `slopmax proxy [status]` | Whether the proxy runs, where, and whether it starts at login |
| `slopmax proxy start\|stop\|restart` | Run the proxy in the background (through the login service, if installed), stop it, or both |
| `slopmax proxy install\|uninstall` | Start the proxy at login: a systemd user unit, a launchd agent, or on Windows `slopmaxw.exe` in the user's Run key |
| `slopmax proxy logs` | The proxy's log (`-n` lines, `-f` to follow) |
| `slopmax proxy serve` | Run the proxy in the foreground |
| `slopmax config [name] [value]` | Show the routing and redeem settings, or change one while the proxy runs |
| `slopmax key [list]`, `key add\|remove <name>` | Keys for other machines and tools (`--models` limits what a key may use) |
| `slopmax tailscale [status]`, `tailscale on\|off` | Publish slopmax to your tailnet, or stop (`--port`, `--user`, `--admin`, `--loopback`, `--socket`) |
| `slopmax tailscale user\|admin [list\|add\|remove]` | Logins whose machines need no key, and machines that may also manage slopmax |
| `slopmax doctor` | Check the setup and say how to fix problems |
| `slopmax notify [test]` | Where notifications go, or send a test one |
| `slopmax update` | Install the newest release and move the running proxy to it (`--check` only looks) |
| `slopmax completion <shell>` | Print a completion script for bash, zsh, fish, nushell, PowerShell, or elvish (`--install` puts it where the shell looks) |

`<account>` is the number `slopmax status` shows, or the account's id, email, or label. `<provider>` is `claude`, `codex`, `grok`, `anthropic`, `openai`, `xai`, or `compat`; `<agent>` is `claude`, `codex`, or `grok`. Tab completes them, accounts and key names included.

### For scripts and agents

- Commands that print a report take `--json` (each command's help says). Every command that asks first takes `--yes`; without a terminal and without `--yes`, it fails rather than waits.
- Exit codes: 0 when it worked, 1 when it failed (the error says why), 2 when the command line was wrong. `slopmax doctor` exits 1 when something is broken.
- `slopmax __usage_spec__` prints the whole command line as a [usage](https://usage.jdx.dev) spec, with each command marked `read`, `write`, or `destructive`; it is checked in as [cli/slopmax.usage.kdl](cli/slopmax.usage.kdl). `usage mcp -f docs/cli/slopmax.usage.kdl` lets an agent look up every command, and what it touches, over MCP.
- Commands renamed in 0.15 fail with their new spelling: `slopmax start` says it is now `slopmax proxy start`.

## Configuration

`~/.slopmax/config.toml` is written on first run, with each setting explained. `SLOPMAX_HOME` moves the whole directory.

| Setting                         | Default          | Description                                                                                                                                       |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen`                        | `127.0.0.1:7567` | Proxy address                                                                                                                                     |
| `api_key`                       | generated        | Key clients present to the proxy                                                                                                                  |
| `strategy`                      | `fill-first`     | `fill-first`, `reset-first`, `least-used`, or `round-robin` ([Strategies](how-it-works.md#strategies))                                            |
| `session_affinity`              | `true`           | Keep a session on its account for the prompt cache (a request can say otherwise with `x-slopmax-affinity`)                                        |
| `session_ttl_mins`              | `60`             | Idle minutes before a session's account is forgotten                                                                                              |
| `poll_mins`                     | `5`              | Minutes between usage polls per account (`0` turns polling off)                                                                                   |
| `refresh_tokens`                | `true`           | Refresh OAuth tokens before they expire                                                                                                           |
| `redeem_expiring_credits`       | `false`          | Redeem a limit reset before it expires unused                                                                                                     |
| `redeem_when_exhausted`         | `false`          | Redeem one when every account of a provider is spent                                                                                              |
| `websockets`                    | `true`           | Relay Codex's WebSockets to ChatGPT's                                                                                                             |
| `warm_windows`                  | `false`          | Start idle ChatGPT accounts' 5-hour windows as soon as they reset                                                                                 |
| `paid_overflow`                 | `false`          | Let API keys take over a subscription's models once it is limited                                                                                 |
| `check_updates`                 | `true`           | Look up the newest release once a day, for `slopmax status` to tell                                                                               |
| `proxy`                         | none             | Upstream proxy (`http://`, `socks5://`, `socks5h://`), else `HTTPS_PROXY`                                                                         |
| `[aliases]`, `[fallbacks]`      | none             | Model renames, and models to try once one is limited everywhere ([Models](models.md))                                                             |
| `[prices]`                      | none             | API prices for `slopmax usage`, beyond the built-in lists                                                                                         |
| `[plan_prices]`                 | list prices      | What each plan costs a month (`"claude/ultra" = 200`), for what unused quota is worth                                                             |
| `[notify]`                      | none             | Webhook, command, and events for [notifications](monitoring.md#notifications)                                                                     |
| `[[keys]]`                      | none             | Client keys, made with `slopmax key add`, each possibly limited to some models                                                                    |
| `[tailscale]` `users`, `admins` | none             | Tailnet logins whose machines use slopmax without a key, and machines that may also manage it (`slopmax tailscale user`, `slopmax tailscale admin`) |
| `[hub]` `url`, `key`            | none             | On your other machines: the hub their agents use, and a key when the hub can't tell the machine by its tailnet login (`slopmax setup --hub`)       |

The proxy applies a changed config.toml within two seconds, without a restart; only `listen` and `proxy` need one. The background proxy logs to `~/.slopmax/slopmax.log`. `SLOPMAX_LOG` sets the log level, for example `SLOPMAX_LOG=debug`.

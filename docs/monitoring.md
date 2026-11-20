# Status, usage, and the dashboard

## Status

```
CLAUDE                PLAN       5H                      WEEK                    STATUS
 1 work@example.com   ultra      —                       █████░░░░░  49% 1d23h   ● active · 2 sessions · 41 req · 1.2M tok
   └ 7d Fable                                            ██████░░░░  58% 1d23h
 2 home@example.com   max        ██████████ 100% 1h02m   ███████░░░  71% 4d2h    limited · back in 1h02m
 3 team@example.com   team       ░░░░░░░░░░   0%         ░░░░░░░░░░   0%         ready · priority -1
   pool               3 accts    ███░░░░░░░  33% 1h02m   ████░░░░░░  40% 1d23h   what the agents see

CODEX                 PLAN       5H                      WEEK                    STATUS
 4 me@example.com     pro        —                       ███░░░░░░░  29% 5d17h   ● active · 1 session · 3 limit resets · 9 req · 310.4k tok

XAI                   BILLING    MODELS                                          STATUS
 5 xAI API key …x9Qe  per token  grok-*                                          ready

strategy reset-first · proxy running
```

`slopmax status` (or `slopmax`, piped) shows how much of each window is used and when it resets. The pool row is the provider's accounts read as one, which is what the agents are shown (see [One account](how-it-works.md#one-account)). Limits scoped to one model, such as a weekly cap on a Claude model, are listed under their account. `--watch` keeps the display updated, `--refresh` polls the providers first, and `--json` prints the report for scripts.

## Usage and cost

Every answered request is recorded in `~/.slopmax/usage/`, one JSON line each in monthly files: the account, model, tokens, latency, and time to first token.

```
$ slopmax usage 7d --by model
MODEL                 REQ     INPUT    OUTPUT  CACHE READ  CACHE WRITE   API COST
claude-opus-5-5       412    310.2k    188.0k      102.4M         2.9M     $39.98
gpt-6-sol              96     88.1k     41.7k       12.0M            0          —
total                 508    398.3k    229.7k      114.4M         2.9M    $39.98+
```

`API cost` is what the same tokens would cost on the pay-as-you-go API, at Anthropic's and OpenAI's list prices and any you set under `[prices]` in the config. Requests to models without a price are counted apart and marked `+`. Group `--by day`, `model`, `account`, or `machine`, over `today`, `7d`, `30d`, or `all`, or print `--json`. `slopmax requests` lists the requests themselves, newest first (`--failed`, `--account`, `--model`, `-n`).

On a [hub](hub.md), `--by machine` shows which of your machines sent what. A machine is named by its client key, or by its name on your tailnet. The hub's own agents show as `this machine`, or as `hub` when another machine asks.

### Left on the table

A subscription's weekly quota that goes unused is lost at the reset, and with it that part of the fee. slopmax notes each window that resets with how much of it was used (in the usage ledger), and values the unused part of each week at the plan's monthly price: Claude Pro $20, Max $100, Ultra $200, Team $30; ChatGPT Plus $20, Pro $200 (ChatGPT reports every Pro tier as `pro`), Team and Business $30; SuperGrok Lite $10, SuperGrok $30, Plus $100, Heavy $300. Set what you really pay under `[plan_prices]`.

```
Left on the table: $39.74, 20% unused on average, across 16 weekly windows
  work@example.com               $24.23  26% unused over 4
  me@example.com                  $9.05  49% unused over 4
```

`slopmax usage` and the dashboard show it; the `reset-first` strategy and the `quota-unused` notification are there to keep it small.

## Terminal UI

`slopmax` at a terminal (or `slopmax tui`) opens the dashboard's pages in the terminal: the overview, each provider's pool with its forecast and every account's windows, usage and performance over a day, a week or a month, the requests as they are answered, and the agents, keys, diagnostics and settings. It keeps itself up to date from the proxy's event stream, like the dashboard, and works against this machine's proxy (starting it if needed) or the hub this machine uses.

Move between pages with Tab, the arrow keys, the number keys, or the mouse; `?` lists the keys. On a provider's page, Space turns the selected account on or off, `p` prefers it for new sessions, `c` checks it, and `R` redeems one of its limit resets; Agents connects and disconnects them, Access makes and revokes client keys, and Settings changes the live settings. Whatever can't be taken back asks first. It draws in your terminal's own colors and honors `NO_COLOR`.

## Dashboard

`slopmax dashboard` opens a page that shows every account's windows and reset countdowns, usage and cost by day, model, account, or machine, and a live feed of answered requests. It can enable, disable, pin, reprioritize, and redeem. The page is built into the binary and loads nothing from elsewhere. It takes the slopmax key from its address's `#fragment`, which browsers never send to a server.

When slopmax is [published to your tailnet](hub.md#over-tailscale), open `https://<hub>.<tailnet>.ts.net:7567/slopmax/` on any of your machines, your phone included, without a key. It is read-only unless the machine is an admin. Otherwise, on a remote machine, forward the port first (`ssh -L 7567:127.0.0.1:7567 host`).

## API

The dashboard's data is available as JSON under `/slopmax/api`, with the slopmax key as a bearer token. From your tailnet, a machine's identity works instead, with any token, such as `Bearer tailnet`: users may read status, events, history, usage, and the tailnet's view, and admins may do everything. It is slopmax's one API: the CLI and the dashboard both use it, and `contract/fixtures/` holds an answer from each endpoint.

| Endpoint                                       | Gives                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET status`, `POST refresh`                   | every account's condition, windows, limit resets and notes, and each provider's pool (the usage the agents see)                        |
| `GET events`                                   | server-sent events: the report whenever it changes, each request as it is answered, notices, and sign-in progress                      |
| `GET history?range=today\|7d\|30d`             | tokens, cost, failovers, caching, and speed over time, by account, model, and agent                                                    |
| `GET usage?range=…&by=…`                       | totals by day, model, account, or machine                                                                                              |
| `GET`, `PATCH settings`                        | the settings; `PATCH` takes the live ones as JSON, such as `{"strategy": "round-robin"}`, writes config.toml, and applies them at once |
| `PATCH`, `DELETE accounts/<id>`                | change an account's label, priority, order or whether it is on, or remove it                                                           |
| `POST accounts/<id>/pin`, `DELETE pins`        | prefer an account for new sessions, or let slopmax choose again                                                                        |
| `POST accounts/<id>/redeem`, `…/own`           | redeem a limit reset; have slopmax refresh an imported login itself                                                                    |
| `POST accounts`, `POST imports`, `POST logins` | add an API key or a compatible endpoint, import logins, or sign in to a subscription                                                   |
| `GET`, `POST keys`, `DELETE keys/<name>`       | client keys for other machines, as `slopmax key` makes them (shown once)                                                               |
| `GET agents`, `POST agents/<id>/connect`       | how Claude Code, Codex, and Grok Build are wired, and wiring them                                                                      |
| `GET doctor`                                   | the findings `slopmax doctor` prints                                                                                                   |
| `GET`, `PATCH tailnet`                         | where slopmax is published on your tailnet, who may use it, and what is wrong; `PATCH` changes `users` and `admins`                    |

`/healthz`, outside the API, needs no key. It answers `service`, `version`, and the proxy's `pid`, which it leaves out over the tailnet. Asked with a token, it adds `owner`, whether that is the owner key, and `access`: `none`, `use`, `view`, or `admin`, with the `login` and `machine` the hub knows the caller by. `via` is `tailnet` for a request that came over the tailnet.

### Tools built for CLIProxyAPI

Apps that show a CLIProxyAPI hub's quotas can show slopmax's. In T3 Code, add a CLIProxyAPI hub to the provider settings, with slopmax's `api_key` as the management key and, as the hub URL, the address your agents use (`http://127.0.0.1:7567` unless you changed `listen`; `localhost` won't match it). T3 then lists every pooled account's windows and ChatGPT's limit resets, and can redeem them. When every account is spent, T3 shows when the first frees up: slopmax's limit error says `(reset after 2h 5m 12s)`, and T3 asks the hub at the agent's address when the error doesn't.

slopmax answers the three management calls these tools make: `auth-files`, `api-call`, and `reset-quota`. Its `api-call` answers only the usage and limit reset calls those tools send and refuses every other request, so the key never puts an account's token in a client's hands:

- Usage comes from the readings slopmax already keeps, without calling the providers.
- Limit resets are listed by ChatGPT, and each list is reused for five minutes. A redemption goes through the same path as `slopmax account redeem`, with the client's request id, so a retry from any machine is answered as the first was.
- `reset-quota` lifts slopmax's blocks on the account and reads its usage again.

## Notifications

A webhook or a command hears when every account of a kind is limited (so requests fail), when it recovers, and when an account needs signing in again. It also hears, once each, about what is worth doing before it is lost:

- `reset-expiring`: a limit reset lapses within the day, and slopmax won't redeem it by itself (`redeem_expiring_credits` is off);
- `quota-unused`: a week resets within the day with a quarter or more of it unused, and what that is worth.

Add `limited` and `available` to `events` to hear about each account too. `slopmax status` and the dashboard list the current nudges.

```toml
[notify]
webhook = "https://hooks.slack.com/services/…"     # JSON with "text" and "content" for Slack and Discord
command = 'notify-send slopmax "$SLOPMAX_MESSAGE"'  # also gets SLOPMAX_EVENT, _PROVIDER, _ACCOUNT, _UNTIL
```

`slopmax notify` shows where notifications go and which events send one; `slopmax notify test` sends a test.

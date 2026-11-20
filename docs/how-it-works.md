# How it works

## Switching

Each request names its session: Claude Code's session id, Codex's `session-id`, Grok Build's `x-grok-conv-group-id`, or for other clients a session header or `prompt_cache_key`. A session stays on its account for as long as that account can serve it, which keeps prompt caches warm. It moves only when the account refuses, fills up, or signs out, and it is forgotten after `session_ttl_mins` idle minutes. A new session goes to the account chosen with `slopmax account use`, if that one can serve. Otherwise it goes to the highest priority tier, and within the tier the [strategy](#strategies) decides. When an account that filled up recovers, the sessions that moved off it stay where they are, keeping their cache, and new sessions go back to it.

Session affinity is what keeps prompt caching working, so it is on by default. With `session_affinity = false` every request is placed by the strategy instead, which spreads load across accounts at the cost of the cache; a client can decide per request by sending `x-slopmax-affinity: off` (or `on`, when the config turns it off). Claude Code sends extra headers from `ANTHROPIC_CUSTOM_HEADERS`. slopmax still remembers which account a session used last, so account-bound state is dropped when a request lands elsewhere, and its own `x-slopmax-*` headers never reach a provider.

### Failover

When the provider refuses a request (a rejected 5-hour or weekly window, `usage_limit_reached`, an invalid token), slopmax sets that account aside, until its reset when its quota is spent, and retries on the next one. ChatGPT sometimes refuses inside a stream that has already started with a 200, so slopmax holds the first moments of a Codex stream back to catch that. A server error (500, 502, 503, 504, or Anthropic's 529) is retried once on the same account, which keeps the session's cache; if it persists, the request moves to the next account, and the agent sees the error only when every account answered so. Failover happens only before the agent has received anything; once a response starts streaming, it passes through untouched. When every account is spent, the agent gets its own native usage-limit error with the earliest reset time, and shows it as usual.

### WebSockets

Codex talks to ChatGPT over a WebSocket when it can, which keeps the conversation warm upstream and starts answers sooner than HTTP streaming. slopmax relays the socket to ChatGPT's own on one account, reading usage from the rate-limit events ChatGPT sends on it. A socket stays on its account; if that account runs out mid-turn, slopmax closes the socket, and Codex retries on a new one that opens on another account. Models that need translation, and `websockets = false`, send Codex back to HTTP streaming.

### What changes in a request

Each request is adapted to the account serving it, and nothing more:

- **Claude.** The account's token replaces the slopmax key, and the OAuth beta flag that subscription tokens require is added. Nothing else changes: the body, including Claude Code's billing header and `metadata.user_id`, reaches Anthropic byte for byte as Claude Code sent it. slopmax does not imitate Claude Code or alter what it says about itself.
- **Codex.** The account's token and workspace id are set. Encrypted reasoning items and `previous_response_id` only work on the account that created them, so they are dropped when a session moves, along with Codex's sticky routing header.
- **Grok.** The account's token replaces the slopmax key; Grok Build's own headers and body go to xAI's CLI chat proxy as sent. Encrypted reasoning is dropped when a session moves, as for Codex. Grok accounts serve Grok Build alone (their sign-in grants `grok-cli:access`), and slopmax does not imitate Grok Build for other clients.
- **Keys and endpoints.** The key replaces the slopmax key.

## One account

slopmax aims to make several accounts of one provider feel like a single account to the agent. Beyond failing over before the agent sees an error:

- **Usage reads as the pool's.** Every response's quota headers describe the account that served it, and agents show them. Codex, for example, warns when less than a tenth of a window is left. slopmax replaces them with the pool's standing: each window's average usage across the working accounts, and the soonest reset that frees capacity. Codex's limit display and warnings then describe the pool, over HTTP and over WebSockets. For Claude it rewrites `anthropic-ratelimit-unified-*` the way Claude Code's gateway documentation asks gateways to, though Claude Code connected with a token does not show these today.
- **Conversations survive a move.** A session that moves mid-conversation, even mid tool call, carries its history to the new account. Claude accepts thinking signed by another of your accounts (checked with Haiku 4.5 and Opus 5.5, between a Max and a Team account). If it ever refuses one, Claude Code drops the old thinking and retries by itself. Claude's advisor results are another matter: Claude reads them only on the account that asked, so slopmax leaves another account's behind and keeps the new account's own. ChatGPT's account-bound state is dropped on a move, as described above.
- **The prompt cache does not move.** It belongs to an account, so the first request after a move costs more and answers slower. That is why sessions only move when they must.

## Strategies

By default slopmax uses accounts in a fixed order, moving to the next only when one is limited. `slopmax account order` shows that order and sets it: `slopmax account order 3 1` puts account 3 first and account 1 second, and the rest follow as they were. Unused quota is lost when its window resets, so `reset-first` instead spends the quota about to expire. All four place new sessions (or, without affinity, every request) within the highest priority tier:

| `strategy`    | Places a new session on                                   | Good for                                    |
| ------------- | --------------------------------------------------------- | ------------------------------------------- |
| `fill-first`  | the first in `slopmax account order`, until it is limited | plain failover, a fixed order (the default) |
| `reset-first` | the account whose started window resets soonest           | wasting no quota                            |
| `least-used`  | the account with the most room left                       | keeping accounts level                      |
| `round-robin` | the account handed a request longest ago                  | even load across accounts                   |

An agent's housekeeping, such as Claude Code listing models before a session, takes no turn from `round-robin`. A block lasts until the provider's stated reset, unless a fresh reading shows room sooner.

### Warming windows

ChatGPT starts a 5-hour window at an account's first request, so an account left idle after a reset gets its next reset late. With `warm_windows = true`, slopmax sends an idle ChatGPT account one tiny request as soon as its window resets, using the model Codex last used, so the next reset comes sooner when the account is needed. ChatGPT Pro has no 5-hour window, so its accounts need no warming. Claude accounts are never warmed: slopmax sends Claude only what Claude Code writes.

## Limit resets

Claude and ChatGPT accounts can hold limit resets, which reset an account's windows on the spot. Claude's are grants, such as the one Pro and Max accounts got at Claude Opus 5.5's launch, which claude.ai lists under Limit resets; ChatGPT's are its reset credits. slopmax lists them with each account and redeems them:

- on request, with `slopmax account redeem <account>`;
- in the last three hours before one would expire unused, if the account has usage to reset (`redeem_expiring_credits`, off by default; the `reset-expiring` [notification](monitoring.md#notifications) says when one is about to lapse);
- when every account of the provider is spent, then retries the request on the reset account (`redeem_when_exhausted`, off by default).

Claude lists and spends limit resets for Claude Code alone, so slopmax makes those two calls with the user agent Claude Code last sent through it, and makes neither before Claude Code has sent a request.

## Reading usage

Every response carries rate-limit headers (`anthropic-ratelimit-unified-*`, `x-codex-*`), and slopmax updates the serving account's windows from them as requests flow. Grok's SuperGrok plans are a weekly allowance shared by grok.com and Grok Build, which slopmax reads from xAI's billing endpoint as a 7-day window. The proxy also polls each subscription's usage endpoint every `poll_mins` minutes and right after a window resets. While an account is blocked it polls every 10 minutes, because quota often comes back before the stated reset.

For how the code is laid out, see [ARCHITECTURE.md](../ARCHITECTURE.md).

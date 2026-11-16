# Changelog

Every version has a signed tag and a GitHub release, whose notes come from this file. Versions follow [Semantic Versioning](https://semver.org): a minor release adds features, a patch release only fixes. Before 1.0, a minor release may also change something you rely on, and its notes say what.

## [Unreleased]

### Removed

- The desktop apps: the macOS app (`apple/`), `slopmax-app` and the GPUI app, with their CI workflows, the icon files only they used, and the dashboard's code for running in a desktop window (its menu bar panel, start and stop buttons, and the bridge to an app). The CLI, with the dashboard it serves, is slopmax's interface. A `~/.slopmax/app.toml` left by the app is no longer read and can be deleted.
- `slopmax daemon-info`, which the apps ran to find the proxy and its key.
- The `exe` field of the event stream's `Hello`, which the apps compared with the CLI they shipped.

### Changed

- Adding a Claude or ChatGPT subscription by key is refused with "…through `slopmax login <provider>` or the dashboard" rather than "…, or the app".

### Fixed

- `slopmax tailscale on` says what to run when Tailscale refuses to publish slopmax's socket. Tailscale lets only root publish a socket: it lets an operator too only when the operator may run `sudo tailscale`, which it checks under the account's full name rather than its login (so it fails where the two differ, such as `ec2-user`, "EC2 Default User"), and its next release drops the operator altogether. slopmax showed Tailscale's raw 401; it now gives the one `sudo tailscale serve` command, or `--loopback`.
- `slopmax tailscale on` finishes when slopmax is already published, by hand or by an earlier run: it no longer asks Tailscale to publish it again, which needed root just to change nothing.
- The dashboard said it could not open a link, such as the release notes or a sign-in address, even when the browser had opened it.

## [0.13.1] - 2026-11-16

### Fixed

- Claude Code's advisor works with a model you name through slopmax: an alias, a selector such as `work/claude-opus-5-5`, or a fallback. slopmax asked for the routed model but sent the advisor tool's own model on under the name Claude Code used, so Claude refused the request (`tools.N.model: work/claude-opus-5-5`) and Claude Code turned the advisor off for the conversation. The advisor now asks for the same model the request does, where it named the same one.

## [0.13.0] - 2026-11-16

Your other machines can now use one machine's accounts over your Tailscale tailnet, without a key. Only that machine, the hub, refreshes each login, so copies no longer sign each other out. The dashboard is rebuilt on shadcn/ui, forecasts each subscription pool, and looks back over every request. Changes to rely on: a client key sent to `/slopmax/api` now gets 403 instead of 401, and an older slopmax can't read a config.toml with `[tailscale]` or `[hub]`.

### Added

- `slopmax tailscale on` publishes slopmax to your tailnet with `tailscale serve`; the proxy itself still listens on 127.0.0.1 only. On Linux it first needs `sudo tailscale set --operator=$USER` once, and says so; slopmax never runs sudo. `slopmax tailscale off` stops publishing, and `slopmax tailscale status` shows where slopmax is published and who may use it.
- Your machines use the hub without a key: Tailscale tells slopmax which machine is asking. Machines signed in as a login in `[tailscale] users` use the proxy and see slopmax's status, usage and history; machines in `[tailscale] admins` may also manage it. `slopmax tailscale users` and `slopmax tailscale admins` change the lists. Tagged machines, and hubs on Windows or with Tailscale's macOS app, use client keys as before.
- `slopmax setup --hub <machine>` on another machine points its Claude Code and Codex at the hub; it runs no proxy of its own, and its commands go to the hub. `slopmax setup --hub off` goes back to its own accounts. On a new machine, `slopmax setup` offers a hub it finds on your tailnet.
- `slopmax usage --by machine` shows which of your machines sent what. The ledger records the machine that sent each request: a client key's name, or a tailnet machine's.
- The dashboard opens from your tailnet without a key, on any of your machines or your phone, read-only unless the machine is an admin. Its Access page shows how your other machines reach slopmax, its Usage page sums usage by machine, and its live feed names the machine each request came from.
- `GET` and `PATCH /slopmax/api/tailnet`, and `/healthz` says what the caller may do (`access`, `login`, `machine`, and `via` over the tailnet). `slopmax doctor` checks the published hub, or the hub a machine uses.
- Each subscription's page forecasts its pool. A chart shows the pool's 5-hour or weekly use over the last day or week, then where it is heading at the recent pace as each account's window resets. Under it: the pace against the one that would last the window, when the pool would run dry, which account would run out first, and what the next reset gives back.
- The proxy records each pool's quota every 2 minutes, in the usage ledger, when it changed or an hour has passed. The forecast fills in from the first reading.
- A lane per account shows its resets over the next week, so resets bunched together stand out.
- Each account shows its last day as a strip of half hours, green where requests were answered and amber or red where they failed, and each window shows what it has served so far at API prices and what a percent of it has bought.
- `GET /slopmax/api/pools/{provider}` answers all of it, for any client.
- The Requests page looks back over today, 7 days or 30 days of the ledger as well as the live feed. It filters by account, model, agent and outcome (answered, failed, or saved by failover), sums what matched, and shows each request's cost at API prices. A row opens the request in full: the machine that sent it, its tokens by kind, the accounts tried, its status in words, and how it ended. The listing exports as CSV.
- `GET /slopmax/api/requests` answers the ledger's requests a page at a time, filtered.
- A limited or throttled account has a Check now button, and every account's menu has Check its limits now: slopmax lifts its own hold on the account and reads its usage again, so an account whose limit has passed is back at once. `POST /slopmax/api/accounts/{id}/check` does the same for any client.
- The overview has a Last day section: each subscription account's requests in half hours, and today's failed requests with a link to all of them on the Requests page.
- The Usage page's figures and the overview's Today say how each moved since the span before: yesterday up to this hour, or the 7 days before. The history API carries the earlier span's totals as `previous`.
- The overview says when a newer slopmax is out, with the command that updates this install (`slopmax update`, or the package manager's), a button that copies it, and a link to the release notes. The report carries it as `update`.
- Settings › Appearance › Hide email addresses masks every address the dashboard shows, as `a•••@s•••.dev`, for screen sharing and streams: account names, tailnet logins, nudges, toasts, notifications and exports.

### Changed

- Tailscale and forwarding headers (`Tailscale-*`, `X-Forwarded-*`, `Forwarded`) are no longer sent on to providers.
- The dashboard and `/slopmax/api` need view or admin access per endpoint: the owner key has both, a machine's tailnet identity may have either, and client keys have neither, as before. A machine set up with `slopmax setup --hub` sends its client key, and may still do what its tailnet login may, so `slopmax status` works there.
- A client key sent to `/slopmax/api` now gets 403 instead of 401: slopmax knows the key, and it reaches the proxy only.
- Requests that come through Tailscale Funnel are refused with 403, even with a key.
- An older slopmax can't read a config.toml with `[tailscale]` or `[hub]`. Remove those tables before going back to one.
- The web dashboard is rebuilt on shadcn/ui: its components, its neutral theme and the Geist font, in light and dark. The page content is centred, up to 1152 px wide.
- The usage and performance charts are Recharts charts. Each bar or point shows its figures on hover.
- The sidebar collapses to the edge and becomes a sheet on a narrow window. Its edge still drags to resize it, and `\` still shows or hides it.
- Toasts use Sonner. The dashboard's content security policy now allows Sonner's stylesheet by its hash, and nothing else inline.
- The dashboard's scripts are larger: about 390 KB with brotli, up from 310 KB, mostly the charts.

### Fixed

- The dashboard's sidebar had been drawn in the page's background color instead of its own.

## [0.12.0] - 2026-11-15

The login service keeps the proxy's listening socket open, so a crash or a restart no longer refuses a single connection, and on macOS an update leaves no stand-in process behind. One change to rely on: on macOS, `slopmax stop` now unloads the login agent until `slopmax start` or the next login.

### Changed

- The login service keeps the proxy's listening socket between one process and the next. systemd holds it in the unit's file-descriptor store, and launchd owns it outright, as the plist now says. After a crash, a `systemctl restart`, or a restart of the agent, requests wait about a second for the new process instead of being refused. The proxy rewrites an older Linux unit by itself, with nothing restarted.
- On macOS, an update no longer leaves the old process running as a stand-in for the new one. Once the old one has finished its requests, it exits, and launchd starts the service again: that process takes launchd's socket and has the process the proxy moved to make way. It saves its state, lets go of the home, and finishes its own requests. Moving from 0.11 or older writes the login agent anew with `slopmax update`, which restarts the proxy once.
- On macOS, `slopmax stop` unloads the login agent, since launchd would otherwise start the proxy again for the next connection to the socket it holds. `slopmax start` loads it again, and so does the next login. Changing `listen` takes `slopmax service install`, which writes the new address into the agent.
- `slopmax status` says when the login service was written by another version or for another listen address.

## [0.11.0] - 2026-11-15

slopmax updates itself, and the running proxy moves to a new version without refusing or cutting off a single connection. One change to rely on: the Linux login service is now a `Type=notify` unit that runs `~/.slopmax/bin/slopmax`, which updates move to each new binary.

### Added

- `slopmax update` installs the newest release the way slopmax was installed and moves the running proxy to it. Installed by the install script, it downloads the release, checks its SHA-256, and replaces the binary in place. Installed by mise, it runs `mise upgrade`, moving a version pinned in the global mise config. Installed by Homebrew, cargo, or Nix, it prints the command to run. `slopmax update --check` only looks.
- The proxy moves to a new binary without a gap. It hands its listening socket to the new one, which takes every new connection from its first moment, and finishes what it has: streams run to their end, Codex's sockets finish their turn before closing, and requests on connections already open are still answered. Under systemd, the new process becomes the service's main one.
- The proxy follows updates made another way. Within a minute of a newer slopmax being installed (`mise upgrade`, the install script run again, `brew upgrade`), it moves to it.
- The proxy looks up the newest release once a day, one request to github.com, and `slopmax status` says when one is out, and when the proxy runs an older version than the CLI. `check_updates = false` or `SLOPMAX_NO_UPDATE_CHECK=1` turns the lookup off.

### Changed

- The login service runs `~/.slopmax/bin/slopmax`, a link to the installed binary. mise removes old versions a day after an upgrade, and a service that named a version's own path would have failed at its next start.
- The Linux unit is `Type=notify`: systemd counts the proxy started once it listens. After a crash it restarts within a second, as often as it takes, rather than after 5 seconds.
- `POST /slopmax/api/shutdown {"restart": true}` restarts the proxy by handing its socket to a new process, so nothing is refused while it starts. The request also takes `exe`, a binary to hand the proxy to.
- A stopping proxy closes its listener at once. Connections that came in while it drained used to wait for an answer and then be reset; now they are refused at once, and agents retry at once.

### Fixed

- The install script checks the download's SHA-256. It asked for the checksum under the wrong file name, found none, and went on without checking. It now fails when the checksum is missing or doesn't match, and puts the new binary in place with a rename, so a running proxy keeps its file.

## [0.10.1] - 2026-11-15

Claude requests count their tokens again, and moving the Linux login service to a new version no longer leaves the proxy stopped.

### Fixed

- Claude requests count their tokens again. Anthropic now sends Claude Code's answers gzip-compressed, and slopmax passed compressed answers through unread, so every Claude request showed 0 tokens in `slopmax status`, the dashboard's costs and value figures, and the history. slopmax now reads a decompressed copy of gzip and deflate answers. What Claude Code receives is unchanged.
- On Linux, `slopmax service install` run while the service is already running, as when moving to a new version, no longer leaves the proxy stopped. It now restarts the service on the new binary. Before, the old proxy stopped and nothing started again until the next login or `slopmax start`.

## [0.10.0] - 2026-11-15

slopmax now pools SuperGrok subscriptions for Grok Build. One change to rely on: with a SuperGrok account connected, xAI API keys serve Grok Build only as paid overflow. T3 Code shows when a spent pool frees up, and an account's old sign-in error clears once it signs in again.

### Added

- SuperGrok subscriptions, for Grok Build. `slopmax login grok` signs in with xAI's device code, `slopmax import cliproxyapi` brings over CLIProxyAPI's xAI sign-ins, and `slopmax run grok`, `env grok`, and `setup grok` point Grok Build at the proxy (`/grok/v1`) through its chat-proxy and auth-provider settings. Sessions stay on one account by Grok Build's conversation group and move when an account's monthly allowance is spent. Each account's allowance, read from xAI's billing endpoint, shows as a 30-day window, and its plan (`lite`, `supergrok`, `plus`, or `heavy`, as `[plan_prices]` names them under `grok/`) is priced for the dashboard's value figures. SuperGrok accounts serve Grok Build alone. The dashboard signs in to SuperGrok, and `slopmax doctor` checks Grok Build's wiring, that its own xAI sign-in isn't bypassing slopmax, and that xAI is reachable. The CLIProxyAPI hub lists SuperGrok accounts as `xai`, as CLIProxyAPI does, and answers T3 Code's read of their allowance from slopmax's own reading.

### Changed

- xAI API keys now back SuperGrok: with a SuperGrok account connected, they serve Grok Build only as paid overflow (`paid_overflow = true`). They still serve `grok-*` models to every other client.
- When every account is rate limited, the agent's error says when the first frees up as `(reset after 2h 5m 12s)`, to the second, so T3 Code and other apps running Claude Code show the time.
- A limit reset redeemed from T3 Code goes to ChatGPT with T3's own request id, so a retry from any machine is answered as the first was, and a redemption that names no reset spends the soonest to expire, as ChatGPT does.

### Fixed

- An account's last error, such as `usage poll: refresh token rejected`, no longer stays in `slopmax status` and the dashboard after you sign in again. Signing in again or a successful usage check now clears it. Before, only a request served by the account did, so an account that fill-first wasn't using kept the old error.

## [0.9.0] - 2026-11-15

New sessions now fill accounts in an order you set, and limit resets are no longer redeemed by themselves. Both are new defaults: a config that names its own keeps it. Errors and empty states across the CLI, the proxy and the dashboard now say what happened and what to run.

### Added

- `slopmax order` shows the order new sessions use accounts in, and `slopmax order 3 1` puts accounts 3 and 1 first, in that order, the rest following as they were. Priority tiers still come first.

### Changed

- New sessions now fill accounts in order (`fill-first`), moving to the next only when one is limited, instead of spending the quota that resets soonest. `strategy = "reset-first"` brings back the old default.
- Limit resets are no longer redeemed by themselves before they expire; the `reset-expiring` notification says when one is about to lapse, and `slopmax redeem` spends it. `redeem_expiring_credits = true` brings back the old default.
- When no account is connected for what a request asks for, the agent gets a 503 that names the command adding one, such as `slopmax has no Claude account connected yet; run `slopmax login claude` (or `slopmax import`)`, instead of a 404 that Claude Code reads as an unknown model.
- When every account fails a request, the agent hears why: `every Claude account failed: couldn't connect to api.anthropic.com (connection refused). Check your network, or run `slopmax logs`.` When every account is disabled or signed out, it names them and the command that fixes each.
- Network errors read plainly in `slopmax status`, the log, notifications and the agent's errors: `couldn't connect to api.anthropic.com (connection refused)`, `couldn't find api.anthropic.com (DNS lookup failed)`, `api.anthropic.com closed the connection before it answered`. A new connection the server closes before the request goes out is tried once more.
- When every kept connection to a provider is busy, a request takes the first to come free if that is sooner than making a new one.
- `slopmax config` names settings as you type them (`poll_mins`, not `pollMinutes`), whether or not the proxy runs, and takes `refresh_tokens` and `websockets` with the proxy stopped too. `slopmax config listen` shows the address and how to change it.
- `slopmax login compat` for an endpoint and key already connected says it updated that account. An endpoint or key check that doesn't answer is still saved, and you're told so, in the CLI and the dashboard.
- A reference that matches several accounts lists them by their `slopmax status` numbers. `slopmax label` and `login --label` refuse a label another account already goes by. `slopmax use` refuses a disabled account.
- `slopmax status` shows a signed-out account as `signed out: run `slopmax login claude``; the detail stays in `--json` and `slopmax doctor`.
- `slopmax usage` leaves out rows with no successful requests, and when every request failed it says so instead of showing zeros.
- `slopmax start` with an older version running says so, and how to restart it. `slopmax doctor` warns about accounts whose last request failed, and says to install Claude Code or Codex first when it is not on PATH.
- Notification failures say what happened (`the notify command exited with 3 (no output)`), and a `[notify] webhook` that isn't a web address is a config error when the config loads.
- Signing in without a terminal, when the sign-in needs a pasted code, is refused before the link is shown; pasted codes that don't fit, codes from an earlier sign-in and the time limit each say what to do next. Argument mistakes say what's expected (`priority must be a whole number, like 2 or -1`), and `--import`, `--agents` and `--login` list the values they take.
- The dashboard says which action failed (`Could not rename ana@studio.dev: …`), shows progress while it adds a key or an endpoint, imports, makes a client key or refreshes usage, and those buttons can't be pressed twice. A page that couldn't read something offers Try again, and after slopmax answers again the dashboard reads everything again. Quiet pages link to Agents, and its key gate checks a key before opening.

### Fixed

- A config.toml with a mistake stopped every command, even `slopmax stop`. The error names the line and how to fix it; `stop`, `logs`, `daemon-info`, `config <name> <value>` and `completions` work anyway, and `doctor` reports it beside its other checks.
- A proxy started from another `SLOPMAX_HOME` (or before `api_key` changed) on the same port made commands fail with `missing or invalid slopmax key; see `slopmax env``. They now name it, with its pid, and say how to stop it.
- `slopmax start` took several seconds (over a minute if the port's holder never answered) and then pointed at the log. It now says at once why the proxy did not start, such as `python3 (pid 3836776) is using 127.0.0.1:7567. Set `listen` in config.toml to a free port.` A port below 1024 is reported as needing administrator rights.
- `slopmax run claude` without Claude Code installed left a proxy running and said `No such file or directory`. It now checks first and says to install it (the same for Codex).
- Importing CLIProxyAPI logins with no email gave every one the same id, so each replaced the last; they are now told apart. Ids of other accounts are unchanged. `slopmax import` names each login file it couldn't read, and says where it looked when it found nothing.
- A change through the proxy to an account saved while it ran failed with `no such account`; the proxy now reads its accounts again first.
- `slopmax own` on an account that already refreshes in slopmax, or on an API key, no longer warns about signing out the other tool's copy. `slopmax setup claude` says how to undo once, as a command that runs.
- A minute setting too large for config.toml was written as -1; it is now refused. A token refresh refused with an HTML error page no longer puts the whole page in `last error`. `slopmax status --watch` into a pipe no longer writes screen-clearing codes.
- The dashboard showed raw request errors such as `Transport: Failed to fetch (POST http://…)`; it now says slopmax is not answering. A subscription account signed in moments ago was missing from the Overview until its usage was read; it now shows, with `Limits not read yet`. While slopmax wasn't answering, Agents and Client keys pulsed forever. An import that saved nothing read as a success. Set priority closed and did nothing on anything but a whole number, and Create key cleared the form before slopmax answered.

## [0.8.1] - 2026-11-15

### Changed

- The proxy allocates about a third less for each request it forwards (180 allocations for a Claude Code request, from 265), and keeps its connections to the providers itself: one task watches them while any is open, and an idle proxy wakes for none. The dashboard's 30-day history answers in about 0.3 ms, from 2.5.

### Fixed

- `slopmax usage`, `/history` and the dashboard cost a long prompt at the higher prices the API charges for it: Claude Haiku 5.5 over 100,000 prompt tokens, and GPT models over 272K input tokens, with cache reads and writes counting toward both. Each such request pays them on all of its tokens. They were costed at the prices for shorter prompts, which put a 150K-token Haiku 5.5 request at a fifth of its price.

## [0.8.0] - 2026-11-15

### Added

- On Windows, `slopmax service install` (and `slopmax setup`) starts the proxy at login, as systemd and launchd do elsewhere. It adds `slopmaxw.exe`, which the Windows release archives now carry, to your login programs, with no administrator rights needed. `slopmaxw.exe` runs the proxy without a console window and starts it again 5 seconds after a failure; `slopmax stop` stops both. Before, the proxy on Windows ran only until it was stopped or you logged out.
- `slopmax setup` asks what to do with CLIProxyAPI's logins: follow them while CLIProxyAPI keeps renewing them, take them over so slopmax renews them (signing CLIProxyAPI's copies out), or skip them. It used to offer only following. Unattended, `--own` takes them over.
- `slopmax status` says when accounts follow CLIProxyAPI, and that `slopmax own all` takes them over once it is stopped.

### Changed

- `slopmax login codex --no-browser` signs in with a device code, as on a machine without a browser, since the address may be opened on another machine. With device codes turned off for the workspace, it signs in at the address instead.

### Fixed

- `slopmax login codex --device` fails again when device codes are unavailable, as it did before 0.7.0, rather than waiting for an address nobody can paste when there is no terminal.
- A model refused at its limit is set aside on that account however its name is capitalized, so a request for `Claude-Fable-5-2` no longer goes back to the account that just refused `claude-fable-5-2`.

## [0.7.0] - 2026-11-15

### Added

- While the proxy is stopped, `slopmax status` says how to fill in the accounts it knows no usage for: `slopmax status --refresh` reads it once, and `slopmax start` keeps it current. Such accounts showed only dashes.

### Changed

- `slopmax login codex --device` falls back to signing in at the address, then pasting back the one the browser ends on, when the workspace has device codes turned off, rather than failing.
- `slopmax login claude --no-browser` signs in with the code Anthropic's page shows, as it does on a machine without a browser, since the address may be opened on another machine.

### Fixed

- Signing in to ChatGPT on a machine without a browser, such as a server reached over SSH, shows a device code to enter on any device, from `slopmax login codex` and from the dashboard as `slopmax setup` already did. It used to send the browser to a localhost page that cannot load.
- Over SSH, a sign-in no longer opens a browser on the far machine's screen, which nobody at the terminal sees, even when that machine has a desktop. It takes a code instead. The terminal decides this, not the proxy, which runs without SSH in its environment.

## [0.6.0] - 2026-11-14

### Added

- `slopmax usage` prices Claude Haiku 5.5, Claude Mythos 5.2, Claude Opus 4.5 and Claude Sonnet 4.5, and GPT-6 Astra, GPT-6.1 Sol and Terra, and GPT-5.6 Sol, Terra and Luna, which Claude and ChatGPT now offer. Their usage showed no cost before.

### Fixed

- Claude Fable 5.2's usage is costed at its own list price, $8 and $40 per million tokens with cache reads at $0.20, rather than Fable 5.1's higher one, and Claude Sonnet 5.5's cache reads at $0.10 rather than $0.20. `slopmax usage` overstated both.

## [0.5.1] - 2026-11-13

### Fixed

- A thinking model behind a Chat endpoint that sends its answer in typed parts, as Mistral's do, now reaches Claude Code and Codex whole. slopmax dropped every part, so the answer came through with pieces missing, or empty, and Codex never showed the thinking.
- When a Chat endpoint sends a model's thinking under two names at once, `reasoning_content` and `reasoning`, Codex shows it once rather than twice.

## [0.5.0] - 2026-11-12

### Added

- Claude Fable 5.2 is priced, at Fable 5.1's rates. Its usage showed no cost before.

### Fixed

- Claude Code can run tools on a thinking model behind a Chat endpoint, such as DeepSeek's. From the second tool call on, the endpoint refused the request ("reasoning_content in the thinking mode must be passed back"), because Claude Code is not shown the model's thinking and so cannot send it back. slopmax now remembers that thinking and returns it with the turn it led to.
- Codex can compact a conversation on an endpoint that speaks Responses but cannot compact, such as Ollama's. The endpoint used to refuse the compaction request or answer it as an ordinary turn. slopmax now asks the model for a summary itself, as it already did for Chat endpoints.

## [0.4.4] - 2026-11-09

### Fixed

- Signing in to Claude works again. Since early November claude.ai refuses a sign-in that does not ask for the Console scope, as Claude Code's does, and shows "Invalid request format". Accounts already signed in were not affected.
- A Claude account or model refused at its limit is no longer set aside until the next billing month. When extra usage is the limit in question, Claude can report the month's end as the reset; slopmax now ignores any reset more than a week away, and waits the time Claude asks instead.
- ChatGPT accounts renew their sign-in once it is six days old rather than nine. ChatGPT now cancels sign-ins about a week after they are issued, although they claim ten days, which cost a refused request and a refresh each time.
- When ChatGPT answers Codex over its WebSocket with "Codex is at capacity" (`turn_rate_limit_exceeded`), Codex moves to another account, as it already did over HTTP, and the account is set aside only for as long as ChatGPT asks.
- A tool Claude Code adds partway through a conversation, such as a subagent's `SubagentHandback`, now reaches GPT models too. Before, the model was told the tool was available but could not call it.
- When a GPT model answers in two messages, saying what it is about to do and then answering, the two no longer run together in Claude Code and Chat clients.
- A provider that accepts a connection but never completes the TLS handshake now fails the request after 20 seconds, and slopmax moves on, where it used to wait 10 minutes.

## [0.4.3] - 2026-11-09

### Changed

- Claude's plans go by their new names: Max 20x is Ultra and Max 5x is Max, as Anthropic renamed them on 2026-10-30. Accounts signed in before then are renamed at their next usage check. `[plan_prices]` takes `"claude/ultra"` and `"claude/max"`, and the old names still work.
- A pool's usage weighs Claude plans by their weekly allowance, 5 and 10 times Pro's for Max and Ultra, where Max 20x used to count as 20.

### Fixed

- Plans without a 5-hour limit, Claude Ultra once verified and ChatGPT Pro, no longer make a pool's 5-hour window look fuller than it is. They count as room in it, so a spent 5-hour window on another account shows as part of the pool rather than all of it.

## [0.4.2] - 2026-11-09

### Fixed

- Signing in to Claude on a machine without a browser, such as a server reached over SSH, no longer sends the browser to a localhost page that cannot load. Anthropic's own page shows a code to paste back instead, as Claude Code does. The dashboard asks for the code too. With a browser on the same machine, nothing changes.

## [0.4.1] - 2026-11-09

### Security

- rustls 0.23.46, which fixes GHSA-c8m5-c952-6cm4, GHSA-h2v8-394m-p7vv, GHSA-w44r-93j7-qv28 and GHSA-vp88-798v-h67f.

### Fixed

- On Windows, asking whether the proxy runs when it does not (`slopmax status`, the apps, `doctor`) answers at once instead of after a second or two. Windows sends a refused connection's SYN again before giving up; slopmax now turns that off for connections to this machine, as curl and Chrome do.

## [0.4.0] - 2026-11-09

### Added

- A native macOS app (`apple/`): a menu bar item showing the fullest pool window, and a window with the overview, accounts, usage charts, recent requests, settings and sign-in, in SwiftUI. It is a client of the daemon's API and its event stream, with no logic of its own: the daemon is the bundled CLI, run at login as a launch agent, and an update restarts it (`/shutdown {"restart": true}`, exit 75). Its core (`SlopmaxKit`) decodes the same contract fixtures as Rust and TypeScript, and is tested on macOS and Linux.
- `slopmax daemon-info --json` says where the proxy listens, its key, whether one answers there and which version, the path of this binary, and the login service's state, for the apps that drive it.
- `slopmax-client`, a typed client of `/slopmax/api` and its event stream, which the CLI and the desktop app reach the proxy with.
- A sign-in started through the API (`POST /slopmax/api/logins`) takes a `label` for the account and `noBrowser`, for a client that opens the address itself.
- slopmax's typed API, under `/slopmax/api`: status, refresh, sync, shutdown (with `{"restart": true}`, which exits 75 so the service manager starts it again), accounts (add a key or an endpoint, change, pin, unpin, own, remove, redeem a limit reset), imports, sign-ins started from a browser with their progress on the event stream, settings, client keys, agents, usage, history, and one event stream (`/events`) that pushes the report whenever it changes, each request as it is answered, and sign-in progress, so nothing polls. It is the API the TypeScript UI and the coming macOS app speak; `contract/` holds Rust and TypeScript to the same wire format. The `/slopmax/*` endpoints stay as they are until the dashboard has moved to it.
- Claude's limit resets, such as the one Pro and Max accounts got at Claude Opus 5.5's launch, are listed and redeemed as ChatGPT's are: on request (`slopmax redeem`), in the last three hours before one would expire unused, and when every Claude account is spent (`redeem_when_exhausted`). Claude lists and spends them for Claude Code alone, so slopmax makes those two calls with the user agent Claude Code last sent through it, and neither before Claude Code has sent a request.
- The dashboard's API can rename (`/slopmax/accounts/<id>/label`) and remove (`…/remove`) accounts, and `POST /slopmax/sync` applies changes made on disk at once instead of at the proxy's next check.
- A `round-robin` strategy hands each new session to the account handed one longest ago. An agent's housekeeping, such as Claude Code listing models before a session, takes no turn.
- `session_affinity = false` places every request by the strategy, for load balancing at the cost of the prompt cache. A request can decide for itself with the header `x-slopmax-affinity: on` or `off`. The session's last account is still remembered, so state another account minted is dropped when a request lands elsewhere. slopmax's own `x-slopmax-*` headers never reach a provider.
- A server error (500, 502, 503, 504, or 529) is retried once on the same account, keeping the session's cache, then on the next account; the client sees it only when every account answered so.
- The proxy applies a changed config.toml without a restart; only the address needs one. Background tasks such as polling and redeeming read the config each time they run.
- `GET` and `POST /slopmax/settings` read and change the strategy, session affinity, and the redeem settings while the proxy runs, keeping config.toml's comments. `GET /slopmax/history` serves the same usage analytics the desktop app charts: tokens, cost, failovers, caching, speed, and the split by account, model, and agent.
- API prices for GPT-6 Sol and Luna, so ChatGPT usage is costed beside Claude's.
- `slopmax setup` takes you from nothing to a running proxy: choose the kinds of accounts to pool and sign in or add keys, choose the strategy and session affinity, wire the agents, and start the proxy at login. With `--yes`, or without a terminal, it asks nothing and takes flags instead (`--import`, `--login`, `--keys-from-env`, `--strategy`, `--affinity`, `--agents`, `--no-service`), so an agent or a script can run it. `slopmax init` is its alias, and `slopmax setup <agent>` still wires one agent.
- `slopmax config` lists the settings that apply while the proxy runs, shows one, or changes one and has the proxy apply it at once.
- Left on the table: slopmax notes each window that resets with how much of it was used, and values the unused part of each week at the plan's price (list prices, or `[plan_prices]`). `slopmax usage`, the dashboard, and the app show it by account.
- Two notifications, on by default: `reset-expiring`, a limit reset lapsing within the day that slopmax won't redeem by itself, and `quota-unused`, a week resetting within the day with a quarter or more unused. `slopmax status`, the dashboard, and the app list them, and the app posts them.
- Each pool says where a new session would go and why (`slopmax status`, `/slopmax/status`), and shows its model-scoped windows, such as a weekly Fable cap.
- slopmax's icon, a glass Option key (⌥) on a cobalt tile, everywhere slopmax shows one: the README, the dashboard's logo and favicon, the macOS app's icon and menu bar glyph, the desktop app's logo, tray and bundle, and `slopmax.exe` on Windows. Its Blender source and the script that derives every size are in `assets/icon`. The cobalt replaces the pink as the accent.

### Removed

- The first API under `/slopmax/` (`/slopmax/status`, `/slopmax/accounts/<id>/<action>`, `/slopmax/events` and the rest): every client of slopmax's own uses `/slopmax/api`, and the old addresses answer 404, naming it. A script that called them moves to the matching `/slopmax/api` endpoint, listed in the README.
- The TypeScript slopmax (its engine, CLI and Electron app), which was measured against the Rust one and lost in every configuration. Rust is the one core and CLI. The web dashboard stays, moved to `web/`, on `@slopmax/client`, the TypeScript client of the API.

### Changed

- The proxy keeps the windows that reset in its usage ledger, beside the month's requests, instead of in `windows.jsonl`, which is still read for what earlier versions wrote.
- A pin set, dropped, or taken away by removing an account is saved the moment it changes. The proxy's background work runs every 30 seconds rather than 15, waking six times a minute while idle; a notice comes at most 30 seconds after its cause.
- A client key with a name already taken is refused with 409 Conflict, and a setting the API cannot take with 400, rather than 500.
- The proxy, its API and its background work are their own crate, `slopmax-daemon`, on the engine, `slopmax-core`; neither reads the environment behind its caller, so every path comes from the home the CLI or the daemon starts with.
- While the proxy runs, the CLI changes what it holds through its API instead of in the files: `use`, `label`, `priority`, `enable`, `disable`, `remove`, `own`, `redeem`, `import`, `login`, `key` and `config`. A sign-in started from the CLI follows the proxy's progress events, takes an address pasted from another machine, and cancels on Ctrl-C. With no proxy running, the CLI changes the files itself, as before.
- `slopmax status --watch` follows the proxy's event stream, redrawing the moment the report changes and once a minute for its countdowns, instead of asking every 5 seconds. `slopmax status --json` prints the API's report (camelCase, as `/slopmax/api/status` answers), from the proxy or read from disk.
- The pins `slopmax use` sets, the nudges already told, and what was last seen of Codex live in `state.toml`, which the proxy alone writes while it runs; `pins.toml` and `nudged.toml` are read once into it and left in place. The proxy no longer reads a month of the ledger at every start to find the model Codex used last.
- The usage history (`/slopmax/api/history`, the app's charts) is kept by the hour in the proxy once first asked for, and added to as each request is answered, so it answers in about a millisecond without reading the ledger again. Medians of time to first byte and of speed are within 0.1% of the exact ones.
- The desktop app is a client of the proxy's API and nothing else: it changes nothing on disk, follows the event stream instead of asking every 2 seconds, and posts the notices the proxy tells, which the proxy remembers across restarts, instead of deciding them itself. It runs the slopmax CLI it ships with to find, start, and install the proxy. Its notification switch is kept in `app.toml`; the `desktop-notified` file is no longer used.
- The proxy's background work (saving state, watching for notices, the rescan, polls, limit resets, warming, refreshes) runs on one timer instead of eight, waking about once every 15 seconds while idle, and the state is written only when it changed. The notices it tells now also go out on the API's event stream, which the macOS app posts as notifications.
- slopmax keeps its accounts and state as TOML (`accounts/<id>.toml`, `state.toml`), like `config.toml`. The JSON files earlier versions wrote are converted the first time they are read, and removed; an earlier version will not see the converted files. The usage ledger stays one JSON line per request, which keeps each record one atomic append.
- The dashboard is the React UI the desktop app has, served by the proxy at `/slopmax/` and built into the binary (about 300 KB, gzip-compressed, on the system's font). It speaks the typed API and follows the event stream, so it updates the moment something changes instead of every few seconds. `slopmax dashboard` opens it; the old address, `/slopmax/dashboard`, leads there.
- The proxy runs on one thread, which carries a desktop's agents with room to spare, adds less to each request, and holds less memory. `SLOPMAX_WORKERS` spreads it over more threads (`auto` for one per CPU, which the Docker image sets) for a proxy shared by many clients.
- The proxy serves requests from the accounts it holds in memory, and no longer reads an account's file for each one. It learns of changes when told (`POST /slopmax/sync`, which the CLI now sends after each change to accounts or pins) and checks the files for any it was not told of every 30 seconds, instead of reading every account every 2 seconds.
- A usage record is written to the ledger as the request ends, in one write to the month file the proxy keeps open, instead of by a background writer.
- The ledger records how a streamed answer ended when it did not complete (`"end"`: the upstream broke it off, it stalled, the agent hung up, or the proxy stopped). A stream the upstream broke off, stalled, or cut by a stop counts as a failure; one the agent hung up on, as when you interrupt Claude Code, does not.
- A request body is checked for its framing instead of parsed whole, which costs a third as much on a long conversation. A key held to some models still has its body parsed in full.
- A Codex WebSocket is relayed by one task instead of four, reading only the type of each message unless it must edit one. When slopmax stops it closes each open socket with 1001 (going away), so Codex reconnects, and records the turn it cut short; a socket that carries nothing either way for 10 minutes is closed.
- Translating a long conversation for a model of another format runs beside the proxy's thread instead of on it, so the other streams it carries do not wait on it.
- Reset credits are now called limit resets, as claude.ai calls Claude's; on Claude, credits are money.
- The dashboard counts an account's limit resets as listed, and offers Redeem on any account that holds one, not just ChatGPT's.
- The source is a Cargo workspace: the `slopmax` CLI on top of `slopmax-core`, the engine it shares with the coming desktop app, and three small libraries beneath. Installing from source now names the package: `cargo install --locked --git https://github.com/KaBankz/slopmax slopmax`.
- Removing an account through the dashboard's API also drops its pin, as `slopmax remove` does.
- Without a running proxy, `slopmax status --refresh` shows a failed usage poll as the account's last error instead of a warning line above the table.
- The page the browser lands on after signing in says to return to slopmax, not to the terminal.

### Fixed

- Windows: a proxy `slopmax start` left running held the CLI's output open, so a script or agent that read it waited until the proxy stopped.
- Windows: `slopmax doctor` said Claude Code and Codex were not installed, looking on PATH for `claude` and `codex` rather than `claude.exe` or `codex.cmd`; the desktop app finds the CLI the same way.
- Windows: a second `slopmax serve` on the same home now names the process that serves it, as it does elsewhere.
- The desktop app redrew its whole window every second for its countdowns, which kept a CPU busy where the GPU is drawn in software. It now redraws when a countdown it shows would read differently: each second only while one shows seconds, otherwise each minute or hour.
- Several clients refreshing at once (the dashboard, the app, `slopmax status --refresh`) each polled every account; a refresh asked for while one runs now waits for it and shares what it found.
- An answer translated from another format and read whole could be recorded twice when it carried an error; it is recorded once, with the status the client got.
- A Codex stream that broke off while the proxy held back its start now reaches Codex as a broken stream instead of ending as if it had completed.
- The last usage records could be lost when the proxy stopped. Stopping now runs in order: open requests finish, background work in flight finishes, a token refresh in flight saves what it got, state is saved, and the ledger is flushed to disk.
- A refreshed token is saved before slopmax asks the provider who the account is, so a lookup that hangs or fails can no longer lose a token whose predecessor is already spent.
- A second `slopmax serve` on the same home refuses to start, naming the process that serves it, instead of racing the first for its files.
- An unreadable `state.json` no longer stops the proxy from starting: it is moved aside as `state.json.bad-<time>` and the proxy starts without it.
- Stopping the proxy no longer waits 10 seconds while a dashboard follows its events.
- The `7d` and `30d` usage ranges start at the first day's own midnight when they span a daylight saving change, instead of an hour off.
- A `Retry-After` days or years away no longer sidelines an account for good: a week is the longest wait taken, and one that is not a number or a date is ignored.
- Changing an account from the dashboard no longer holds up requests while a token refresh holds the account's lock, and reading usage no longer holds them up while the ledger is read.
- Two writes of the same file at once within one process no longer share a temporary file, and a replaced file's directory is synced so the replacement outlasts a crash.
- A log line is written whole, in one write, instead of in pieces that another thread's line could split.
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

[Unreleased]: https://github.com/KaBankz/slopmax/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/KaBankz/slopmax/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/KaBankz/slopmax/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/KaBankz/slopmax/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/KaBankz/slopmax/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/KaBankz/slopmax/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/KaBankz/slopmax/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/KaBankz/slopmax/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/KaBankz/slopmax/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/KaBankz/slopmax/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/KaBankz/slopmax/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/KaBankz/slopmax/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/KaBankz/slopmax/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/KaBankz/slopmax/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/KaBankz/slopmax/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/KaBankz/slopmax/releases/tag/v0.1.0

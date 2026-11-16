# Architecture

slopmax is a thin proxy. For each request it decides which account serves it, swaps in that account's credential, and streams the answer back. When the account's API speaks another format than the client, it translates. Everything else (usage windows, failover, the ledger, notifications) exists to make that decision well or to report on it.

Three registries keep the code open to new services without spreading special cases through it:

| Registry                | Lists                                   | Where                                   |
| ----------------------- | --------------------------------------- | --------------------------------------- |
| Providers               | The services accounts belong to         | `ProviderId::get` in `slopmax-core/src/provider/mod.rs` |
| Agents                  | The programs slopmax wires up and serves | `AGENTS` in `slopmax-core/src/agent/mod.rs`          |
| Formats                 | The API formats requests arrive in      | `Dialect` and `slopmax-wire/src/translate.rs`        |

Code outside those modules talks to a provider, agent, or format only through its trait or enum. Adding one means one new module plus one registry line.

## Ground rules

- **Forward, don't rewrite.** A request in a format the account speaks goes out as the client sent it, except for the credential (and, for Claude, the OAuth beta flag subscription tokens require). Byte-level edits go through `proxy/rawjson.rs`, which changes a value in place instead of re-serializing the body.
- **Claude serves Claude Code, SuperGrok serves Grok Build.** Anthropic allows subscription logins in Claude Code only, and a SuperGrok sign-in grants access for Grok Build. Providers declare `agent_only: Some("claude")` (or `Some("grok")`), routing refuses other clients, and nothing is ever translated *into* Anthropic's format. slopmax does not imitate Claude Code or alter what it says about itself, with one exception: Claude lists and spends limit resets for Claude Code alone, so those two calls carry the user agent Claude Code last sent through the proxy, and are not made before it has sent one (`provider/claude/credits.rs`).
- **Identify honestly.** Translated requests carry `user-agent: slopmax/<version>`, not the client's, as do the calls slopmax makes itself, but for Claude's limit resets above.
- **Fail over before the first byte.** Once a response streams to the client it is passed through; a failure after that reaches the client in its own format.

## Crates

The workspace is a flat `crates/` directory, each folder named after its crate:

```
crates/
  slopmax          the CLI: the `slopmax` binary, its parser, questions, and printing
  slopmax-daemon   the daemon: the proxy, /slopmax/api and its event stream, the web UI,
                   and the background jobs, on the engine
  slopmax-launcher slopmaxw.exe, which runs the proxy at login on Windows with no console
                   window and starts it again after a failure; std only
  slopmax-core     the engine: accounts, sign-in, providers, the pool, the ledger, the report
  slopmax-api      the API's types, as every client sees them
  slopmax-client   a typed client of /slopmax/api and its event stream
  slopmax-wire     the API formats and translation between them; no I/O
  slopmax-net      HTTP/1.1 client and server on hyper and rustls, WebSocket frames, and
                   which headers cross the proxy
  slopmax-common   time, ids, the logger, short formats for people, and slopmax's home
web/               the web UI the daemon serves (React), and @slopmax/client, its client
                   of the API
contract/          the API's answers as the daemon gives them, which the web UI's client decodes
```

Dependencies point one way: `slopmax-common` under `slopmax-net`, `slopmax-wire` and `slopmax-api`; those under `slopmax-core` and `slopmax-client`; the core under the daemon; and the daemon, the core and the client under the CLI. The core re-exports the crates beneath it (`slopmax_core::net`, `::wire`, `::time`, `::log`).

### One writer, many clients

While a daemon serves a home it is the only process that writes what it holds: accounts, `state.toml` (pins included) and config.toml's live settings and keys. Every front end changes them through `/slopmax/api`:

- The CLI checks for a daemon at the address config.toml gives (`commands::daemon`) and, when one answers, sends each change through `slopmax-client`: `use`, `label`, `priority`, `enable`, `disable`, `remove`, `own`, `redeem`, `import`, `login` (a subscription's sign-in follows `Event::Login` on the event stream), `key` and `config`. With none running it calls the engine itself: `account::pin`, `state::change` under the serve lock, `auth::connect`, `import::save`.
- `status` reads the API's `Report`, from the daemon or mapped from disk (`api::report`); `--watch` redraws as the event stream pushes it.
- The web UI is an API client and nothing more.

### Hub mode

A machine with `[hub] url` in config.toml uses another machine's slopmax, the hub, and runs no proxy of its own. `Config::agent_base()` and `Config::agent_token()` give the hub's URL and its key, or the placeholder token `tailnet` when the hub knows the machine by its tailnet identity; Claude Code's and Codex's wiring and the doctor's agent checks read them. `Config::base_url()` stays this machine's own address, so `start`, `stop`, `serve`, `service` and the background client never aim at the hub: they refuse in hub mode (`Config::hub_refusal`). Every other command goes to the hub's API through `Client::remote`, which speaks HTTPS with the system's roots and allows the first handshake 30 seconds, because `tailscale serve` makes its certificate then. A hub that doesn't answer is an error, never a reason to read this machine's files: the hub is the one writer of its accounts, and refreshing a login on two machines signs one of them out.

The engine's errors at these boundaries are typed (`error.rs`: `StoreError`, `ConfigError`, `LoginError`, `ProviderError`, `ListenError`), and `api.rs` turns each into the API's error once. Nothing in the engine reads the terminal, prints, or reads the environment: paths come from a `Home`, made once by the CLI or the daemon.

### Modules

```
slopmax/src/
  main.rs       entry point; commands.rs (the command table and dispatch) and commands/,
                among them tailscale.rs (`slopmax tailscale`: publishing, users, admins)
                and remote.rs (`setup --hub`: finding a hub, its key, wiring the agents)
  args.rs       the table-driven parser; term.rs reads input; ui.rs styles output

slopmax-core/src/
  config.rs     ~/.slopmax/config.toml, with a commented template; [tailscale] and [hub]
  tailscale.rs  the `tailscale` CLI: finding it, running it with a timeout, reading its
                status, serve config and whois as JSON, publishing and unpublishing, and
                the tailnet view the API and `tailscale status --json` both show
  account.rs    Account (OAuth tokens or a key, optional Endpoint and Link), the file Store, pins
  auth/         sign-in events, browser and device logins, PKCE, the callback server, refresh under a file lock
  import.rs     logins from Claude Code, Codex, and CLIProxyAPI (linked or copied)
  provider/     the Provider trait and Spec; claude/, codex/, keys.rs, compat.rs
  agent/        the Agent trait; claude_code.rs, codex.rs
  route.rs      model → steps: providers, accounts, and model names to try, in order
  pool.rs       account health, session affinity (and opting out of it), and placement
                strategies; `Routing` is the part of the config it follows
  limits.rs     usage windows and refusals, shared by the provider parsers
  proxy/        mod.rs (App, the handler, keys), forward.rs (the failover loop), relay.rs
                and start.rs (the streamed body, its taps and holds), transcode.rs
                (translated streams), socket.rs (Codex's WebSockets), models.rs
                (/v1/models), api.rs (/slopmax/api), ui.rs (the web UI at /slopmax/),
                hub.rs (CLIProxyAPI's management calls for quota tools), tailnet.rs
                (tailnet identity: the ingress strip, who is calling and with what
                access, the whois cache), warm.rs (window warmups); in slopmax-daemon
  background.rs the proxy seen from outside: its client, starting it, the login service
  ledger.rs     the usage ledger; summary.rs totals it; history.rs charts it (for the
                dashboard); pricing.rs prices it; quota.rs records
                the pools' quota in it and forecasts each pool (`/pools/{provider}`);
                browse.rs lists its requests one by one, filtered (`/requests`)
  notify.rs     webhook and command notifications from account changes
  report.rs     the status report; doctor.rs the setup checks; service.rs systemd and launchd
  paths.rs      Home: a slopmax directory and its files (the proxy carries its own)
  fsx.rs        private files: atomic writes, locks, owner-only modes

slopmax-wire/src/   errors and usage per Dialect; ir.rs and one codec per format
slopmax-net/src/    client.rs (pooling, TLS, CONNECT and SOCKS5 proxies), server.rs, ws.rs (RFC 6455)
slopmax-common/src/ time.rs, log.rs, ids.rs, human.rs: small in-house replacements for crates
```

## A request's path

1. **`proxy::handle`** first takes what the tailnet says of the request (`tailnet::take`). The listener that accepted the connection set its `Channel` (`Tcp` for the local port, `Tailnet` for the owner-only socket tailscaled connects to), and only the listener sets it, with one exception before `take`: a TCP request under the owner key's private path (`tailnet::route`) has the path taken off, and is marked `Tailnet` when on Linux the client end of its connection belongs to root or this user (`net::peer::uid`, from `/proc/net/tcp`), and elsewhere always. On the tailnet channel `take` reads the login `tailscale serve` adds, the peer's tailnet address, and whether it came through Funnel; on both channels it then removes every `Tailscale-*`, `X-Forwarded-*` and `Forwarded` header, so none is trusted from a local client and none goes upstream. `handle` answers slopmax's own endpoints (`/healthz`, `/slopmax/*`, the OpenAI-style `/v1/models`) and hands the rest to `proxy`. Each asks `tailnet::admit` for the access it needs: `use` for the proxy and the model list, `view` for status, events, usage, history and the tailnet's view, and `admin` for everything else. The owner key is admin and a client key is use. A login in `[tailscale] users` is use and view, and admin only from a machine in `[tailscale] admins`, which `tailscale whois` on the peer's address must confirm (it fails closed). Funnel is refused before anything else, even with a key.
2. **`proxy::route`** reads the path into a `Target`: the client's format, the provider the path belongs to (`/claude/*`, `/codex/*`, or `/v1/*` by shape), and whether the body's model picks the provider.
3. **`forward::Inbound`** buffers the body (so it can be replayed on another account) and reads the agent, the session, and the model from it.
4. **`route::plan`** turns the model into `Step`s: each provider with an account that serves the model, subscriptions first, then paid overflow, selectors, aliases, and fallbacks. It drops accounts that may not serve this client (`agent_only`) or that speak a format it cannot be translated into.
5. **`Pool::pick`** chooses an account for each step: the session's own account if it can still serve (unless affinity is off for the proxy or, by `x-slopmax-affinity`, the request), else the `slopmax use` pin, else the strategy within the top priority tier. The session's last account is remembered either way, so a move is known and account-bound state dropped.
6. **`forward::attempt`** refreshes the token if due, then builds the outbound request. If the account speaks the client's format it is the client's own request with the credential swapped (`Provider::headers`, `Provider::rebind` when the session moved). If not, `wire::translate` decodes it into the common form and encodes it for the account's API (`Provider::shape` adds last touches).
7. **The answer.** Rate-limit headers update the account's windows (`Provider::limits`). A refusal is classified by `Provider::verdict` into a `Verdict` (exhausted, throttled, unauthorized, stale state, or final), which decides whether to block the account and try the next. For Codex the first moments of the stream are held (`proxy/start.rs`) to catch refusals inside a 200.
8. **Streaming back.** `proxy/sse.rs`'s `Tapped` watches the stream for token usage and records the request in the ledger when it ends. A translated answer also passes through `proxy/transcode.rs`, which reads the upstream's events and writes the client's.

Codex's WebSockets take a different path, through `proxy/socket.rs`. The handshake is routed like a request, using the model from Codex's `x-codex-routing-hint`. slopmax opens ChatGPT's socket on the chosen account (`net/ws.rs` frames both), then relays messages both ways. On the way it reads `codex.rate_limits` events and finished turns, and closes the socket when the account is spent so Codex reconnects on another. Anything it cannot relay is answered 426, and Codex falls back to HTTP.

## Providers

```rust
pub trait Provider: Send + Sync {
    fn spec(&self) -> &'static Spec;                       // id, title, API base, formats, models, billing, policy
    fn identity(&self, account: &Account) -> Option<String>;
    fn login<'a>(&'a self, http: &'a Client, options: LoginOptions, prompt: Prompt) -> BoxFuture<'a, Result<Account>>;
    fn headers(&self, client: &HeaderMap, account: &Account, moved: bool) -> HeaderMap;
    fn verdict(&self, status, headers, body, model, now) -> Verdict;
    // with defaults: refresh, identify, usage, limits, rebind, shape, api, dialects, serves, catalog, credits
}
```

`Spec` holds what a provider is rather than what it does: its API base, the formats it speaks, the models it serves (patterns such as `claude-*`), whether it is a subscription or metered (and which subscription a metered provider backs up), the one agent allowed to use it, if any, and what its accounts sign in with (`Credential`: OAuth, perhaps with a device code, or a key), which tells a front end whether to open a browser or ask for a key. Async methods return a hand-written `BoxFuture`, which keeps the trait object-safe without a macro crate.

### Adding an API-key provider

A provider that takes a bearer key and speaks an OpenAI-style format is one static in `slopmax-core/src/provider/keys.rs`:

```rust
static MISTRAL_SPEC: Spec = Spec {
    id: "mistral",
    title: "Mistral API",
    api: "https://api.mistral.ai/v1",
    dialects: &[Dialect::Chat],
    models: &["mistral-*", "codestral-*", "devstral-*"],
    billing: Billing::Metered { backs: None },
    agent_only: None,
    refresh_lead: SignedDuration::ZERO,
    credential: Credential::Key { optional: false },
};

pub static MISTRAL: KeyProvider = KeyProvider {
    id: ProviderId::Mistral,
    spec: &MISTRAL_SPEC,
    models_url: "https://api.mistral.ai/v1/models",
};
```

Then add `Mistral` to `ProviderId`, its `ALL` list, and `ProviderId::get`, and a choice to `PROVIDERS` in `slopmax/src/commands.rs`. Login, routing, translation from every client format, model lists, status, the ledger, and notifications all follow from the trait.

### A subscription: SuperGrok

A subscription signs in with OAuth and has usage windows; it gets a directory like `provider/codex/`. SuperGrok's is the smallest, and the one to copy:

```
slopmax-core/src/provider/grok/
  mod.rs      the Spec, the Provider impl, usage from /billing, the plan from /settings, the catalog from /models
  oauth.rs    xAI's device-code sign-in and refresh, with Grok Build's public client id
```

```rust
static SPEC: Spec = Spec {
    id: "grok",
    title: "SuperGrok",
    api: "https://cli-chat-proxy.grok.com/v1",  // the CLI chat proxy Grok Build talks to
    dialects: &[Dialect::Responses, Dialect::Chat],
    models: &["grok-*"],
    billing: Billing::Subscription,
    agent_only: Some("grok"),                   // the sign-in grants `grok-cli:access`
    refresh_lead: SignedDuration::from_mins(30), // tokens live six hours
    credential: Credential::OAuth { device: true },
};
```

Its `headers` put the account's token in place of the slopmax key and leave Grok Build's own headers as they came. `verdict` reads a spent allowance (429 or 402 naming a usage limit) apart from throttling, and maps the 403 xAI sends for an invalidated token to `Unauthorized`. `rebind` and the stale-state check reuse Codex's, since both speak Responses with encrypted reasoning. The plan's allowance is monthly, so `usage` reads `/billing` into one `30d` window that resets with the billing period. xAI API keys say `backs: Some(ProviderId::Grok)`: they become paid overflow for Grok Build's traffic, and still serve `grok-*` to every other client, which SuperGrok does not serve (`route::steps_for` gates overflow only on a subscription the client may use).

## Agents

```rust
pub trait Agent: Send + Sync {
    fn id(&self) -> &'static str;                    // its CLI name: `claude`, `codex`
    fn title(&self) -> &'static str;
    fn provider(&self) -> ProviderId;                // the subscription it uses natively
    fn detect(&self, headers: &HeaderMap) -> bool;   // from headers it always sends, such as its user agent
    fn session(&self, headers: &HeaderMap, body: &[u8]) -> Option<String>;
    fn command(&self, config: &Config, home: &Home, args: &[String]) -> Command; // `slopmax run`
    fn env(&self, config: &Config, home: &Home, exe: &Path) -> String;          // `slopmax env`
    fn config_file(&self) -> PathBuf;
    fn setup(&self, config: &Config, file: &Path, saved: &mut Option<Value>) -> Result<()>;
    fn undo(&self, file: &Path, saved: Value) -> Result<()>;
    // plus setup_note, has_login, wired_to, import
}
```

`agent::setup` and `agent::undo` own the file handling around `setup` and `undo`: following symlinks, private file modes, and the backup in `~/.slopmax/setup-backup.json`. An agent only edits the document.

### An agent: Grok Build

`agent/grok.rs`. Grok Build names itself `grok-shell/<version>` (or `grok-pager/…`), and every model request of a session, its title included, carries `x-grok-conv-group-id`, the session key. It is wired with two settings Grok Build has for enterprise proxies: the CLI chat proxy's address (`GROK_CLI_CHAT_PROXY_BASE_URL`, or `[endpoints] cli_chat_proxy_base_url`) and an external auth provider, a command whose output is the token (`GROK_AUTH_PROVIDER_COMMAND`, or `[grok_com_config] auth_provider_command`). The command is `echo <slopmax key>`, which runs alike under sh, cmd and PowerShell, the shells Grok Build may use.

Grok Build stores the token it gets and keeps a bare one for good, even after a 401. So `run` and `env` point `GROK_AUTH_PATH` at a file in slopmax's home named after the key (`Home::grok_auth`): a new key is a new file, and Grok Build's own sign-in in `~/.grok/auth.json` is never touched. `setup` has no such setting, so `setup` and `--undo` remove the tokens an auth provider handed it from `~/.grok/auth.json` (`auth_mode = "external"`), keeping its own sign-in, which `doctor` flags since it would come first. Grok Build reads `/v1/settings` and `/v1/models` from the CLI chat proxy, which xAI keys can't answer, so `served_by_keys` is false: a key alone doesn't make it servable.

Add the agent to `AGENTS` and a choice to `AGENTS` in `slopmax/src/commands.rs`; `slopmax run grok`, `env grok`, `setup grok`, session affinity, and the `agent_only` policy then work for it.

## Formats

Each format (`Dialect`) knows its error shape, its usage-limit reply, where its stream reports usage, and how its streams open. Translation goes through `wire/ir.rs`, a common form for requests (`Request`, `Message`, `Part`, `Tool`) and answers (`Event`: text, reasoning, opaque reasoning state, tool calls, done, error). Each format implements the sides it needs:

| Format (`slopmax-wire/src/<name>/`) | `request.rs`                    | `events.rs`                 | `reply.rs`                    |
| ----------------------- | ------------------------------- | --------------------------- | ----------------------------- |
| Messages                | decode client requests          | —                           | encode answers for clients    |
| Responses               | decode client requests, encode upstream requests | decode upstream streams | encode answers for clients |
| Chat                    | decode client requests, encode upstream requests | decode upstream streams | encode answers for clients |

So adding a format costs one codec, not one translator for each other format. Messages has no upstream side on purpose: Anthropic is never a translation target. `slopmax-wire/src/translate.rs` dispatches on `Dialect`, and the core's `proxy/transcode.rs` streams through it.

State a format cannot carry back is kept by slopmax: the encrypted reasoning an upstream issues is remembered per tool call (`transcode::Replay`) and restored on the next turn for the same account; Codex's remote compaction is emulated with a sealed summary (`slopmax-wire/src/responses/compaction.rs`).

## Background work

`daemon::run` takes the home's serve lock (`.serve.lock`, so a second daemon on the same home refuses to start), binds the listener, and starts the background tasks. On unix it also binds a second listener, `tailnet.sock`, every time, whatever the config says, so `slopmax tailscale on` needs no restart. The socket is 0600 in the home's 0700 directory, and each connection's peer must be root (tailscaled) or the home's owner. A stale socket left by a crash is replaced (the serve lock proves no daemon owns it), anything else at that path is left alone, and a socket that can't be bound never stops the proxy. Both listeners stop together, and the socket file is removed after the drain. The background tasks are:

- reloading the accounts when told (`POST /slopmax/api/sync`), and otherwise when a stat every 30 seconds shows a file changed, with config.toml when it changed. Requests use the accounts the pool holds in memory and read no files; a refresh puts its new tokens back into the pool. `App::config` is swapped whole; only the listener is bound for good;
- saving pool state (windows, blocks, sessions) every 10 seconds, so a restart keeps sessions on their accounts;
- refreshing tokens ahead of expiry (every 5 minutes), polling usage when due, listing limit resets, and warming idle windows (each checked every minute), and redeeming resets about to expire (every 30 minutes);
- watching account conditions every 30 seconds: notifications and nudges, told on the event stream and to the configured hooks, and remembered in `state.toml`; and each window that reset, written to the ledger for quota left on the table;
- reading each subscription pool's windows, and each working account's, every 2 minutes, and writing them to the ledger when they changed or an hour passed (`quota.rs`). The pool pages' forecasts are drawn from these readings: from the first time one is asked for, the daemon keeps the last week of them, and of what each account served in five-minute steps, as the history index keeps the month;
- following installs every minute: when the install the daemon runs from has a newer slopmax (its file replaced at the same path, or for mise a new version directory, then `mise where`), the daemon hands the proxy to it (below);
- looking up the newest release once a day (`update::latest`, the `releases/latest` redirect rather than GitHub's rate-limited API), kept in `update.toml` for `slopmax status`.

Each task reads the config as it runs, so a changed setting turns it on or off without a restart. A task that panics is logged and runs again on schedule.

Everything runs on one thread unless `SLOPMAX_WORKERS` asks for more (`daemon::runtime`), so nothing on it may block: file locks, the ledger reads behind `/slopmax/api/usage` and the history index's first build, and saves run through `blocking::run`. The one disk write left on the request path is the ledger's: one `write` per request to the month file it keeps open.

Stopping (a signal or `POST /slopmax/shutdown`) cancels `App::stop`, and then runs in order: the listener closes and open connections drain (event streams end at once), the background loops end and the work they started finishes (`App::tasks`), a token refresh in flight saves what it got (`auth::settle`), state is saved by the only writer left, and the ledger is synced to disk.

### Handing off

An update moves the proxy to a new binary without closing its socket (`handoff.rs`). The daemon stops starting background jobs, lets refreshes in flight save their tokens, saves its state, and from then on saves nothing. It starts `<new binary> serve` with the listening socket, the `.serve.lock` descriptor, and a pipe, named in `SLOPMAX_HANDOFF` with its own pid (so a process further down that inherits the variable takes nothing). The new daemon adopts them instead of binding and locking, reads the state, starts its jobs, and writes to the pipe once it serves. If it does not within 30 seconds, it is killed and the old daemon carries on as before.

Once the new one serves, the old one stops accepting, and the kernel's queue goes to the new one alone. The old one keeps what it has: requests under way finish (up to 30 minutes), a Codex socket in the middle of a turn finishes the turn and then closes, and any further request on an open connection is answered with `Connection: close`. It never closes an idle connection under a client that may be about to send on it. Nothing is refused and nothing is cut, as `handing_the_proxy_to_another_binary_refuses_and_cuts_off_nothing` checks.

The supervisor keeps seeing a running proxy. Under systemd the unit is `Type=notify` with `NotifyAccess=all`, and the old daemon names the new one the main process (`MAINPID=`) and exits once drained. launchd can't be told of a new process, so under it the old daemon starts the new one in a session of its own, and once drained exits with 75; launchd starts the service's binary again, and that process takes over from the new one (below). Elsewhere (`slopmaxw.exe`, a terminal) the old process stays: drained, it waits for the new one, passes on the signals it gets, and exits with its code. A stop or signal during the drain ends it at once. Windows can't hand the socket to a child this way, so there a move is a restart through `slopmaxw.exe`.

### The socket the service manager keeps

Between one process and the next, the service manager holds the listening socket, so connections wait in its queue rather than being refused (`supervisor.rs`). systemd keeps it in the unit's file-descriptor store: a daemon that listens sends it (`FDSTORE=1`, `FDNAME=listener`), and systemd passes it to each process it starts after that (`LISTEN_FDS`), through a crash or `systemctl restart`, until the service stops. The unit allows two descriptors, since systemd counts before it sees that a daemon offering the socket again offers the one it holds. A daemon given a socket for a listen address since changed takes it out of the store (`FDSTOREREMOVE=1`) and stores a fresh one. On start under systemd, a daemon also writes the unit anew when it predates this, and has systemd reload it.

launchd owns the socket outright: the plist names it (`Sockets`, `Listener`, on the listen address), launchd binds it when the agent loads, and each process it starts takes it with `launch_activate_socket`. When the process it started exits, launchd makes the socket blocking, and that flag belongs to the socket, so it holds for every process with a copy: a daemon serving launchd's socket that launchd did not start (told by `SLOPMAX_HANDOFF_LAUNCHD`) keeps making it non-blocking from a thread of its own, or its accept would wait for the next connection with its requests unanswered. Because launchd would also start the agent for a connection to that socket, `slopmax stop` unloads the agent (`launchctl bootout`), and `slopmax start` loads it again. Changing `listen` takes `slopmax service install`, which writes the plist anew.

A daemon given the service manager's socket can find the home still served: under launchd, by the process the proxy was handed to before launchd's started. It asks that one to make way through the socket they share (`POST /slopmax/api/shutdown {"makeWay": true}`, `handoff::make_way`): the other daemon lets refreshes in flight finish, saves its state, lets go of the serve lock, and then drains as after a handoff. The new daemon takes the lock and serves; connections that come in between wait in the queue. `a_proxy_started_on_the_kept_socket_takes_over_without_refusing_a_connection` checks this, and on a macOS runner `mise run launchd` runs the login agent itself through a crash, a handoff and launchd's process taking over, stop and start.

The login service runs `~/.slopmax/bin/slopmax`, a link the handoff and `slopmax update` point at the installed binary (`update::install`): mise keeps each version in its own directory and removes old ones a day after an upgrade, so a service that named a version's path would one day start a removed binary.

## Files

```
~/.slopmax/                 (SLOPMAX_HOME moves it; directories 0700, files 0600)
  config.toml, .config.lock (held while the first run writes the proxy's key)
  .serve.lock               held by the running daemon, naming its pid
  accounts/<provider>-<hash>.toml, .<id>.lock
  state.toml                windows, blocks, sessions, limit resets, the pins `slopmax use`
                            sets, the nudges already sent, what was last seen of Claude
                            Code and Codex (state.rs)
  usage/<year>-<month>.jsonl  each request answered, each window that reset with how
                            much of it was used (waste.rs), and the pools' quota
                            readings (quota.rs)
  windows.jsonl             each window that reset, as versions before 0.4 kept them (read,
                            never written: the ledger holds them now)
  bin/slopmax               the link the login service runs, moved to each new binary
  update.toml               the newest release, as last looked up
  setup-backup.json         what `setup` replaced
  tailnet.sock              the owner-only socket `tailscale serve --socket` reaches slopmax through
                            (unix; bound while the daemon runs)
  slopmax.log
```

While a daemon serves the home, it is the only writer of what it holds: the CLI and the web UI
change accounts, pins, settings and keys through `/slopmax/api` (`slopmax-client`), and the
CLI writes the files itself only while none runs, under the same serve lock
(`state::change`). `pins.toml` and `nudged.toml`, which an earlier layout kept beside the
state, are read once into it and left in place, so a downgrade still finds them.

slopmax's own files are TOML, the format of `config.toml`. A file an earlier version wrote as JSON
(`state.json`, an account's `.json`) is read once, written again as TOML, and removed
(`fsx::read_toml`). Three kinds stay JSON on purpose: the usage ledger and `windows.jsonl` are
append-only logs, where one JSON line per record is what makes each append a single atomic write
and a torn last line repairable (a TOML document cannot be appended to safely);
`setup-backup.json` holds other tools' settings exactly as they were, `null`s included, which TOML
cannot hold; and the files of other tools (Claude Code's `settings.json`, Codex's `auth.json`,
CLIProxyAPI's) are theirs.

## Tailscale

slopmax talks to Tailscale only through its CLI (`slopmax-core/src/tailscale.rs`), never through LocalAPI. LocalAPI has three transports (a unix socket on Linux, TCP with a same-user proof for the Mac app, a named pipe on Windows) and no promise of stability, and changing the serve config through it would mean rebuilding it and swapping it by ETag. The CLI's `--json` output is read loosely, so new fields don't break it, and every run has a timeout: 5 seconds to read, 2 for whois, 30 to change what is served, where the CLI's own output passes through so a prompt to enable HTTPS reaches the user. Nothing on the request path runs the CLI except whois for admin checks, cached for 10 minutes (10 seconds for a failure) with one lookup per address in flight; a request that only needs use never waits for it. slopmax never runs `sudo`, `tailscale set`, `up`, `down`, `funnel` or `serve reset`.

`tailscale serve` reaches slopmax at `http://127.0.0.1:<port>/.slopmax-tailnet-<hex>`, the hex the first 16 bytes of SHA-256 over the owner key (`tailscale::private_path`). Tailscale's `ReverseProxy` joins the target's path to each request's, so everything from the tailnet arrives under it, and `tailscale serve` adds who is asking. A local process could forge those headers, so they are believed only under the path, which Tailscale alone is told; but any local user may read the serve config back from tailscaled, so on Linux the connection's owner must be root or this user too. A proxy target with a path is neither a file handler nor a socket, so Tailscale's operator may publish it: since 1.104, serving a unix socket, anywhere in the serve config, takes root (tailscale/tailscale#22117), and before that an operator who passed a sudo check tailscaled ran under the account's full name, not its login. `--socket` still publishes `unix:<home>/tailnet.sock`, and the daemon always listens there; `--loopback` publishes the bare port, where only keys work. A private path made from an older owner key is still slopmax's: `tailscale on` replaces it, and doctor says so. Machine names are the first label of a machine's DNS name, never its HostName, which can be any text.

## Dependencies

The binary is about 9.6 MB, from 71 crates besides slopmax's own. The async stack is tokio, hyper, and rustls (with ring). serde_json, toml_edit, memchr, base64, thiserror and anyhow round it out. Time, logging, the CLI parser, form encoding, and the HTTP client conveniences are small in-house modules, because the crates for them each pull in far more than slopmax uses. A crate earns its place by doing its job measurably better than a small module would: faster, leaner, or more correct. The CI holds the tree to 71 crates and the binary to 10 MiB; raising either needs that reason in the commit. miniz_oxide (with adler2) is the newest: Anthropic gzips Claude's answers, and its streaming inflate lets slopmax read a copy of them for token usage; slopmax reads the gzip header itself. Before it, tokio-util's `CancellationToken` and `TaskTracker` let the daemon stop in order, for 30 KB.

## Performance

What slopmax adds to a request is small next to a model's answer, and it should stay that way. `mise run bench` measures it: `slopmax/examples/bench/` runs the real server (`daemon::serve`) in front of a mock provider that streams answers with usage and rate-limit headers, and `oha` drives Claude Code- and Codex-shaped requests through it, small ones and 300 KB conversations, one at a time and 32 at once.

On a 2-vCPU machine shared with the load generator and the mock (which answers a small request in 0.2 ms on its own):

| | Round trip through slopmax (p50) | 32 at once | Memory |
| --- | --- | --- | --- |
| Small request | 1.1 ms | 1,600 req/s | 7 MB idle |
| 300 KB request | 1.9 ms | 1,050 req/s | 40 MB peak under that load |

`slopmax --version` and `status` take about 2 ms, and `serve` answers about 22 ms after it starts.

Running on one thread (since v0.4), on an 8-vCPU machine with the proxy held to two cores (`scripts/perf/ab.sh`): a small request one at a time takes 0.80 ms at the median and 680 µs of CPU, where 4 worker threads took 1.35 ms and 1,600 µs, handing each request between threads (28 futex calls each). The daemon idles on one thread, waking 6 times a minute, in 4.6 MB (the static musl build). One thread tops out at about 1,400 small requests a second 32 at once, against 4,100 on four; `SLOPMAX_WORKERS=auto` gets those back, for a proxy shared by many clients. Each streamed chunk is still its own write, which is most of what the proxy spends in the kernel now.

The hot path keeps to a few rules:

- Request bodies are never parsed whole. `proxy/rawjson.rs` scans for the few values slopmax reads (`model`, `stream`, session ids) and stops once it has them, jumping over strings with SIMD search (`memchr`).
- The stream tap reads events in place and parses only those that mention usage or an error.
- Sockets set `TCP_NODELAY`, so each streamed event leaves as it arrives.
- Commands that only talk to the local proxy skip loading the system's trusted roots.

The allocator is the platform's own. mimalloc and jemalloc were 4 to 30% faster at 32 streams at once, but held 2 to 5 times the memory, and one person's agents rarely run that many. The `mimalloc` feature is there for a proxy shared by many clients, and the Docker image builds with it.

## Testing

- Unit tests sit next to the code: parsers and codecs against recorded shapes, the planner over tables of accounts, the pool's placement and failover.
- `slopmax-daemon/tests/proxy.rs` runs the real proxy against a mock provider on a local port. `net::Origins` rewrites the providers' base URLs to it, and the mock answers by bearer token, so each account can be made to succeed, hit its limit, or reject its token.
- `mise run check` runs rustfmt, clippy with warnings denied, and every test, as CI does: every CI job is a mise task, with the toolchain mise.toml pins.
- Unsafe code is denied across the workspace and allowed in exactly two places: reading the local time offset (`slopmax-common`) and turning off terminal echo while a secret is typed (the CLI).

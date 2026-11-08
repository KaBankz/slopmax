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
- **Claude serves Claude Code.** Anthropic allows subscription logins in Claude Code only. Providers declare `agent_only: Some("claude")`, routing refuses other clients, and nothing is ever translated *into* Anthropic's format. slopmax does not imitate Claude Code or alter what it says about itself, with one exception: Claude lists and spends limit resets for Claude Code alone, so those two calls carry the user agent Claude Code last sent through the proxy, and are not made before it has sent one (`provider/claude/credits.rs`).
- **Identify honestly.** Translated requests carry `user-agent: slopmax/<version>`, not the client's, as do the calls slopmax makes itself, but for Claude's limit resets above.
- **Fail over before the first byte.** Once a response streams to the client it is passed through; a failure after that reaches the client in its own format.

## Crates

The workspace is a flat `crates/` directory, each folder named after its crate:

```
crates/
  slopmax          the CLI: the `slopmax` binary, its parser, questions, and printing
  slopmax-daemon   the daemon: the proxy, /slopmax/api and its event stream, the web UI,
                   and the background jobs, on the engine
  slopmax-core     the engine: accounts, sign-in, providers, the pool, the ledger, the report
  slopmax-api      the API's types, as every client sees them
  slopmax-client   a typed client of /slopmax/api and its event stream
  slopmax-app      the desktop app apart from any UI toolkit: a client of the API
  slopmax-desktop-gpui
                   the desktop app's window and menu bar icon, drawn with GPUI over slopmax-app
  slopmax-wire     the API formats and translation between them; no I/O
  slopmax-net      HTTP/1.1 client and server on hyper and rustls, WebSocket frames, and
                   which headers cross the proxy
  slopmax-common   time, ids, the logger, short formats for people, and slopmax's home
apple/             the macOS app (SwiftUI) and SlopmaxKit, its client of the API
web/               the web UI the daemon serves (React), and @slopmax/client, its client
                   of the API
contract/          the API's answers as the daemon gives them, which every client decodes
```

Dependencies point one way: `slopmax-common` under `slopmax-net`, `slopmax-wire` and `slopmax-api`; those under `slopmax-core` and `slopmax-client`; the core under the daemon; and the daemon, the core and the client under the CLI. The core re-exports the crates beneath it (`slopmax_core::net`, `::wire`, `::time`, `::log`). The apps link neither the core nor the daemon: `cargo tree -p slopmax-app -e normal` has no `slopmax-core`, so they cannot write what the daemon holds.

### One writer, many clients

While a daemon serves a home it is the only process that writes what it holds: accounts, `state.toml` (pins included) and config.toml's live settings and keys. Every front end changes them through `/slopmax/api`:

- The CLI checks for a daemon at the address config.toml gives (`commands::daemon`) and, when one answers, sends each change through `slopmax-client`: `use`, `label`, `priority`, `enable`, `disable`, `remove`, `own`, `redeem`, `import`, `login` (a subscription's sign-in follows `Event::Login` on the event stream), `key` and `config`. With none running it calls the engine itself: `account::pin`, `state::change` under the serve lock, `auth::connect`, `import::save`.
- `status` reads the API's `Report`, from the daemon or mapped from disk (`api::report`); `--watch` redraws as the event stream pushes it.
- The desktop apps (SwiftUI on macOS, `slopmax-app` under GPUI elsewhere) and the web UI are API clients and nothing more. What the API cannot answer while no daemon runs (where it listens, starting it, installing the login service, the report from disk) they ask of the CLI they ship with: `daemon-info --json`, `start`, `service install`, `status --json`.

The engine's errors at these boundaries are typed (`error.rs`: `StoreError`, `ConfigError`, `LoginError`, `ProviderError`, `ListenError`), and `api.rs` turns each into the API's error once. Nothing in the engine reads the terminal, prints, or reads the environment: paths come from a `Home`, made once by the CLI or the daemon.

### The desktop app

`slopmax-app` is the app without a toolkit. `App::start` finds the daemon through the CLI, starts it if none runs, and follows its event stream on its own tokio runtime, keeping a `Snapshot` current: the proxy's state, the report, how the agents are wired, the login service, a sign-in in progress, and how the last action went. Every action is one API call. `view` turns a snapshot into what a window draws, and the menu bar's line; it reads the API's report, whose words come from the daemon.

A UI subscribes to the snapshot through a tokio `watch` channel, which any executor can await, draws it, and calls `App`'s methods; it holds no logic of its own. The GPUI crate draws the window this way.

### Modules

```
slopmax/src/
  main.rs       entry point; commands.rs (the command table and dispatch) and commands/
  args.rs       the table-driven parser; term.rs reads input; ui.rs styles output

slopmax-core/src/
  config.rs     ~/.slopmax/config.toml, with a commented template
  account.rs    Account (OAuth tokens or a key, optional Endpoint and Link), the file Store, pins
  auth/         sign-in events, browser and device logins, PKCE, the callback server, refresh under a file lock
  import.rs     logins from Claude Code, Codex, and CLIProxyAPI (linked or copied)
  provider/     the Provider trait and Spec; claude/, codex/, keys.rs, compat.rs
  agent/        the Agent trait; claude_code.rs, codex.rs
  route.rs      model → steps: providers, accounts, and model names to try, in order
  pool.rs       account health, session affinity (and opting out of it), and placement
                strategies; `Routing` is the part of the config it follows
  limits.rs     usage windows and refusals, shared by the provider parsers
  proxy/        mod.rs (App, the handler, keys), forward.rs (the failover loop), sse.rs and
                start.rs (stream taps and holds), transcode.rs (translated streams), socket.rs
                (Codex's WebSockets), models.rs (/v1/models), admin.rs and dashboard.html
                (/slopmax/*), hub.rs (CLIProxyAPI's management calls for quota tools),
                warm.rs (window warmups), rawjson.rs (in-place JSON edits)
  daemon.rs     the long-running proxy and its background tasks
  background.rs the proxy seen from outside: its client, starting it, the login service
  ledger.rs     the usage ledger; summary.rs totals it; history.rs charts it (for the
                app and the dashboard alike); pricing.rs prices it
  notify.rs     webhook and command notifications from account changes
  report.rs     the status report; doctor.rs the setup checks; service.rs systemd and launchd
  paths.rs      Home: a slopmax directory and its files (the proxy carries its own)
  fsx.rs        private files: atomic writes, locks, owner-only modes

slopmax-wire/src/   errors and usage per Dialect; ir.rs and one codec per format
slopmax-net/src/    client.rs (pooling, TLS, CONNECT and SOCKS5 proxies), server.rs, ws.rs (RFC 6455)
slopmax-common/src/ time.rs, log.rs, ids.rs, human.rs: small in-house replacements for crates
```

## A request's path

1. **`proxy::handle`** answers slopmax's own endpoints (`/healthz`, `/slopmax/*`, the OpenAI-style `/v1/models`) and hands the rest to `proxy`, which checks the slopmax key.
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

### Adding a subscription: SuperGrok

A subscription signs in with OAuth and has usage windows. It gets a directory like `provider/codex/`. For SuperGrok, as a sketch (the endpoints are placeholders until the provider is built against the real service):

```
slopmax-core/src/provider/grok/
  mod.rs      the Spec and the Provider impl
  oauth.rs    login (browser PKCE or device code) and refresh
  limits.rs   usage windows from the usage endpoint and from response headers
```

```rust
static SPEC: Spec = Spec {
    id: "grok",
    title: "SuperGrok",
    api: "https://…",                        // the API Grok Build talks to
    dialects: &[Dialect::Responses],         // whichever format that API speaks
    models: &["grok-*"],
    billing: Billing::Subscription,
    agent_only: None,                        // or Some("grok") if xAI limits it to its own agent
    refresh_lead: SignedDuration::from_hours(1),
    credential: Credential::OAuth { device: true },
};

impl Provider for Grok {
    fn spec(&self) -> &'static Spec { &SPEC }
    fn identity(&self, account: &Account) -> Option<String> { account.account_id.clone() }
    fn login<'a>(&'a self, http: &'a Client, options: LoginOptions, prompt: Prompt) -> BoxFuture<'a, Result<Account>> {
        Box::pin(oauth::login(http, options, prompt))  // reuses auth::browser_login and the PKCE helpers
    }
    fn refresh<'a>(&'a self, http: &'a Client, token: &'a str) -> BoxFuture<'a, Result<Grant, RefreshError>> {
        Box::pin(oauth::refresh(http, token))
    }
    fn usage<'a>(&'a self, http: &'a Client, account: &'a Account) -> BoxFuture<'a, Result<Reading, UsageError>> {
        Box::pin(limits::poll(http, account))      // → limits::Window for each window
    }
    fn headers(&self, client: &HeaderMap, account: &Account, _moved: bool) -> HeaderMap {
        keys::with_key(client, KeyHeader::Bearer, &account.tokens.access_token)
    }
    fn limits(&self, headers: &HeaderMap, now: Timestamp) -> Option<Limits> { limits::from_headers(headers, now) }
    fn verdict(&self, status: StatusCode, headers: &HeaderMap, body: &[u8], model: Option<&str>, now: Timestamp) -> Verdict {
        match status {
            StatusCode::TOO_MANY_REQUESTS => limits::refusal(headers, body, now).into(),
            _ => Verdict::of_status(status),
        }
    }
}
```

With `billing: Billing::Subscription` and `grok-*` models, routing puts SuperGrok accounts ahead of xAI API keys (which become paid overflow if their spec says `backs: Some(ProviderId::Grok)`), polling and status pick up its windows, and the strategies place sessions by its resets. That is all a subscription needs: about 150 lines, plus the registry line.

## Agents

```rust
pub trait Agent: Send + Sync {
    fn id(&self) -> &'static str;                    // its CLI name: `claude`, `codex`
    fn title(&self) -> &'static str;
    fn provider(&self) -> ProviderId;                // the subscription it uses natively
    fn detect(&self, headers: &HeaderMap) -> bool;   // from headers it always sends, such as its user agent
    fn session(&self, headers: &HeaderMap, body: &[u8]) -> Option<String>;
    fn command(&self, config: &Config, args: &[String]) -> Command;      // `slopmax run`
    fn env(&self, config: &Config, exe: &Path) -> String;               // `slopmax env`
    fn config_file(&self) -> PathBuf;
    fn setup(&self, config: &Config, file: &Path, saved: &mut Option<Value>) -> Result<()>;
    fn undo(&self, file: &Path, saved: Value) -> Result<()>;
    // plus setup_note, has_login, wired_to, import
}
```

`agent::setup` and `agent::undo` own the file handling around `setup` and `undo`: following symlinks, private file modes, and the backup in `~/.slopmax/setup-backup.json`. An agent only edits the document.

### Adding an agent: Grok Build

```rust
// slopmax-core/src/agent/grok.rs
pub struct GrokBuild;

impl Agent for GrokBuild {
    fn id(&self) -> &'static str { "grok" }
    fn title(&self) -> &'static str { "Grok Build" }
    fn provider(&self) -> ProviderId { ProviderId::Grok }
    fn detect(&self, headers: &HeaderMap) -> bool {
        user_agent(headers).is_some_and(|ua| ua.starts_with("grok-build/"))
    }
    fn session(&self, headers: &HeaderMap, body: &[u8]) -> Option<String> {
        header(headers, "x-session-id")        // whatever the agent sends per conversation
    }
    fn command(&self, config: &Config, args: &[String]) -> Command {
        let mut command = Command::new("grok");
        command.env("GROK_BASE_URL", config.base_url()).env("GROK_API_KEY", &config.api_key).args(args);
        command
    }
    // env, config_file, setup and undo edit the agent's own config the same way
}
```

Add `&GrokBuild` to `AGENTS` and a choice to `AGENTS` in `slopmax/src/commands.rs`. `slopmax run grok`, `env grok`, `setup grok`, session affinity, and the `agent_only` policy then work for it.

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

`daemon::run` takes the home's serve lock (`.serve.lock`, so a second daemon on the same home refuses to start), binds the listener, and starts the background tasks:

- reloading the accounts when told (`POST /slopmax/api/sync`), and otherwise when a stat every 30 seconds shows a file changed, with config.toml when it changed. Requests use the accounts the pool holds in memory and read no files; a refresh puts its new tokens back into the pool. `App::config` is swapped whole; only the listener is bound for good;
- saving pool state (windows, blocks, sessions) every 10 seconds, so a restart keeps sessions on their accounts;
- refreshing tokens ahead of expiry (every 5 minutes), polling usage when due, listing limit resets, and warming idle windows (each checked every minute), and redeeming resets about to expire (every 30 minutes);
- watching account conditions every 30 seconds: notifications and nudges, told on the event stream and to the configured hooks, and remembered in `state.toml`; and each window that reset, written to the ledger for quota left on the table.

Each task reads the config as it runs, so a changed setting turns it on or off without a restart. A task that panics is logged and runs again on schedule.

Everything runs on one thread unless `SLOPMAX_WORKERS` asks for more (`daemon::runtime`), so nothing on it may block: file locks, the ledger reads behind `/slopmax/api/usage` and the history index's first build, and saves run through `blocking::run`. The one disk write left on the request path is the ledger's: one `write` per request to the month file it keeps open.

Stopping (a signal or `POST /slopmax/shutdown`) cancels `App::stop`, and then runs in order: the listener drains open connections (event streams end at once), the background loops end and the work they started finishes (`App::tasks`), a token refresh in flight saves what it got (`auth::settle`), state is saved by the only writer left, and the ledger is synced to disk.

## Files

```
~/.slopmax/                 (SLOPMAX_HOME moves it; directories 0700, files 0600)
  config.toml, .config.lock (held while the first run writes the proxy's key)
  .serve.lock               held by the running daemon, naming its pid
  accounts/<provider>-<hash>.toml, .<id>.lock
  state.toml                windows, blocks, sessions, limit resets, the pins `slopmax use`
                            sets, the nudges already sent, what was last seen of Claude
                            Code and Codex (state.rs)
  usage/<year>-<month>.jsonl  each request answered, and each window that reset with how
                            much of it was used (waste.rs)
  windows.jsonl             each window that reset, as versions before 0.4 kept them (read,
                            never written: the ledger holds them now)
  setup-backup.json         what `setup` replaced
  app.toml                  the desktop app's own choices (whether it posts notifications)
  slopmax.log
```

While a daemon serves the home, it is the only writer of what it holds: the CLI and the apps
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

## Dependencies

The binary is about 8 MB, from 69 crates besides slopmax's own. The async stack is tokio, hyper, and rustls (with ring). serde_json, toml_edit, memchr, base64, thiserror and anyhow round it out. Time, logging, the CLI parser, form encoding, and the HTTP client conveniences are small in-house modules, because the crates for them each pull in far more than slopmax uses. A crate earns its place by doing its job measurably better than a small module would: faster, leaner, or more correct. The CI holds the tree to 70 crates and the binary to 8 MiB; raising either needs that reason in the commit. tokio-util is the newest: its `CancellationToken` and `TaskTracker` let the daemon stop in order, for 30 KB.

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

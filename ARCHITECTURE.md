# Architecture

slopmax is a thin proxy. For each request it decides which account serves it, swaps in that account's credential, and streams the answer back. When the account's API speaks another format than the client, it translates. Everything else (usage windows, failover, the ledger, notifications) exists to make that decision well or to report on it.

Three registries keep the code open to new services without spreading special cases through it:

| Registry                | Lists                                   | Where                                   |
| ----------------------- | --------------------------------------- | --------------------------------------- |
| Providers               | The services accounts belong to         | `ProviderId::get` in `src/provider/mod.rs` |
| Agents                  | The programs slopmax wires up and serves | `AGENTS` in `src/agent/mod.rs`          |
| Formats                 | The API formats requests arrive in      | `Dialect` and `src/wire/translate.rs`   |

Code outside those modules talks to a provider, agent, or format only through its trait or enum. Adding one means one new module plus one registry line.

## Ground rules

- **Forward, don't rewrite.** A request in a format the account speaks goes out as the client sent it, except for the credential (and, for Claude, the OAuth beta flag subscription tokens require). Byte-level edits go through `proxy/rawjson.rs`, which changes a value in place instead of re-serializing the body.
- **Claude serves Claude Code.** Anthropic allows subscription logins in Claude Code only. Providers declare `agent_only: Some("claude")`, routing refuses other clients, and nothing is ever translated *into* Anthropic's format. slopmax does not imitate Claude Code or alter what it says about itself.
- **Identify honestly.** Translated requests carry `user-agent: slopmax/<version>`, not the client's.
- **Fail over before the first byte.** Once a response streams to the client it is passed through; a failure after that reaches the client in its own format.

## Module map

```
src/
  main.rs, lib.rs
  cli/          table-driven parser (args.rs), one function per command, init wizard, doctor
  config.rs     ~/.slopmax/config.toml, with a commented template
  account.rs    Account (OAuth tokens or a key, optional Endpoint and Link) and the file Store
  auth/         browser and device logins, PKCE, the callback server, refresh under a file lock
  import.rs     logins from Claude Code, Codex, and CLIProxyAPI (linked or copied)
  provider/     the Provider trait and Spec; claude/, codex/, keys.rs, compat.rs
  agent/        the Agent trait; claude_code.rs, codex.rs
  route.rs      model → steps: providers, accounts, and model names to try, in order
  pool.rs       account health, session affinity, and placement strategies
  limits.rs     usage windows and refusals, shared by the provider parsers
  proxy/        mod.rs (App, the handler, keys), forward.rs (the failover loop), sse.rs and
                start.rs (stream taps and holds), transcode.rs (translated streams), socket.rs
                (Codex's WebSockets), models.rs (/v1/models), admin.rs and dashboard.html
                (/slopmax/*), hub.rs (CLIProxyAPI's management calls for quota tools),
                warm.rs (window warmups), rawjson.rs (in-place JSON edits)
  wire/         formats: errors and usage per Dialect; ir.rs and one codec per format
  daemon.rs     the long-running proxy and its background tasks
  ledger.rs     the usage ledger; summary.rs totals it; pricing.rs prices it
  notify.rs     webhook and command notifications from account changes
  report.rs     `slopmax status`; service.rs systemd and launchd; ui.rs terminal output
  net/          hyper client (pooling, TLS, CONNECT and SOCKS5 proxies), server, ws.rs (RFC 6455)
  paths.rs      Home: a slopmax directory and its files (the proxy carries its own)
  time.rs, log.rs, ids.rs, fsx.rs   small in-house replacements for crates
```

## A request's path

1. **`proxy::handle`** answers slopmax's own endpoints (`/healthz`, `/slopmax/*`, the OpenAI-style `/v1/models`) and hands the rest to `proxy`, which checks the slopmax key.
2. **`proxy::route`** reads the path into a `Target`: the client's format, the provider the path belongs to (`/claude/*`, `/codex/*`, or `/v1/*` by shape), and whether the body's model picks the provider.
3. **`forward::Inbound`** buffers the body (so it can be replayed on another account) and reads the agent, the session, and the model from it.
4. **`route::plan`** turns the model into `Step`s: each provider with an account that serves the model, subscriptions first, then paid overflow, selectors, aliases, and fallbacks. It drops accounts that may not serve this client (`agent_only`) or that speak a format it cannot be translated into.
5. **`Pool::pick`** chooses an account for each step: the session's own account if it can still serve, else the `slopmax use` pin, else the strategy within the top priority tier.
6. **`forward::attempt`** refreshes the token if due, then builds the outbound request. If the account speaks the client's format it is the client's own request with the credential swapped (`Provider::headers`, `Provider::rebind` when the session moved). If not, `wire::translate` decodes it into the common form and encodes it for the account's API (`Provider::shape` adds last touches).
7. **The answer.** Rate-limit headers update the account's windows (`Provider::limits`). A refusal is classified by `Provider::verdict` into a `Verdict` (exhausted, throttled, unauthorized, stale state, or final), which decides whether to block the account and try the next. For Codex the first moments of the stream are held (`proxy/start.rs`) to catch refusals inside a 200.
8. **Streaming back.** `proxy/sse.rs`'s `Tapped` watches the stream for token usage and records the request in the ledger when it ends. A translated answer also passes through `proxy/transcode.rs`, which reads the upstream's events and writes the client's.

Codex's WebSockets take a different path, through `proxy/socket.rs`. The handshake is routed like a request, using the model from Codex's `x-codex-routing-hint`. slopmax opens ChatGPT's socket on the chosen account (`net/ws.rs` frames both), then relays messages both ways. On the way it reads `codex.rate_limits` events and finished turns, and closes the socket when the account is spent so Codex reconnects on another. Anything it cannot relay is answered 426, and Codex falls back to HTTP.

## Providers

```rust
pub trait Provider: Send + Sync {
    fn spec(&self) -> &'static Spec;                       // id, title, API base, formats, models, billing, policy
    fn identity(&self, account: &Account) -> Option<String>;
    fn login<'a>(&'a self, http: &'a Client, options: LoginOptions) -> BoxFuture<'a, Result<Account>>;
    fn headers(&self, client: &HeaderMap, account: &Account, moved: bool) -> HeaderMap;
    fn verdict(&self, status, headers, body, model, now) -> Verdict;
    // with defaults: refresh, identify, usage, limits, rebind, shape, api, dialects, serves, catalog, credits
}
```

`Spec` holds what a provider is rather than what it does: its API base, the formats it speaks, the models it serves (patterns such as `claude-*`), whether it is a subscription or metered (and which subscription a metered provider backs up), and the one agent allowed to use it, if any. Async methods return a hand-written `BoxFuture`, which keeps the trait object-safe without a macro crate.

### Adding an API-key provider

A provider that takes a bearer key and speaks an OpenAI-style format is one static in `src/provider/keys.rs`:

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
    device_login: false,
};

pub static MISTRAL: KeyProvider = KeyProvider {
    id: ProviderId::Mistral,
    spec: &MISTRAL_SPEC,
    models_url: "https://api.mistral.ai/v1/models",
};
```

Then add `Mistral` to `ProviderId`, its `ALL` list, and `ProviderId::get`, and a choice to `PROVIDERS` in `src/cli/mod.rs`. Login, routing, translation from every client format, model lists, status, the ledger, and notifications all follow from the trait.

### Adding a subscription: SuperGrok

A subscription signs in with OAuth and has usage windows. It gets a directory like `provider/codex/`. For SuperGrok, as a sketch (the endpoints are placeholders until the provider is built against the real service):

```
src/provider/grok/
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
    device_login: true,
};

impl Provider for Grok {
    fn spec(&self) -> &'static Spec { &SPEC }
    fn identity(&self, account: &Account) -> Option<String> { account.account_id.clone() }
    fn login<'a>(&'a self, http: &'a Client, options: LoginOptions) -> BoxFuture<'a, Result<Account>> {
        Box::pin(oauth::login(http, options))      // reuses auth::browser_login and the PKCE helpers
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
// src/agent/grok.rs
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

Add `&GrokBuild` to `AGENTS` and a choice to `AGENTS` in `src/cli/mod.rs`. `slopmax run grok`, `env grok`, `setup grok`, session affinity, and the `agent_only` policy then work for it.

## Formats

Each format (`Dialect`) knows its error shape, its usage-limit reply, where its stream reports usage, and how its streams open. Translation goes through `wire/ir.rs`, a common form for requests (`Request`, `Message`, `Part`, `Tool`) and answers (`Event`: text, reasoning, opaque reasoning state, tool calls, done, error). Each format implements the sides it needs:

| Format (`wire/<name>/`) | `request.rs`                    | `events.rs`                 | `reply.rs`                    |
| ----------------------- | ------------------------------- | --------------------------- | ----------------------------- |
| Messages                | decode client requests          | —                           | encode answers for clients    |
| Responses               | decode client requests, encode upstream requests | decode upstream streams | encode answers for clients |
| Chat                    | decode client requests, encode upstream requests | decode upstream streams | encode answers for clients |

So adding a format costs one codec, not one translator for each other format. Messages has no upstream side on purpose: Anthropic is never a translation target. `wire/translate.rs` dispatches on `Dialect`, and `proxy/transcode.rs` streams through it.

State a format cannot carry back is kept by slopmax: the encrypted reasoning an upstream issues is remembered per tool call (`transcode::Replay`) and restored on the next turn for the same account; Codex's remote compaction is emulated with a sealed summary (`wire/responses/compaction.rs`).

## Background work

`daemon::run` binds the listener and starts the background tasks:

- reloading accounts and pins from disk every 2 seconds, so CLI commands and other processes take effect;
- saving pool state (windows, blocks, sessions) every 10 seconds, so a restart keeps sessions on their accounts;
- refreshing tokens ahead of expiry, polling usage, and redeeming expiring ChatGPT reset credits;
- watching account conditions for notifications.

## Files

```
~/.slopmax/                 (SLOPMAX_HOME moves it; directories 0700, files 0600)
  config.toml
  accounts/<provider>-<hash>.json, .<id>.lock
  state.json                windows, blocks, sessions
  pins.json                 `slopmax use`
  usage/<year>-<month>.jsonl
  setup-backup.json         what `setup` replaced
  slopmax.log
```

## Dependencies

The binary is under 6 MB, from about 60 crates. The async stack is tokio, hyper, and rustls (with ring). serde_json, toml_edit, memchr, base64, and anyhow round it out. Time, logging, the CLI parser, form encoding, and the HTTP client conveniences are small in-house modules, because the crates for them each pull in far more than slopmax uses. A crate earns its place by doing its job measurably better than a small module would: faster, leaner, or more correct. The CI holds the tree to 70 crates and the binary to 6 MB; raising either needs that reason in the commit.

## Performance

What slopmax adds to a request is small next to a model's answer, and it should stay that way. `mise run bench` measures it: `examples/bench.rs` runs the real server (`daemon::serve`) in front of a mock provider that streams answers with usage and rate-limit headers, and `oha` drives Claude Code- and Codex-shaped requests through it, small ones and 300 KB conversations, one at a time and 32 at once.

On a 2-vCPU machine shared with the load generator and the mock (which answers a small request in 0.2 ms on its own):

| | Round trip through slopmax (p50) | 32 at once | Memory |
| --- | --- | --- | --- |
| Small request | 1.1 ms | 1,600 req/s | 7 MB idle |
| 300 KB request | 1.9 ms | 1,050 req/s | 40 MB peak under that load |

`slopmax --version` and `status` take about 2 ms, and `serve` answers about 22 ms after it starts.

The hot path keeps to a few rules:

- Request bodies are never parsed whole. `proxy/rawjson.rs` scans for the few values slopmax reads (`model`, `stream`, session ids) and stops once it has them, jumping over strings with SIMD search (`memchr`).
- The stream tap reads events in place and parses only those that mention usage or an error.
- Sockets set `TCP_NODELAY`, so each streamed event leaves as it arrives.
- Commands that only talk to the local proxy skip loading the system's trusted roots.

The allocator is the platform's own. mimalloc and jemalloc were 4 to 30% faster at 32 streams at once, but held 2 to 5 times the memory, and one person's agents rarely run that many. The `mimalloc` feature is there for a proxy shared by many clients, and the Docker image builds with it.

## Testing

- Unit tests sit next to the code: parsers and codecs against recorded shapes, the planner over tables of accounts, the pool's placement and failover.
- `tests/proxy.rs` runs the real proxy against a mock provider on a local port. `net::Origins` rewrites the providers' base URLs to it, and the mock answers by bearer token, so each account can be made to succeed, hit its limit, or reject its token.
- `mise run check` runs rustfmt, clippy with warnings denied, and every test, as CI does: every CI job is a mise task, with the toolchain mise.toml pins.

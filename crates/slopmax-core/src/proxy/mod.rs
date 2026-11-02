//! The local HTTP proxy that agents talk to.
//!
//! Claude Code reaches it through `ANTHROPIC_BASE_URL` and Codex through a
//! custom model provider. Each request is authenticated with the slopmax
//! key, assigned an account by the [`Pool`], and forwarded upstream with
//! that account's credentials.

mod admin;
mod forward;
mod hub;
mod models;
mod relay;
mod socket;
mod start;
mod transcode;
pub mod warm;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::account::{Account, Store};
use crate::auth::{self, RefreshError};
use crate::config::{ClientKey, Config};
use crate::fsx;
use crate::ledger::Ledger;
use crate::log;
use crate::net::body;
use crate::net::server::{Request, Response};
use crate::net::{Client, Origins};
use crate::paths::Home;
use crate::pool::{Pins, Pool, Routing, State as PoolState};
use crate::provider::ProviderId;
use crate::report::{self, Report};
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;

/// A background task, boxed to share one task type.
pub type BoxedTask = std::pin::Pin<Box<dyn Future<Output = ()> + Send>>;

/// Shared state for request handlers and background tasks.
pub struct App {
    /// The config, swapped whole when config.toml changes.
    config: RwLock<Arc<Config>>,
    /// The slopmax directory this proxy reads and writes.
    pub home: Home,
    pub store: Store,
    pub pool: Pool,
    /// Inference traffic: long-lived streams, so only a stall timeout.
    http: Client,
    /// OAuth and usage calls, with bounded timeouts.
    pub auth_http: Client,
    /// Cancelled when the daemon stops: by a signal or `POST
    /// /slopmax/shutdown`. Background loops and event streams end on it.
    pub stop: CancellationToken,
    /// The background work the daemon waits for when it stops.
    pub tasks: TaskTracker,
    /// Held while redeeming a reset credit, so concurrent requests that
    /// all find the pool spent redeem one credit, not one each.
    pub redeeming: tokio::sync::Mutex<()>,
    /// Where answered requests are recorded for `slopmax usage`.
    pub ledger: Ledger,
    /// Reasoning state kept between turns of translated conversations.
    replay: Mutex<transcode::Replay>,
    /// Each account's model list, and when it was read.
    catalogs: Mutex<HashMap<String, (Instant, Vec<String>)>>,
    /// The newest Codex release seen in requests.
    codex_version: Mutex<Option<String>>,
    /// Each answered request, as JSON, for the dashboard's live feed.
    events: broadcast::Sender<Bytes>,
    /// The model Codex asked for last, which window warmups use.
    codex_model: Mutex<Option<String>>,
    /// When each account was last warmed.
    warmed: Mutex<HashMap<String, Instant>>,
    /// config.toml as last read, to tell when it changes.
    config_text: Mutex<Option<String>>,
    /// The account files and pins as last read, to tell when they change.
    seen: Mutex<Option<u64>>,
}

impl App {
    /// `origins` reroutes provider URLs; tests point them at a mock.
    pub fn new(config: Config, home: Home, state: PoolState, origins: Origins) -> Arc<Self> {
        let store = Store::at(home.accounts());
        // The ledger remembers which model Codex used last, across restarts.
        let month_ago = Timestamp::now() - SignedDuration::from_hours(24 * 30);
        let codex_model = crate::ledger::read(&home.usage(), month_ago)
            .into_iter()
            .rev()
            .find(|e| e.provider == ProviderId::Codex)
            .and_then(|e| e.model);
        let ledger = Ledger::at(home.usage());
        let config_text = std::fs::read_to_string(home.config()).ok();
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(600))
            .origins(origins.clone())
            .build();
        let pool = Pool::new(
            config.strategy,
            SignedDuration::from_mins(config.session_ttl_mins as i64),
            state,
        );
        pool.set_routing(Routing::of(&config));
        Arc::new(Self {
            config: RwLock::new(Arc::new(config)),
            home,
            store,
            pool,
            http,
            auth_http: crate::auth::http_client(origins),
            stop: CancellationToken::new(),
            tasks: TaskTracker::new(),
            redeeming: tokio::sync::Mutex::new(()),
            ledger,
            replay: Default::default(),
            catalogs: Default::default(),
            codex_version: Default::default(),
            events: broadcast::channel(256).0,
            codex_model: Mutex::new(codex_model),
            warmed: Default::default(),
            config_text: Mutex::new(config_text),
            seen: Mutex::default(),
        })
    }

    /// Runs `task` in the background, as work the daemon finishes before it
    /// stops.
    pub fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) {
        // Boxed, so every caller shares one copy of the task machinery.
        let task: BoxedTask = Box::pin(task);
        self.tasks.spawn(task);
    }

    /// The config as it stands.
    pub fn config(&self) -> Arc<Config> {
        self.config
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Applies a changed config to requests from now on. The address, the
    /// upstream proxy, and which background tasks run are set at start, so
    /// changing those needs a restart; everything else applies at once.
    pub fn set_config(&self, config: Config) {
        self.pool.set_routing(Routing::of(&config));
        *self.config.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(config);
    }

    /// Applies config.toml if it changed since it was last read. A config
    /// that does not parse is logged and left unapplied.
    pub fn reload_config(&self) {
        let Ok(text) = std::fs::read_to_string(self.home.config()) else {
            return;
        };
        let mut seen = self.config_text.lock().unwrap_or_else(|p| p.into_inner());
        if seen.as_deref() == Some(text.as_str()) {
            return;
        }
        match toml_edit::de::from_str::<Config>(&text) {
            Ok(mut config) => {
                let current = self.config();
                // Bound at start: the listener stays where it is.
                config.listen = current.listen;
                if config.api_key.is_empty() {
                    config.api_key.clone_from(&current.api_key);
                }
                log::info!("config.toml changed; applying it");
                self.set_config(config);
            }
            Err(e) => log::warn!("config.toml is invalid, keeping the last good one: {e}"),
        }
        *seen = Some(text);
    }

    /// Reloads accounts and pins from disk, picking up logins, removals,
    /// refreshed tokens, and `slopmax use` from other processes.
    pub fn sync(&self) -> Result<()> {
        let seen = self.fingerprint();
        let accounts = self.store.list()?;
        let pins: Pins = fsx::read_json(&self.home.pins())?.unwrap_or_default();
        self.pool.sync(accounts, pins);
        *self.seen.lock().unwrap_or_else(|p| p.into_inner()) = seen;
        Ok(())
    }

    /// Reloads accounts and pins if a file changed since they were last
    /// read, which costs a directory listing and a stat per file otherwise.
    pub fn rescan(&self) -> Result<()> {
        let now = self.fingerprint();
        if now.is_some() && now == *self.seen.lock().unwrap_or_else(|p| p.into_inner()) {
            return Ok(());
        }
        self.sync()
    }

    /// The names, sizes and modification times of the account files and
    /// pins, hashed: what changes when another process writes one.
    fn fingerprint(&self) -> Option<u64> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::hash::DefaultHasher::new();
        let stat = |path: &std::path::Path, hasher: &mut std::hash::DefaultHasher| {
            match std::fs::metadata(path) {
                Ok(meta) => (meta.len(), meta.modified().ok()).hash(hasher),
                Err(_) => 0u8.hash(hasher),
            }
        };
        stat(&self.home.pins(), &mut hasher);
        let mut names: Vec<_> = match std::fs::read_dir(self.store.dir()) {
            Ok(listing) => listing.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => return None,
        };
        names.sort();
        for path in names
            .iter()
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
        {
            path.hash(&mut hasher);
            stat(path, &mut hasher);
        }
        Some(hasher.finish())
    }

    /// The account with current credentials, or `None` if it cannot be used.
    /// The pool's copy is current: refreshes here put their tokens back into
    /// it, and changes from other processes arrive with [`App::sync`], so a
    /// request reads no files unless its token is due.
    pub async fn ready(&self, picked: &Account) -> Option<Account> {
        let account = self
            .pool
            .account(&picked.id)
            .unwrap_or_else(|| picked.clone());
        // Another process may have found its sign-in revoked; trying it
        // would cost a refusal and a refresh.
        if let Some(error) = &account.auth_error {
            self.pool.record_error(&account.id, error);
            return None;
        }
        // Following a linked account's source is read-only, so it happens
        // even when refreshing is off.
        if !self.config().refresh_tokens && account.link.is_none() {
            return Some(account);
        }
        match auth::ensure_fresh(&self.auth_http, &self.store, &account, false).await {
            Ok(fresh) => {
                self.adopt(&account, &fresh);
                Some(fresh)
            }
            Err(RefreshError::Transient(e)) if !account.tokens.is_expired(Timestamp::now()) => {
                log::warn!("{}: refresh failed, using current token: {e:#}", account.id);
                Some(account)
            }
            Err(e) => {
                log::warn!("{}: {e}", account.id);
                self.refresh_failed(&account, &e);
                None
            }
        }
    }

    /// Records a failed refresh. A revoked sign-in is marked on the pool's
    /// copy too, as the refresh marked the stored one, so no request tries
    /// it again.
    pub fn refresh_failed(&self, account: &Account, error: &RefreshError) {
        self.pool.record_error(&account.id, &error.to_string());
        if let RefreshError::Revoked(reason) = error {
            let mut revoked = account.clone();
            revoked.auth_error = Some(reason.clone());
            self.pool.put(&revoked);
        }
    }

    /// Keeps the tokens of a refreshed account for the requests after it.
    pub fn adopt(&self, held: &Account, fresh: &Account) {
        if fresh.tokens.access_token != held.tokens.access_token
            || fresh.auth_error != held.auth_error
        {
            self.pool.put(fresh);
        }
    }

    /// Puts the pool's usage windows in place of the serving account's in
    /// response headers, so the agent sees its provider's accounts as one.
    pub(crate) fn show_pool(&self, provider: ProviderId, headers: &mut HeaderMap) {
        if !provider.spec().is_subscription() {
            return;
        }
        let windows = self.pool.pooled(provider, Timestamp::now());
        if !windows.is_empty() {
            provider.get().show_pool(&windows, headers);
        }
    }

    /// The model Codex asked for last.
    pub(crate) fn last_codex_model(&self) -> Option<String> {
        self.codex_model
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Writes a finished request to the usage ledger, tells the dashboard's
    /// live feed about it, and remembers the model of a Codex one.
    pub(crate) fn record(&self, entry: &crate::ledger::Entry) {
        self.ledger.record(entry);
        if entry.provider == ProviderId::Codex
            && let Some(model) = &entry.model
        {
            *self.codex_model.lock().unwrap_or_else(|p| p.into_inner()) = Some(model.clone());
        }
        if self.events.receiver_count() > 0
            && let Ok(line) = serde_json::to_vec(entry)
        {
            let _ = self.events.send(line.into());
        }
    }

    pub fn report(&self) -> Report {
        let now = Timestamp::now();
        report::build(
            self.pool.accounts(),
            |id| self.pool.state(id),
            &self.pool.pins(),
            &self.pool.session_counts(now),
            self.config().strategy,
            true,
            now,
        )
        .with_next(&self.pool, now)
        .with_nudges(&self.config(), now)
    }
}

/// Answers one request: slopmax's own endpoints, else the proxy.
pub async fn handle(app: Arc<App>, request: Request) -> Response {
    match (request.method(), request.uri().path()) {
        (&Method::GET, "/healthz") => json_reply(
            StatusCode::OK,
            &json!({ "status": "ok", "service": "slopmax", "version": env!("CARGO_PKG_VERSION") }),
        ),
        // Claude Code's unauthenticated connectivity check; HEAD probes alike.
        (_, "/api/hello") | (&Method::HEAD, _) => empty_reply(StatusCode::OK),
        (_, path) if path.starts_with("/slopmax/") => admin::handle(app, request).await,
        (_, path) if path.starts_with("/v0/management/") => hub::handle(app, request).await,
        (&Method::GET, "/v1/models")
            if models::wants_list(request.headers(), request.uri().query().unwrap_or("")) =>
        {
            match caller(&app.config(), request.headers()) {
                Some(Caller::Owner) => models::list(&app, None).await,
                Some(Caller::Client(key)) => {
                    let key = key.clone();
                    models::list(&app, Some(&key)).await
                }
                None => unauthorized(Some(Dialect::Chat)),
            }
        }
        _ => proxy(app, request).await,
    }
}

async fn proxy(app: Arc<App>, request: Request) -> Response {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map_or("/", |pq| pq.as_str())
        .to_owned();
    let Some(target) = route(&path_and_query, request.headers()) else {
        return error(
            None,
            StatusCode::NOT_FOUND,
            "unknown path; slopmax serves /v1/*, /claude/*, and /codex/*",
        );
    };
    let dialect = target.dialect;
    let client = match caller(&app.config(), request.headers()) {
        Some(Caller::Owner) => None,
        Some(Caller::Client(key)) => Some(key.clone()),
        None => return unauthorized(Some(dialect)),
    };
    if let Some(version) = crate::provider::codex::wire::client_version(request.headers()) {
        *app.codex_version.lock().unwrap_or_else(|p| p.into_inner()) = Some(version);
    }
    if let Some(agent) = crate::provider::claude::wire::client_agent(request.headers()) {
        app.pool.saw_agent(ProviderId::Claude, agent);
    }
    // Codex's sockets are relayed when they can be; refusing a handshake
    // with 426 makes Codex stream over HTTP at once instead of retrying.
    if is_websocket(request.headers()) {
        return socket::accept(app, target, request, client.as_ref()).await;
    }
    forward::forward(app, target, request, client).await
}

/// Where a request goes, judged from its path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    /// The provider whose API the path belongs to, if any. It serves the
    /// request unless the model routes it elsewhere.
    pub provider: Option<ProviderId>,
    /// The path to forward, relative to the API's base URL.
    pub path: String,
    /// The format the client speaks.
    pub dialect: Dialect,
    /// Whether the model in the body picks the provider.
    pub by_model: bool,
}

fn is_websocket(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

fn json_reply(status: StatusCode, value: &impl Serialize) -> Response {
    let body = serde_json::to_vec(value).expect("replies serialize");
    let mut response = Response::new(body::full(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn empty_reply(status: StatusCode) -> Response {
    let mut response = Response::new(body::empty());
    *response.status_mut() = status;
    response
}

/// Maps a request path to its target.
fn route(path_and_query: &str, headers: &HeaderMap) -> Option<Target> {
    let strip = |prefix: &str| {
        path_and_query
            .strip_prefix(prefix)
            .filter(|rest| rest.is_empty() || rest.starts_with(['/', '?']))
            .map(str::to_owned)
    };
    let starts = |path: &str, prefix: &str| {
        path.split('?')
            .next()
            .unwrap_or_default()
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    let claude = |path: String| Target {
        provider: Some(ProviderId::Claude),
        by_model: starts(&path, "/v1/messages"),
        dialect: Dialect::Messages,
        path,
    };
    let codex = |path: String| Target {
        provider: Some(ProviderId::Codex),
        by_model: starts(&path, "/responses"),
        dialect: Dialect::Responses,
        path,
    };
    if let Some(rest) = strip("/claude") {
        return Some(claude(rest));
    }
    if let Some(rest) = strip("/codex") {
        return Some(codex(rest));
    }
    // Unprefixed /v1 paths, as an OpenAI- or Anthropic-style base URL sends.
    let rest = strip("/v1")?;
    if starts(&rest, "/chat/completions") {
        return Some(Target {
            provider: None,
            path: rest,
            dialect: Dialect::Chat,
            by_model: true,
        });
    }
    let path = rest.split('?').next().unwrap_or_default();
    let is_codex = path.starts_with("/responses")
        || (path == "/models"
            && rest.contains("client_version=")
            && !headers.contains_key("anthropic-version"));
    Some(if is_codex {
        codex(rest)
    } else {
        claude(format!("/v1{rest}"))
    })
}

/// Who a request comes from, by the key it presents.
#[derive(Debug, Clone, Copy)]
enum Caller<'a> {
    /// The owner's `api_key`.
    Owner,
    /// One of the config's client keys.
    Client(&'a ClientKey),
}

/// The key a request presents, as a bearer token or `x-api-key`.
fn caller<'a>(config: &'a Config, headers: &HeaderMap) -> Option<Caller<'a>> {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        });
    let key = bearer
        .or_else(|| headers.get("x-api-key").and_then(|v| v.to_str().ok()))?
        .trim()
        .as_bytes();
    if constant_time_eq(key, config.api_key.as_bytes()) {
        return Some(Caller::Owner);
    }
    config
        .keys
        .iter()
        .find(|k| constant_time_eq(key, k.key.as_bytes()))
        .map(Caller::Client)
}

/// Whether the request carries the owner's key, which slopmax's own API
/// requires.
fn authorized(config: &Config, headers: &HeaderMap) -> bool {
    matches!(caller(config, headers), Some(Caller::Owner))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn unauthorized(dialect: Option<Dialect>) -> Response {
    error(
        dialect,
        StatusCode::UNAUTHORIZED,
        "missing or invalid slopmax key; see `slopmax env`",
    )
}

/// An error in the shape the agent understands (Messages when unknown).
fn error(dialect: Option<Dialect>, status: StatusCode, message: &str) -> Response {
    let kind = match status.as_u16() {
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        529 => "overloaded_error",
        s if s >= 500 => "api_error",
        _ => "invalid_request_error",
    };
    let body = dialect.unwrap_or(Dialect::Messages).error(kind, message);
    json_reply(status, &body)
}

const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Client headers safe to forward upstream: everything but hop-by-hop
/// headers and the agent's local credentials and cookies.
pub(crate) fn forwardable(client: &HeaderMap) -> HeaderMap {
    let mut headers = HeaderMap::with_capacity(client.len());
    for (name, value) in client {
        let name_str = name.as_str();
        // slopmax's own headers are for slopmax alone.
        let skip = HOP_BY_HOP.contains(&name_str)
            || name_str.starts_with("x-slopmax-")
            || matches!(
                name_str,
                "host" | "content-length" | "authorization" | "x-api-key" | "cookie"
            );
        if !skip {
            headers.append(name.clone(), value.clone());
        }
    }
    headers
}

/// A request's own say on session affinity: `x-slopmax-affinity: off`
/// places it by the strategy alone, `on` keeps it on its session's
/// account even when the config turns affinity off.
pub(crate) fn affinity(headers: &HeaderMap) -> Option<bool> {
    let value = headers.get("x-slopmax-affinity")?.to_str().ok()?.trim();
    match value.to_ascii_lowercase().as_str() {
        "on" | "true" | "1" | "yes" => Some(true),
        "off" | "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

/// Upstream response headers safe to return to the agent.
pub(crate) fn returnable(upstream: &HeaderMap) -> HeaderMap {
    let mut headers = HeaderMap::with_capacity(upstream.len());
    for (name, value) in upstream {
        let name_str = name.as_str();
        if !HOP_BY_HOP.contains(&name_str) && !matches!(name_str, "content-length" | "set-cookie") {
            headers.append(name.clone(), value.clone());
        }
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_prefixed_and_v1_paths() {
        let none = HeaderMap::new();
        let at = |path: &str| {
            let t = route(path, &none)?;
            Some((t.provider, t.path, t.dialect, t.by_model))
        };
        use Dialect::{Chat, Messages, Responses};
        use ProviderId::{Claude, Codex};
        assert_eq!(
            at("/claude/v1/messages?beta=true"),
            Some((
                Some(Claude),
                "/v1/messages?beta=true".into(),
                Messages,
                true
            ))
        );
        assert_eq!(
            at("/claude/v1/messages/count_tokens"),
            Some((
                Some(Claude),
                "/v1/messages/count_tokens".into(),
                Messages,
                true
            ))
        );
        assert_eq!(
            at("/codex/responses"),
            Some((Some(Codex), "/responses".into(), Responses, true))
        );
        assert_eq!(
            at("/codex/models?client_version=1"),
            Some((
                Some(Codex),
                "/models?client_version=1".into(),
                Responses,
                false
            ))
        );
        assert_eq!(
            at("/v1/messages?beta=true"),
            Some((
                Some(Claude),
                "/v1/messages?beta=true".into(),
                Messages,
                true
            ))
        );
        assert_eq!(
            at("/v1/responses"),
            Some((Some(Codex), "/responses".into(), Responses, true))
        );
        assert_eq!(
            at("/v1/chat/completions"),
            Some((None, "/chat/completions".into(), Chat, true))
        );
        assert_eq!(
            at("/v1/models?client_version=0.159.3"),
            Some((
                Some(Codex),
                "/models?client_version=0.159.3".into(),
                Responses,
                false
            ))
        );
        assert_eq!(
            at("/v1/models?limit=1000"),
            Some((
                Some(Claude),
                "/v1/models?limit=1000".into(),
                Messages,
                false
            ))
        );
        assert_eq!(
            at("/v1/messagesx"),
            Some((Some(Claude), "/v1/messagesx".into(), Messages, false))
        );
        assert_eq!(at("/codexx/responses"), None);
        assert_eq!(at("/other"), None);
    }

    #[test]
    fn client_keys_reach_the_proxy_but_not_the_admin_api() {
        let config = Config {
            api_key: "sm-owner".into(),
            keys: vec![ClientKey {
                name: "laptop".into(),
                key: "sm-laptop".into(),
                models: vec!["gpt-*".into()],
            }],
            ..Config::default()
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer sm-laptop"),
        );
        assert!(matches!(caller(&config, &headers), Some(Caller::Client(k)) if k.name == "laptop"));
        assert!(!authorized(&config, &headers));
        headers.insert("authorization", HeaderValue::from_static("Bearer sm-owner"));
        assert!(matches!(caller(&config, &headers), Some(Caller::Owner)));
        headers.insert("authorization", HeaderValue::from_static("Bearer sm-other"));
        assert!(caller(&config, &headers).is_none());
    }

    #[test]
    fn auth_accepts_bearer_or_api_key() {
        let config = Config {
            api_key: "sm-key".into(),
            ..Config::default()
        };
        let mut headers = HeaderMap::new();
        assert!(!authorized(&config, &headers));
        headers.insert("authorization", HeaderValue::from_static("Bearer sm-key"));
        assert!(authorized(&config, &headers));
        headers.insert("authorization", HeaderValue::from_static("Bearer nope"));
        assert!(!authorized(&config, &headers));
        let mut headers = HeaderMap::new();
        headers.insert("x-api-key", HeaderValue::from_static("sm-key"));
        assert!(authorized(&config, &headers));
    }

    #[test]
    fn forwardable_drops_only_credentials_and_hop_by_hop() {
        let mut client = HeaderMap::new();
        client.insert("authorization", HeaderValue::from_static("Bearer sm-key"));
        client.insert("connection", HeaderValue::from_static("keep-alive"));
        client.insert("accept-encoding", HeaderValue::from_static("gzip, br"));
        client.insert("x-app", HeaderValue::from_static("cli"));
        let out = forwardable(&client);
        assert!(!out.contains_key("authorization"));
        assert!(!out.contains_key("connection"));
        assert_eq!(out["accept-encoding"], "gzip, br");
        assert_eq!(out["x-app"], "cli");
    }
}

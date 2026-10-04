//! The local HTTP proxy that agents talk to.
//!
//! Claude Code reaches it through `ANTHROPIC_BASE_URL` and Codex through a
//! custom model provider. Each request is authenticated with the slopmax
//! key, assigned an account by the [`Pool`], and forwarded upstream with
//! that account's credentials.

mod forward;
pub mod rawjson;
mod sse;
mod start;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use serde::Serialize;
use serde_json::json;

use crate::account::{Account, Store};
use crate::auth::{self, RefreshError};
use crate::config::Config;
use crate::log;
use crate::net::body;
use crate::net::server::{Request, Response};
use crate::net::{Client, Origins};
use crate::pool::{Pins, Pool, State as PoolState};
use crate::provider::ProviderId;
use crate::report::{self, Report};
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;
use crate::{fsx, paths};

/// Shared state for request handlers and background tasks.
pub struct App {
    pub config: Config,
    pub store: Store,
    pub pool: Pool,
    /// Inference traffic: long-lived streams, so only a stall timeout.
    http: Client,
    /// OAuth and usage calls, with bounded timeouts.
    pub auth_http: Client,
    /// Signaled by `POST /slopmax/shutdown`.
    pub shutdown: tokio::sync::Notify,
    /// Held while redeeming a reset credit, so concurrent requests that
    /// all find the pool spent redeem one credit, not one each.
    pub redeeming: tokio::sync::Mutex<()>,
}

impl App {
    /// `origins` reroutes provider URLs; tests point them at a mock.
    pub fn new(config: Config, store: Store, state: PoolState, origins: Origins) -> Arc<Self> {
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
        Arc::new(Self {
            config,
            store,
            pool,
            http,
            auth_http: crate::auth::http_client(origins),
            shutdown: tokio::sync::Notify::new(),
            redeeming: tokio::sync::Mutex::new(()),
        })
    }

    /// Reloads accounts and pins from disk, picking up logins, removals,
    /// refreshed tokens, and `slopmax use` from other processes.
    pub fn sync(&self) -> Result<()> {
        let accounts = self.store.list()?;
        let pins: Pins = fsx::read_json(&paths::pins_file())?.unwrap_or_default();
        self.pool.sync(accounts, pins);
        Ok(())
    }

    /// The account with current credentials, or `None` if it cannot be used.
    pub async fn ready(&self, picked: &Account) -> Option<Account> {
        let account = self
            .store
            .get(&picked.id)
            .ok()
            .flatten()
            .unwrap_or_else(|| picked.clone());
        if !self.config.refresh_tokens {
            return Some(account);
        }
        match auth::ensure_fresh(&self.auth_http, &self.store, &account, false).await {
            Ok(fresh) => Some(fresh),
            Err(RefreshError::Transient(e)) if !account.tokens.is_expired(Timestamp::now()) => {
                log::warn!("{}: refresh failed, using current token: {e:#}", account.id);
                Some(account)
            }
            Err(e) => {
                log::warn!("{}: {e}", account.id);
                self.pool.record_error(&account.id, &e.to_string());
                None
            }
        }
    }

    pub fn report(&self) -> Report {
        let now = Timestamp::now();
        report::build(
            self.pool.accounts(),
            |id| self.pool.state(id),
            &self.pool.pins(),
            &self.pool.session_counts(now),
            self.config.strategy,
            true,
        )
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
        (&Method::GET, "/slopmax/status") => match authorized(&app.config, request.headers()) {
            true => json_reply(StatusCode::OK, &app.report()),
            false => unauthorized(None),
        },
        // Polls every account's usage now, then reports.
        (&Method::POST, "/slopmax/refresh") => match authorized(&app.config, request.headers()) {
            true => {
                crate::daemon::poll_all(&app, true).await;
                json_reply(StatusCode::OK, &app.report())
            }
            false => unauthorized(None),
        },
        (&Method::POST, "/slopmax/shutdown") => match authorized(&app.config, request.headers()) {
            true => {
                app.shutdown.notify_one();
                json_reply(StatusCode::OK, &json!({ "status": "stopping" }))
            }
            false => unauthorized(None),
        },
        _ => proxy(app, request).await,
    }
}

async fn proxy(app: Arc<App>, request: Request) -> Response {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map_or("/", |pq| pq.as_str())
        .to_owned();
    let Some((provider, target)) = route(&path_and_query, request.headers()) else {
        return error(
            None,
            StatusCode::NOT_FOUND,
            "unknown path; slopmax serves /v1/*, /claude/*, and /codex/*",
        );
    };
    let dialect = provider.spec().dialect;
    if !authorized(&app.config, request.headers()) {
        return unauthorized(Some(dialect));
    }
    // Upgrades cannot be relayed. Refusing the handshake with 426 makes
    // Codex switch to HTTP streaming at once instead of retrying.
    if is_websocket(request.headers()) {
        return error(
            Some(dialect),
            StatusCode::UPGRADE_REQUIRED,
            "slopmax streams over HTTP; WebSockets are not supported",
        );
    }
    forward::forward(app, provider, target, request).await
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

/// Maps a request path to a provider and the upstream path.
fn route(path_and_query: &str, headers: &HeaderMap) -> Option<(ProviderId, String)> {
    let strip = |prefix: &str| {
        path_and_query
            .strip_prefix(prefix)
            .filter(|rest| rest.is_empty() || rest.starts_with(['/', '?']))
            .map(str::to_owned)
    };
    if let Some(rest) = strip("/claude") {
        return Some((ProviderId::Claude, rest));
    }
    if let Some(rest) = strip("/codex") {
        return Some((ProviderId::Codex, rest));
    }
    // Unprefixed /v1 paths, as an OpenAI- or Anthropic-style base URL sends.
    let rest = strip("/v1")?;
    let path = rest.split('?').next().unwrap_or_default();
    let codex = path.starts_with("/responses")
        || (path == "/models"
            && rest.contains("client_version=")
            && !headers.contains_key("anthropic-version"));
    Some(if codex {
        (ProviderId::Codex, rest)
    } else {
        (ProviderId::Claude, format!("/v1{rest}"))
    })
}

/// Accepts the slopmax key as a bearer token or `x-api-key`.
fn authorized(config: &Config, headers: &HeaderMap) -> bool {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        });
    let key = bearer.or_else(|| headers.get("x-api-key").and_then(|v| v.to_str().ok()));
    key.is_some_and(|key| constant_time_eq(key.trim().as_bytes(), config.api_key.as_bytes()))
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
        let skip = HOP_BY_HOP.contains(&name_str)
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
        assert_eq!(
            route("/claude/v1/messages?beta=true", &none),
            Some((ProviderId::Claude, "/v1/messages?beta=true".into()))
        );
        assert_eq!(
            route("/codex/responses", &none),
            Some((ProviderId::Codex, "/responses".into()))
        );
        assert_eq!(
            route("/v1/messages?beta=true", &none),
            Some((ProviderId::Claude, "/v1/messages?beta=true".into()))
        );
        assert_eq!(
            route("/v1/responses", &none),
            Some((ProviderId::Codex, "/responses".into()))
        );
        assert_eq!(
            route("/v1/models?client_version=0.159.3", &none),
            Some((ProviderId::Codex, "/models?client_version=0.159.3".into()))
        );
        assert_eq!(
            route("/v1/models?limit=1000", &none),
            Some((ProviderId::Claude, "/v1/models?limit=1000".into()))
        );
        assert_eq!(route("/codexx/responses", &none), None);
        assert_eq!(route("/other", &none), None);
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

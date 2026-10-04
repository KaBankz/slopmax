//! The local HTTP proxy that agents talk to.
//!
//! Claude Code reaches it through `ANTHROPIC_BASE_URL` and Codex through a
//! custom model provider. Each request is authenticated with the slopmax
//! key, assigned an account by the [`Pool`], and forwarded upstream with
//! that account's credentials.

mod claude;
mod codex;
mod forward;
pub mod rawjson;
mod sse;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use serde_json::json;

use crate::account::{Account, Provider, Store};
use crate::auth::{self, RefreshError};
use crate::config::Config;
use crate::log;
use crate::pool::{Pins, Pool, State as PoolState};
use crate::report::{self, Report};
use crate::time::SignedDuration;
use crate::time::Timestamp;
use crate::upstream::Upstream;
use crate::{fsx, paths};

/// Shared state for request handlers and background tasks.
pub struct App {
    pub config: Config,
    pub store: Store,
    pub pool: Pool,
    pub upstream: Upstream,
    /// Inference traffic: long-lived streams, so no overall timeout.
    http: reqwest::Client,
    /// OAuth and usage calls, with bounded timeouts.
    pub auth_http: reqwest::Client,
    /// Signaled by `POST /slopmax/shutdown`.
    pub shutdown: tokio::sync::Notify,
    /// Held while redeeming a reset credit, so concurrent requests that
    /// all find the pool spent redeem one credit, not one each.
    pub redeeming: tokio::sync::Mutex<()>,
}

impl App {
    pub fn new(config: Config, store: Store, upstream: Upstream, state: PoolState) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(600))
            .build()
            .expect("TLS backend initializes");
        let pool = Pool::new(
            config.strategy,
            SignedDuration::from_mins(config.session_ttl_mins as i64),
            state,
        );
        Arc::new(Self {
            config,
            store,
            pool,
            upstream,
            http,
            auth_http: crate::auth::http_client(),
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

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/api/hello", any(hello))
        .route("/slopmax/status", get(status))
        .route("/slopmax/refresh", post(refresh))
        .route("/slopmax/shutdown", post(shutdown))
        .fallback(proxy)
        .with_state(app)
}

async fn health() -> impl IntoResponse {
    axum::Json(
        json!({ "status": "ok", "service": "slopmax", "version": env!("CARGO_PKG_VERSION") }),
    )
}

/// Claude Code's unauthenticated connectivity check.
async fn hello() -> StatusCode {
    StatusCode::OK
}

async fn status(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !authorized(&app.config, &headers) {
        return unauthorized(None);
    }
    axum::Json(app.report()).into_response()
}

/// Polls every account's usage now, then reports.
async fn refresh(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !authorized(&app.config, &headers) {
        return unauthorized(None);
    }
    crate::daemon::poll_all(&app, true).await;
    axum::Json(app.report()).into_response()
}

async fn shutdown(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !authorized(&app.config, &headers) {
        return unauthorized(None);
    }
    app.shutdown.notify_one();
    axum::Json(json!({ "status": "stopping" })).into_response()
}

async fn proxy(State(app): State<Arc<App>>, request: Request) -> Response {
    if request.method() == Method::HEAD {
        return StatusCode::OK.into_response();
    }
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
    if !authorized(&app.config, request.headers()) {
        return unauthorized(Some(provider));
    }
    // Upgrades cannot be relayed. Refusing the handshake with 426 makes
    // Codex switch to HTTP streaming at once instead of retrying.
    if is_websocket(request.headers()) {
        return error(
            Some(provider),
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

/// Maps a request path to a provider and the upstream path.
fn route(path_and_query: &str, headers: &HeaderMap) -> Option<(Provider, String)> {
    let strip = |prefix: &str| {
        path_and_query
            .strip_prefix(prefix)
            .filter(|rest| rest.is_empty() || rest.starts_with(['/', '?']))
            .map(str::to_owned)
    };
    if let Some(rest) = strip("/claude") {
        return Some((Provider::Claude, rest));
    }
    if let Some(rest) = strip("/codex") {
        return Some((Provider::Codex, rest));
    }
    // Unprefixed /v1 paths, as an OpenAI- or Anthropic-style base URL sends.
    let rest = strip("/v1")?;
    let path = rest.split('?').next().unwrap_or_default();
    let codex = path.starts_with("/responses")
        || (path == "/models"
            && rest.contains("client_version=")
            && !headers.contains_key("anthropic-version"));
    Some(if codex {
        (Provider::Codex, rest)
    } else {
        (Provider::Claude, format!("/v1{rest}"))
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

fn unauthorized(provider: Option<Provider>) -> Response {
    error(
        provider,
        StatusCode::UNAUTHORIZED,
        "missing or invalid slopmax key; see `slopmax env`",
    )
}

/// An error in the shape each agent understands.
fn error(provider: Option<Provider>, status: StatusCode, message: &str) -> Response {
    let kind = match status.as_u16() {
        401 => "authentication_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        529 => "overloaded_error",
        s if s >= 500 => "api_error",
        _ => "invalid_request_error",
    };
    let body = match provider {
        Some(Provider::Codex) => json!({ "error": { "type": kind, "message": message } }),
        _ => json!({ "type": "error", "error": { "type": kind, "message": message } }),
    };
    (status, axum::Json(body)).into_response()
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
fn forwardable(client: &HeaderMap) -> HeaderMap {
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
fn returnable(upstream: &HeaderMap) -> HeaderMap {
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
    use axum::http::HeaderValue;

    #[test]
    fn routes_prefixed_and_v1_paths() {
        let none = HeaderMap::new();
        assert_eq!(
            route("/claude/v1/messages?beta=true", &none),
            Some((Provider::Claude, "/v1/messages?beta=true".into()))
        );
        assert_eq!(
            route("/codex/responses", &none),
            Some((Provider::Codex, "/responses".into()))
        );
        assert_eq!(
            route("/v1/messages?beta=true", &none),
            Some((Provider::Claude, "/v1/messages?beta=true".into()))
        );
        assert_eq!(
            route("/v1/responses", &none),
            Some((Provider::Codex, "/responses".into()))
        );
        assert_eq!(
            route("/v1/models?client_version=0.159.3", &none),
            Some((Provider::Codex, "/models?client_version=0.159.3".into()))
        );
        assert_eq!(
            route("/v1/models?limit=1000", &none),
            Some((Provider::Claude, "/v1/models?limit=1000".into()))
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

//! Forwarding with failover.
//!
//! Every account gets at most one attempt per request (plus one retry after
//! a forced token refresh, and for Codex one retry without account-bound
//! state). Failover only happens before any response byte reaches the agent;
//! once a stream starts it is passed through untouched.

use std::sync::Arc;

use crate::time::{SignedDuration, Timestamp};
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::Request;
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::rawjson::{self, Seg};
use super::sse::{Tap, Tapped};
use super::{App, claude, codex, error, returnable};
use crate::account::{Account, Provider};
use crate::auth;
use crate::credits::{self, Outcome};
use crate::limits::{self, Refusal};
use crate::pool::{Choice, DEFAULT_BLOCK, DEFAULT_THROTTLE, Pick, Unavailable};
use crate::ui;

/// Largest request body accepted (images make Messages bodies big).
const MAX_BODY: usize = 256 * 1024 * 1024;
/// How long to sit out an account the provider refused for other reasons.
const ACCOUNT_BLOCK: SignedDuration = SignedDuration::from_mins(30);

/// The agent's request, buffered so it can be replayed on another account.
struct Inbound {
    provider: Provider,
    target: String,
    parts: Parts,
    body: Bytes,
    /// Whether the body is plain JSON slopmax may inspect and edit.
    json: bool,
    session: Option<String>,
    model: Option<String>,
}

impl Inbound {
    fn new(provider: Provider, target: String, parts: Parts, body: Bytes) -> Self {
        let encoded = parts
            .headers
            .get("content-encoding")
            .is_some_and(|v| v.as_bytes() != b"identity");
        let json = !encoded && rawjson::is_valid(&body);
        let inspectable: &[u8] = if json { &body } else { b"" };
        let session = match provider {
            Provider::Claude => claude::session_id(&parts.headers, inspectable),
            Provider::Codex => codex::session_id(&parts.headers, inspectable),
        };
        let model = json
            .then(|| rawjson::find_str(&body, &[Seg::Key("model")]))
            .flatten();
        Self {
            provider,
            target,
            parts,
            body,
            json,
            session,
            model,
        }
    }

    /// The body to send with `account`.
    fn body_for(&self, account: &Account, strip_state: bool) -> Bytes {
        if !self.json {
            return self.body.clone();
        }
        match self.provider {
            Provider::Claude => {
                claude::prepare_body(&self.body, account, self.session.as_deref()).into()
            }
            Provider::Codex if strip_state => codex::strip_account_state(&self.body)
                .map(Bytes::from)
                .unwrap_or_else(|| self.body.clone()),
            Provider::Codex => self.body.clone(),
        }
    }
}

/// An upstream error response, read fully so it can be classified.
struct Failure {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
    /// Whether the account's quota was spent (as opposed to other errors).
    exhausted: bool,
}

impl Failure {
    async fn read(response: reqwest::Response) -> Self {
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.bytes().await.unwrap_or_default();
        Self {
            status,
            headers,
            body,
            exhausted: false,
        }
    }

    fn into_response(self) -> Response {
        let mut response = Response::new(Body::from(self.body));
        *response.status_mut() = self.status;
        *response.headers_mut() = returnable(&self.headers);
        response
    }
}

enum Attempt {
    /// A final response for the agent.
    Done(Response),
    /// The account failed; try another.
    Failed(Option<Failure>),
}

pub(super) async fn forward(
    app: Arc<App>,
    provider: Provider,
    target: String,
    request: Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let Ok(body) = to_bytes(body, MAX_BODY).await else {
        return error(
            Some(provider),
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body is too large",
        );
    };
    let inbound = Inbound::new(provider, target, parts, body);
    let mut tried: Vec<String> = Vec::new();
    let mut last: Option<Failure> = None;
    let mut rescued = false;
    loop {
        let pick = Pick {
            provider,
            session: inbound.session.as_deref(),
            model: inbound.model.as_deref(),
            exclude: &tried,
        };
        let choice = match app.pool.pick(&pick, Timestamp::now()) {
            Ok(choice) => choice,
            Err(unavailable) => {
                let spent = unavailable.until.is_some();
                if spent
                    && provider == Provider::Codex
                    && app.config.redeem_when_exhausted
                    && !rescued
                {
                    rescued = true;
                    if let Some(id) = rescue(&app).await {
                        tried.retain(|t| *t != id);
                        continue;
                    }
                }
                return give_up(provider, unavailable, last);
            }
        };
        tried.push(choice.account.id.clone());
        match attempt(&app, &inbound, choice).await {
            Attempt::Done(response) => return response,
            Attempt::Failed(failure) => last = failure.or(last),
        }
    }
}

async fn attempt(app: &Arc<App>, inbound: &Inbound, choice: Choice) -> Attempt {
    let id = choice.account.id.clone();
    let moved = choice.moved_from.is_some();
    let Some(mut account) = app.ready(&choice.account).await else {
        return Attempt::Failed(None);
    };
    let mut stripped = moved;
    let mut refreshed = false;
    let mut body = inbound.body_for(&account, stripped);
    loop {
        let response = match send(app, inbound, &account, body.clone(), moved).await {
            Ok(response) => response,
            Err(e) => {
                tracing::warn!("{id}: upstream unreachable: {e}");
                app.pool.record_error(&id, &format!("network error: {e}"));
                return Attempt::Failed(None);
            }
        };
        let now = Timestamp::now();
        let headers = response.headers();
        let observed = match inbound.provider {
            Provider::Claude => limits::from_claude_headers(headers, now),
            Provider::Codex => limits::from_codex_headers(headers, now),
        };
        if let Some(limits) = observed {
            app.pool.observe(&id, limits, now);
        }
        if response.status().is_success() {
            app.pool.record_success(&id, now);
            let path = inbound.target.split('?').next().unwrap_or_default();
            let model = inbound.model.as_deref().unwrap_or("-");
            tracing::info!(
                "{id} {} {path} {model} → {}",
                inbound.parts.method,
                response.status().as_u16()
            );
            return Attempt::Done(stream_back(app, inbound.provider, id, response));
        }

        let mut failure = Failure::read(response).await;
        let status = failure.status.as_u16();
        tracing::info!("{id}: upstream returned {status}");
        match (inbound.provider, status) {
            (_, 401) if !refreshed && app.config.refresh_tokens => {
                refreshed = true;
                match auth::ensure_fresh(&app.auth_http, &app.store, &account, true).await {
                    Ok(fresh) => {
                        account = fresh;
                        body = inbound.body_for(&account, stripped);
                        continue;
                    }
                    Err(e) => {
                        app.pool.record_error(&id, &e.to_string());
                        return Attempt::Failed(Some(failure));
                    }
                }
            }
            (Provider::Codex, 400) if !stripped && codex::rejects_account_state(&failure.body) => {
                stripped = true;
                body = inbound.body_for(&account, stripped);
                continue;
            }
            (_, 401 | 403) => {
                let reason = if status == 401 {
                    "unauthorized"
                } else {
                    "forbidden"
                };
                app.pool.block(&id, now + ACCOUNT_BLOCK, None, reason);
                return Attempt::Failed(Some(failure));
            }
            (Provider::Claude, 429) | (Provider::Codex, 429 | 402) => {
                let refusal = match inbound.provider {
                    Provider::Claude => {
                        limits::claude_refusal(&failure.headers, inbound.model.as_deref(), now)
                    }
                    Provider::Codex => {
                        limits::codex_refusal(status, &failure.headers, &failure.body, now)
                    }
                };
                match refusal {
                    Refusal::Exhausted { until, model } => {
                        failure.exhausted = true;
                        let until = until.unwrap_or(now + DEFAULT_BLOCK);
                        app.pool
                            .block(&id, until, model.as_deref(), "usage limit reached");
                        tracing::info!("{id}: limited until {until}; switching accounts");
                    }
                    Refusal::Throttled { until } => {
                        app.pool
                            .throttle(&id, until.unwrap_or(now + DEFAULT_THROTTLE));
                    }
                }
                return Attempt::Failed(Some(failure));
            }
            (Provider::Codex, s) if s >= 500 && codex::reports_usage_limit(&failure.body) => {
                failure.exhausted = true;
                app.pool
                    .block(&id, now + DEFAULT_BLOCK, None, "usage limit reached");
                return Attempt::Failed(Some(failure));
            }
            _ => return Attempt::Done(failure.into_response()),
        }
    }
}

/// Redeems a banked reset credit on a spent Codex account. Returns the
/// account that can serve again, if any.
async fn rescue(app: &App) -> Option<String> {
    let _redeeming = app.redeeming.lock().await;
    let now = Timestamp::now();
    let accounts: Vec<Account> = app
        .pool
        .accounts()
        .into_iter()
        .filter(|a| a.provider == Provider::Codex && !a.disabled && a.auth_error.is_none())
        .collect();
    // Another request may have redeemed while this one waited for the lock.
    if let Some(free) = accounts
        .iter()
        .find(|a| !app.pool.state(&a.id).is_blocked(now))
    {
        return Some(free.id.clone());
    }
    let mut spent: Vec<(Account, Timestamp)> = accounts
        .into_iter()
        .filter_map(|a| {
            let state = app.pool.state(&a.id);
            let credits = state.limits.reset_credits.unwrap_or(0);
            let until = state.blocked_until.max(state.limits.exhausted_until(now))?;
            (credits > 0).then_some((a, until))
        })
        .collect();
    // Free the account that would otherwise stay blocked the longest.
    spent.sort_by_key(|(_, until)| std::cmp::Reverse(*until));
    for (picked, _) in spent {
        let Some(account) = app.ready(&picked).await else {
            continue;
        };
        match credits::redeem(&app.auth_http, &app.upstream, &account, None).await {
            Ok(Outcome::Reset) => {
                tracing::info!("{}: redeemed a reset credit", account.id);
                app.pool.record_reset(&account.id, Timestamp::now());
                return Some(account.id);
            }
            Ok(outcome) => tracing::info!("{}: reset credit not used ({outcome:?})", account.id),
            Err(e) => tracing::warn!("{}: redeeming a reset credit: {e:#}", account.id),
        }
    }
    None
}

async fn send(
    app: &App,
    inbound: &Inbound,
    account: &Account,
    body: Bytes,
    moved: bool,
) -> reqwest::Result<reqwest::Response> {
    let token = &account.tokens.access_token;
    let (url, headers) = match inbound.provider {
        Provider::Claude => (
            app.upstream.claude(&inbound.target),
            claude::upstream_headers(&inbound.parts.headers, token),
        ),
        Provider::Codex => (
            app.upstream.codex(&inbound.target),
            codex::upstream_headers(
                &inbound.parts.headers,
                token,
                account.account_id.as_deref(),
                moved,
            ),
        ),
    };
    app.http
        .request(inbound.parts.method.clone(), url)
        .headers(headers)
        .body(body)
        .send()
        .await
}

/// Streams a successful response to the agent, recording token usage (and
/// any quota refusal inside the stream) when it ends.
fn stream_back(
    app: &Arc<App>,
    provider: Provider,
    id: String,
    response: reqwest::Response,
) -> Response {
    let status = response.status();
    let headers = returnable(response.headers());
    let pool_app = Arc::clone(app);
    let stream = Tapped::new(
        response.bytes_stream(),
        Tap::new(provider),
        move |outcome| {
            pool_app.pool.add_usage(&id, &outcome.usage);
            if outcome.exhausted {
                let until = Timestamp::now() + DEFAULT_BLOCK;
                pool_app
                    .pool
                    .block(&id, until, None, "usage limit reached mid-stream");
            }
        },
    );
    let mut out = Response::new(Body::from_stream(stream));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    out
}

/// The response when no account can take the request.
fn give_up(provider: Provider, unavailable: Unavailable, last: Option<Failure>) -> Response {
    match (last, unavailable.until) {
        // Every account is spent: report the earliest reset, in the shape the
        // agent shows as its own usage-limit message.
        (Some(failure), Some(until)) if failure.exhausted => exhausted(provider, until),
        (Some(failure), _) => failure.into_response(),
        (None, Some(until)) => exhausted(provider, until),
        (None, None) => error(
            Some(provider),
            StatusCode::SERVICE_UNAVAILABLE,
            &unavailable.reason,
        ),
    }
}

fn exhausted(provider: Provider, until: Timestamp) -> Response {
    let now = Timestamp::now();
    let wait = until.duration_since(now).as_secs().max(1);
    let message = format!(
        "slopmax: every {provider} account is rate limited; the next one frees up in {} (`slopmax status` for details)",
        ui::duration(until.duration_since(now))
    );
    let (body, extra) = match provider {
        Provider::Claude => (
            json!({ "type": "error", "error": { "type": "rate_limit_error", "message": message } }),
            vec![
                ("anthropic-ratelimit-unified-status", "rejected".to_owned()),
                (
                    "anthropic-ratelimit-unified-reset",
                    until.as_second().to_string(),
                ),
            ],
        ),
        Provider::Codex => (
            json!({ "error": {
                "type": "usage_limit_reached",
                "message": message,
                "resets_at": until.as_second(),
                "resets_in_seconds": wait,
            } }),
            Vec::new(),
        ),
    };
    let mut response = (StatusCode::TOO_MANY_REQUESTS, axum::Json(body)).into_response();
    let headers = response.headers_mut();
    headers.insert("retry-after", HeaderValue::from(wait));
    for (name, value) in extra {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(name, value);
        }
    }
    response
}

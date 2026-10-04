//! Forwarding with failover.
//!
//! Routing turns the request's model into steps: providers and the accounts
//! that may serve it, in order. Every account gets at most one attempt per
//! request (plus one retry after a forced token refresh, and for Codex one
//! retry without account-bound state). Failover only happens before any
//! response byte reaches the agent; once a stream starts it is passed
//! through untouched.

use std::borrow::Cow;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use http::request::Parts;
use http::{HeaderMap, HeaderValue, StatusCode};
use http_body_util::LengthLimitError;

use super::rawjson::{self, Seg};
use super::sse::{Tap, Tapped};
use super::start::{self, Start};
use super::{App, Target, error, json_reply, returnable};
use crate::account::Account;
use crate::agent::{self, Agent};
use crate::auth;
use crate::ledger::Entry;
use crate::log;
use crate::net::body::{self, Body};
use crate::net::client::{self, Response as Upstream};
use crate::net::server::{Request, Response};
use crate::pool::{Choice, DEFAULT_BLOCK, DEFAULT_THROTTLE, Pick, Unavailable};
use crate::provider::credits::Outcome;
use crate::provider::{ProviderId, Verdict};
use crate::route::{self, NoRoute, Step};
use crate::time::{SignedDuration, Timestamp};
use crate::ui;
use crate::wire::Dialect;

/// Largest request body accepted (images make Messages bodies big).
const MAX_BODY: usize = 256 * 1024 * 1024;
/// How long to sit out an account the provider refused for other reasons.
const ACCOUNT_BLOCK: SignedDuration = SignedDuration::from_mins(30);

/// The agent's request, buffered so it can be replayed on another account.
struct Inbound {
    /// When the request arrived, for the usage ledger's timings.
    started: Instant,
    target: Target,
    parts: Parts,
    body: Bytes,
    /// Whether the body is plain JSON slopmax may inspect and edit.
    json: bool,
    agent: Option<&'static dyn Agent>,
    session: Option<String>,
    model: Option<String>,
}

impl Inbound {
    fn new(target: Target, parts: Parts, body: Bytes) -> Self {
        let encoded = parts
            .headers
            .get("content-encoding")
            .is_some_and(|v| v.as_bytes() != b"identity");
        let json = !encoded && rawjson::is_valid(&body);
        let inspectable: &[u8] = if json { &body } else { b"" };
        let agent = agent::detect(&parts.headers);
        let session = agent::session(agent, &parts.headers, inspectable);
        let model = json
            .then(|| rawjson::find_str(&body, &[Seg::Key("model")]))
            .flatten();
        Self {
            started: Instant::now(),
            target,
            parts,
            body,
            json,
            agent,
            session,
            model,
        }
    }

    /// The body to send for `step`: as the agent sent it, except for asking
    /// for the step's model when routing renamed it, and dropping state
    /// bound to another account when the session moved.
    fn body(&self, step: &Step, strip_state: bool) -> Bytes {
        if !self.json {
            return self.body.clone();
        }
        let mut body = Cow::Borrowed(&self.body[..]);
        if self.model.as_deref().is_some_and(|m| m != step.model)
            && let Some(range) = rawjson::find(&body, &[Seg::Key("model")])
        {
            let model = serde_json::to_vec(&step.model).expect("strings serialize");
            body = Cow::Owned(rawjson::splice(&body, range, &model));
        }
        if strip_state && let Some(rebound) = step.provider.get().rebind(&body) {
            body = Cow::Owned(rebound);
        }
        match body {
            Cow::Borrowed(_) => self.body.clone(),
            Cow::Owned(edited) => edited.into(),
        }
    }

    /// The steps that may serve this request.
    fn plan(&self, app: &App) -> Result<Vec<Step>, NoRoute> {
        let accounts = app.pool.accounts();
        let config = &app.config;
        let table = route::Table {
            accounts: &accounts,
            aliases: &config.aliases,
            fallbacks: &config.fallbacks,
            paid_overflow: config.paid_overflow,
        };
        match (&self.model, self.target.by_model, self.target.provider) {
            (Some(model), true, _) => route::plan(
                &table,
                &route::Request {
                    model,
                    dialect: self.target.dialect,
                    agent: self.agent.map(|a| a.id()),
                    default: self.target.provider,
                },
            ),
            // Anything else goes to the API its path belongs to.
            (_, _, Some(provider)) => {
                native_step(&table, provider, self.model.as_deref(), self.agent)
            }
            (_, _, None) => Err(NoRoute::NoModel),
        }
    }
}

/// The one step for a request routed by its path.
fn native_step(
    table: &route::Table,
    provider: ProviderId,
    model: Option<&str>,
    agent: Option<&dyn Agent>,
) -> Result<Vec<Step>, NoRoute> {
    if let Some(only) = provider.spec().agent_only
        && agent.map(|a| a.id()) != Some(only)
    {
        let agent = agent::find(only).map_or(only, |a| a.title());
        return Err(NoRoute::Refused { provider, agent });
    }
    let accounts = table
        .accounts
        .iter()
        .filter(|a| a.provider == provider)
        .map(|a| a.id.clone())
        .collect();
    Ok(vec![Step {
        provider,
        model: model.unwrap_or_default().to_owned(),
        accounts,
    }])
}

/// The reply when routing finds no way to serve a request.
fn refusal(dialect: Dialect, headers: &HeaderMap, no: NoRoute) -> Response {
    match no {
        NoRoute::Refused { provider, agent } => {
            let client = headers
                .get(http::header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("an unidentified client");
            let message = format!(
                "slopmax serves {} accounts to {agent} only; this request came from {client}",
                provider.spec().title
            );
            error(Some(dialect), StatusCode::FORBIDDEN, &message)
        }
        NoRoute::NoModel => error(
            Some(dialect),
            StatusCode::BAD_REQUEST,
            "the request names no model",
        ),
        NoRoute::Unserved { model } => {
            let message = format!(
                "no connected account serves {model:?} in the {} format (`slopmax status` lists accounts)",
                dialect.as_str()
            );
            error(Some(dialect), StatusCode::NOT_FOUND, &message)
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
    async fn read(response: Upstream) -> Self {
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
        let mut response = Response::new(body::full(self.body));
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

pub(super) async fn forward(app: Arc<App>, target: Target, request: Request) -> Response {
    let dialect = target.dialect;
    let (parts, body) = request.into_parts();
    let body = match body::read(body, MAX_BODY).await {
        Ok(body) => body,
        Err(e) if e.is::<LengthLimitError>() => {
            return error(
                Some(dialect),
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body is too large",
            );
        }
        Err(e) => {
            let message = format!("could not read the request body: {e}");
            return error(Some(dialect), StatusCode::BAD_REQUEST, &message);
        }
    };
    let inbound = Inbound::new(target, parts, body);
    let steps = match inbound.plan(&app) {
        Ok(steps) => steps,
        Err(no) => return refusal(dialect, &inbound.parts.headers, no),
    };
    let mut tried: Vec<String> = Vec::new();
    let mut last: Option<Failure> = None;
    let mut unavailable: Option<Unavailable> = None;
    for step in &steps {
        let mut rescued = false;
        loop {
            let pick = Pick {
                provider: step.provider,
                session: inbound.session.as_deref(),
                model: Some(step.model.as_str()).filter(|m| !m.is_empty()),
                candidates: Some(&step.accounts),
                exclude: &tried,
            };
            let choice = match app.pool.pick(&pick, Timestamp::now()) {
                Ok(choice) => choice,
                Err(none) => {
                    let spent = none.until.is_some();
                    if spent && app.config.redeem_when_exhausted && !rescued {
                        rescued = true;
                        if let Some(id) = rescue(&app, step.provider).await {
                            tried.retain(|t| *t != id);
                            continue;
                        }
                    }
                    unavailable = Some(sooner(unavailable, none));
                    break;
                }
            };
            tried.push(choice.account.id.clone());
            match attempt(&app, &inbound, step, choice, tried.len()).await {
                Attempt::Done(response) => return response,
                Attempt::Failed(failure) => last = failure.or(last),
            }
        }
    }
    give_up(dialect, steps[0].provider, unavailable, last)
}

/// Combines why two steps could not serve: the earliest return wins.
fn sooner(earlier: Option<Unavailable>, next: Unavailable) -> Unavailable {
    let Some(earlier) = earlier else {
        return next;
    };
    let until = match (earlier.until, next.until) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    Unavailable {
        until,
        reason: earlier.reason,
    }
}

async fn attempt(
    app: &Arc<App>,
    inbound: &Inbound,
    step: &Step,
    choice: Choice,
    attempts: usize,
) -> Attempt {
    let id = choice.account.id.clone();
    let moved = choice.moved_from.is_some();
    let Some(mut account) = app.ready(&choice.account).await else {
        return Attempt::Failed(None);
    };
    let provider = step.provider.get();
    let dialect = inbound.target.dialect;
    let model = Some(step.model.as_str()).filter(|m| !m.is_empty());
    // Keys cannot be refreshed; a rejected one is simply set aside.
    let refreshable = account.tokens.refresh_token.is_some() || account.link.is_some();
    let mut stripped = moved;
    let mut refreshed = false;
    let mut body = inbound.body(step, stripped);
    loop {
        let response = match send(app, inbound, step, &account, body.clone(), moved).await {
            Ok(response) => response,
            Err(e) => {
                log::warn!("{id}: upstream unreachable: {e}");
                app.pool.record_error(&id, &format!("network error: {e}"));
                return Attempt::Failed(None);
            }
        };
        let now = Timestamp::now();
        if let Some(limits) = provider.limits(response.headers(), now) {
            app.pool.observe(&id, limits, now);
        }
        if response.status().is_success() {
            let status = response.status();
            let headers = response.headers().clone();
            let mut body = response.into_body();
            if dialect.holds_start() {
                match start::hold(body, dialect).await {
                    Start::Streaming(started) => body = started,
                    Start::Refused { exhausted, held } => {
                        if exhausted {
                            app.pool
                                .block(&id, now + DEFAULT_BLOCK, None, "usage limit reached");
                            log::info!("{id}: limited inside the stream; switching accounts");
                        } else {
                            app.pool.throttle(&id, now + DEFAULT_THROTTLE);
                        }
                        let failure = Failure {
                            status,
                            headers,
                            body: held,
                            exhausted,
                        };
                        return Attempt::Failed(Some(failure));
                    }
                }
            }
            app.pool.record_success(&id, now);
            let path = inbound.target.path.split('?').next().unwrap_or_default();
            log::info!(
                "{id} {} {path} {} → {}",
                inbound.parts.method,
                model.unwrap_or("-"),
                status.as_u16()
            );
            let served = Served {
                id,
                provider: step.provider,
                model: model.map(str::to_owned).or_else(|| inbound.model.clone()),
                status,
                started: inbound.started,
                attempts: attempts as u32,
            };
            return Attempt::Done(stream_back(app, dialect, served, &headers, body));
        }

        let mut failure = Failure::read(response).await;
        log::info!("{id}: upstream returned {}", failure.status.as_u16());
        let verdict = provider.verdict(failure.status, &failure.headers, &failure.body, model, now);
        match verdict {
            Verdict::Unauthorized if !refreshed && refreshable && app.config.refresh_tokens => {
                refreshed = true;
                match auth::ensure_fresh(&app.auth_http, &app.store, &account, true).await {
                    Ok(fresh) => {
                        account = fresh;
                        body = inbound.body(step, stripped);
                        continue;
                    }
                    Err(e) => {
                        app.pool.record_error(&id, &e.to_string());
                        return Attempt::Failed(Some(failure));
                    }
                }
            }
            Verdict::StaleState if !stripped => {
                stripped = true;
                body = inbound.body(step, stripped);
                continue;
            }
            Verdict::Unauthorized | Verdict::Forbidden => {
                let reason = if verdict == Verdict::Unauthorized {
                    "unauthorized"
                } else {
                    "forbidden"
                };
                app.pool.block(&id, now + ACCOUNT_BLOCK, None, reason);
                return Attempt::Failed(Some(failure));
            }
            Verdict::Exhausted { until, model } => {
                failure.exhausted = true;
                let until = until.unwrap_or(now + DEFAULT_BLOCK);
                app.pool
                    .block(&id, until, model.as_deref(), "usage limit reached");
                log::info!("{id}: limited until {until}; switching accounts");
                return Attempt::Failed(Some(failure));
            }
            Verdict::Throttled { until } => {
                app.pool
                    .throttle(&id, until.unwrap_or(now + DEFAULT_THROTTLE));
                return Attempt::Failed(Some(failure));
            }
            Verdict::StaleState | Verdict::Final => return Attempt::Done(failure.into_response()),
        }
    }
}

/// Redeems a banked reset credit on a spent account of `provider`, if it
/// grants them. Returns the account that can serve again, if any.
async fn rescue(app: &App, provider: ProviderId) -> Option<String> {
    let credits = provider.get().credits()?;
    let _redeeming = app.redeeming.lock().await;
    let now = Timestamp::now();
    let accounts: Vec<Account> = app
        .pool
        .accounts()
        .into_iter()
        .filter(|a| a.provider == provider && !a.disabled && a.auth_error.is_none())
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
        match credits.redeem(&app.auth_http, &account, None).await {
            Ok(Outcome::Reset) => {
                log::info!("{}: redeemed a reset credit", account.id);
                app.pool.record_reset(&account.id, Timestamp::now());
                return Some(account.id);
            }
            Ok(outcome) => log::info!("{}: reset credit not used ({outcome:?})", account.id),
            Err(e) => log::warn!("{}: redeeming a reset credit: {e:#}", account.id),
        }
    }
    None
}

async fn send(
    app: &App,
    inbound: &Inbound,
    step: &Step,
    account: &Account,
    body: Bytes,
    moved: bool,
) -> Result<Upstream, client::Error> {
    let provider = step.provider.get();
    let base = provider.api(account).trim_end_matches('/');
    let url = format!("{base}{}", inbound.target.path);
    let headers = provider.headers(&inbound.parts.headers, account, moved);
    app.http
        .request(inbound.parts.method.clone(), url)
        .headers(headers)
        .body(body)
        .send()
        .await
}

/// Streams a successful response to the agent, recording token usage (and
/// any quota refusal inside the stream) when it ends.
/// A response being streamed back, for the usage ledger.
struct Served {
    id: String,
    provider: ProviderId,
    model: Option<String>,
    status: StatusCode,
    started: Instant,
    attempts: u32,
}

fn stream_back(
    app: &Arc<App>,
    dialect: Dialect,
    served: Served,
    headers: &HeaderMap,
    body: Body,
) -> Response {
    let status = served.status;
    let tap = Tap::for_response(dialect, headers);
    let headers = returnable(headers);
    let pool_app = Arc::clone(app);
    let stream = Tapped::new(body, tap, move |outcome, first_byte| {
        let id = &served.id;
        pool_app.pool.add_usage(id, &outcome.usage);
        if outcome.exhausted {
            let until = Timestamp::now() + DEFAULT_BLOCK;
            pool_app
                .pool
                .block(id, until, None, "usage limit reached mid-stream");
        }
        let millis = |at: Instant| at.duration_since(served.started).as_millis() as u64;
        let usage = outcome.usage;
        pool_app.ledger.record(Entry {
            at: Timestamp::now(),
            account: served.id,
            provider: served.provider,
            model: served.model,
            status: served.status.as_u16(),
            input: usage.input_tokens,
            output: usage.output_tokens,
            cache_read: usage.cache_read_tokens,
            cache_write: usage.cache_write_tokens,
            ms: millis(Instant::now()),
            first_byte_ms: first_byte.map(millis),
            attempts: served.attempts,
        });
    });
    let mut out = Response::new(body::boxed(stream));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    out
}

/// The response when no account can take the request.
fn give_up(
    dialect: Dialect,
    provider: ProviderId,
    unavailable: Option<Unavailable>,
    last: Option<Failure>,
) -> Response {
    let until = unavailable.as_ref().and_then(|u| u.until);
    match (last, until) {
        // Every account is spent: report the earliest reset, in the shape the
        // agent shows as its own usage-limit message.
        (Some(failure), Some(until)) if failure.exhausted => {
            limit_reached(dialect, provider, until)
        }
        (Some(failure), _) => failure.into_response(),
        (None, Some(until)) => limit_reached(dialect, provider, until),
        (None, None) => error(
            Some(dialect),
            StatusCode::SERVICE_UNAVAILABLE,
            unavailable
                .as_ref()
                .map_or("no account could take the request", |u| u.reason.as_str()),
        ),
    }
}

fn limit_reached(dialect: Dialect, provider: ProviderId, until: Timestamp) -> Response {
    let now = Timestamp::now();
    let message = format!(
        "slopmax: every {} account is rate limited; the next one frees up in {} (`slopmax status` for details)",
        provider.spec().title,
        ui::duration(until.duration_since(now))
    );
    let (body, extra) = dialect.limit_reached(&message, until, now);
    let mut response = json_reply(StatusCode::TOO_MANY_REQUESTS, &body);
    let headers = response.headers_mut();
    let wait = until.duration_since(now).as_secs().max(1);
    headers.insert("retry-after", HeaderValue::from(wait));
    for (name, value) in extra {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(name, value);
        }
    }
    response
}

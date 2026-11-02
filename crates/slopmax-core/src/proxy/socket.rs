//! WebSockets for Codex. A socket from Codex is relayed to ChatGPT's own
//! WebSocket endpoint on one account, which keeps the conversation warm
//! upstream and starts answers sooner than HTTP streaming.
//!
//! A socket stays on the account it opened on. When that account turns out
//! to be spent mid-turn, the socket is closed: Codex retries on a new
//! socket with the whole conversation, and that one opens on an account
//! that can serve. Anything slopmax cannot relay is refused with 426, which
//! sends Codex back to HTTP streaming, where failover is finer-grained.

use std::sync::Arc;
use std::time::Duration;

use http::{HeaderMap, HeaderValue, StatusCode, header};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::time::Instant;

use super::{App, Target, error};
use crate::account::Account;
use crate::agent;
use crate::config::ClientKey;
use crate::ledger::{End, Entry};
use crate::limits::Refusal;
use crate::log;
use crate::net::body;
use crate::net::server::{Request, Response};
use crate::net::ws::{self, Message, Reader, Writer};
use crate::pool::{DEFAULT_BLOCK, DEFAULT_THROTTLE, Pick};
use crate::provider::ProviderId;
use crate::provider::codex::{limits, wire};
use crate::route;
use crate::time::Timestamp;
use crate::wire::rawjson::{self, Seg};
use crate::wire::{Dialect, Usage, sse};

/// The WebSocket protocol version ChatGPT's endpoint speaks.
const BETA: &str = "responses_websockets=2026-02-06";
/// How long the upstream handshake may take.
const CONNECT: Duration = Duration::from_secs(15);

type Socket = TokioIo<Upgraded>;

/// Answers a WebSocket handshake on Codex's path: relays it, or refuses
/// with 426 so Codex streams over HTTP instead.
pub(super) async fn accept(
    app: Arc<App>,
    target: Target,
    mut request: Request,
    client: Option<&ClientKey>,
) -> Response {
    let headers = request.headers().clone();
    let refuse = |why: &str| {
        log::info!("websocket refused ({why}); Codex will stream over HTTP");
        upgrade_required()
    };
    if !app.config().websockets {
        return refuse("websockets are off in the config");
    }
    if target.provider != Some(ProviderId::Codex) || !target.by_model {
        return refuse("only Codex's /responses is relayed");
    }
    // A socket carries many requests, each naming its own model; a key
    // held to some models is checked request by request, over HTTP.
    if client.is_some_and(|key| !key.models.is_empty()) {
        return refuse("the key is held to some models");
    }
    let Some(key) = text(&headers, "sec-websocket-key").map(str::to_owned) else {
        return error(None, StatusCode::BAD_REQUEST, "missing Sec-WebSocket-Key");
    };
    if text(&headers, "sec-websocket-version") != Some("13") {
        let mut response = upgrade_required();
        response
            .headers_mut()
            .insert("sec-websocket-version", HeaderValue::from_static("13"));
        return response;
    }

    // Codex names the model in its routing hint; a socket only serves
    // models ChatGPT serves as they are.
    let model = routing_model(&headers);
    let agent = agent::detect(&headers);
    let session = agent::session(agent, &headers, b"");
    let accounts = app.pool.accounts();
    let candidates: Vec<String> = match &model {
        Some(model) => {
            let table = route::Table {
                accounts: &accounts,
                aliases: &app.config().aliases,
                fallbacks: &app.config().fallbacks,
                paid_overflow: app.config().paid_overflow,
            };
            let request = route::Request {
                model,
                dialect: Dialect::Responses,
                agent: agent.map(|a| a.id()),
                default: Some(ProviderId::Codex),
            };
            match route::plan(&table, &request)
                .ok()
                .and_then(|s| s.into_iter().next())
            {
                Some(step) if step.provider == ProviderId::Codex && step.model == *model => {
                    step.accounts
                }
                _ => return refuse("the model is not served by a ChatGPT account"),
            }
        }
        None => accounts
            .iter()
            .filter(|a| a.provider == ProviderId::Codex)
            .map(|a| a.id.clone())
            .collect(),
    };
    let pick = Pick {
        provider: ProviderId::Codex,
        session: session.as_deref(),
        affinity: super::affinity(&headers),
        housekeeping: false,
        model: model.as_deref(),
        candidates: Some(&candidates),
        exclude: &[],
    };
    let Ok(choice) = app.pool.pick(&pick, Timestamp::now()) else {
        return refuse("no ChatGPT account can serve now");
    };
    let moved = choice.moved_from.is_some();
    let Some(account) = app.ready(&choice.account).await else {
        return refuse("the account's sign-in could not be refreshed");
    };
    let (upstream, answer) = match connect(&app, &headers, &account, moved).await {
        Ok(connected) => connected,
        Err(why) => {
            log::warn!("{}: websocket handshake failed: {why}", account.id);
            return refuse("the upstream handshake failed");
        }
    };

    let mut response = Response::new(body::empty());
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let out = response.headers_mut();
    out.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    out.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    if let Ok(accept) = HeaderValue::from_str(&ws::accept_key(&key)) {
        out.insert("sec-websocket-accept", accept);
    }
    for name in ["openai-model", "x-reasoning-included", "x-models-etag"] {
        if let Some(value) = answer.get(name) {
            out.insert(name, value.clone());
        }
    }
    let upgrading = hyper::upgrade::on(&mut request);
    let origin = Origin {
        agent: agent.map(|a| a.id()),
        session,
    };
    // Tracked, so a stop closes the socket and records its turn.
    app.clone().spawn(async move {
        match upgrading.await {
            Ok(client) => {
                relay(app, account, TokioIo::new(client), upstream, moved, origin).await;
            }
            Err(e) => log::warn!("websocket upgrade failed: {e}"),
        }
    });
    log::info!("websocket opened on {}", choice.account.id);
    response
}

fn upgrade_required() -> Response {
    error(
        Some(Dialect::Responses),
        StatusCode::UPGRADE_REQUIRED,
        "slopmax relays this over HTTP streaming",
    )
}

fn text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

/// `gpt-6-sol` from `x-codex-routing-hint: model=gpt-6-sol;tier=…`.
fn routing_model(headers: &HeaderMap) -> Option<String> {
    text(headers, "x-codex-routing-hint")?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("model="))
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
}

/// Opens the upstream socket on `account`. Returns it with the headers of
/// the upstream's `101`.
async fn connect(
    app: &App,
    client: &HeaderMap,
    account: &Account,
    moved: bool,
) -> Result<(Socket, HeaderMap), String> {
    let provider = ProviderId::Codex.get();
    let mut own = client.clone();
    for name in [
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-protocol",
    ] {
        own.remove(name);
    }
    let mut headers = provider.headers(&own, account, moved);
    let key = ws::new_key();
    for (name, value) in [
        ("upgrade", "websocket"),
        ("connection", "Upgrade"),
        ("sec-websocket-version", "13"),
        ("sec-websocket-key", key.as_str()),
    ] {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(name, value);
        }
    }
    headers.remove("accept-encoding");
    headers
        .entry("openai-beta")
        .or_insert(HeaderValue::from_static(BETA));
    let url = format!("{}/responses", provider.api(account));
    let response = app
        .http
        .get(url)
        .headers(headers)
        .timeout(CONNECT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        return Err(format!("answered {}", response.status()));
    }
    let accepted = response
        .headers()
        .get("sec-websocket-accept")
        .and_then(|v| v.to_str().ok());
    if accepted != Some(ws::accept_key(&key).as_str()) {
        return Err("the handshake's accept key is wrong".into());
    }
    let answer = response.headers().clone();
    let socket = response.upgrade().await.map_err(|e| e.to_string())?;
    Ok((socket, answer))
}

/// The turn in flight, for the usage ledger.
#[derive(Debug, Default)]
struct Turn {
    started: Option<Instant>,
    model: Option<String>,
    first_byte: Option<Instant>,
}

/// Who opened the socket, for the usage ledger.
struct Origin {
    agent: Option<&'static str>,
    session: Option<String>,
}

/// How long a socket may carry nothing either way before it is closed.
const IDLE: Duration = Duration::from_secs(600);
/// How long the upstream has to answer a close the client started.
const CLOSING: Duration = Duration::from_secs(5);

/// What woke the relay.
enum Woke {
    Client(std::io::Result<Option<Message>>),
    Upstream(std::io::Result<Option<Message>>),
    Stop,
    Idle,
}

/// What a message means for the relay.
enum Next {
    Go,
    /// The relay is done; the turn in flight ended this way.
    Done(End),
}

/// Relays messages both ways until either side closes, the socket idles,
/// or the daemon stops: one task, one buffer and one writer per side.
/// Writing to one side holds back reading the other, which is the
/// backpressure a slow side should get.
async fn relay(
    app: Arc<App>,
    account: Arc<Account>,
    client: Socket,
    upstream: Socket,
    moved: bool,
    origin: Origin,
) {
    let (client_read, client_write) = tokio::io::split(client);
    let (upstream_read, upstream_write) = tokio::io::split(upstream);
    let mut ends = Ends {
        client: Writer::server(client_write),
        upstream: Writer::client(upstream_write),
    };
    let mut from_client = Reader::new(client_read);
    let mut from_upstream = Reader::new(upstream_read);
    let mut turn = Turn::default();
    let mut last = Instant::now();
    let mut closing: Option<Instant> = None;
    let idle = tokio::time::sleep(IDLE);
    tokio::pin!(idle);
    let end = loop {
        let woke = tokio::select! {
            () = app.stop.cancelled() => Woke::Stop,
            read = from_client.message(), if closing.is_none() => Woke::Client(read),
            read = from_upstream.message() => Woke::Upstream(read),
            () = &mut idle => Woke::Idle,
        };
        let next = match woke {
            Woke::Stop => {
                let _ = ends.upstream.send(&Message::Close(None)).await;
                let _ = ends
                    .client
                    .send(&Message::close(1001, "slopmax is stopping"))
                    .await;
                Next::Done(End::Cut)
            }
            Woke::Idle => {
                let due = closing.map_or(last + IDLE, |at| at + CLOSING);
                if Instant::now() < due {
                    idle.as_mut().reset(due);
                    continue;
                }
                let _ = ends.upstream.send(&Message::Close(None)).await;
                let _ = ends.client.send(&Message::close(1000, "idle")).await;
                Next::Done(End::Stalled)
            }
            Woke::Client(read) => {
                last = Instant::now();
                match from_codex(read, &mut ends, &mut turn, moved).await {
                    // The client began closing: the upstream has a moment
                    // to answer, for the client to hear it.
                    Next::Done(End::ClientGone) if closing.is_none() => {
                        closing = Some(Instant::now());
                        idle.as_mut().reset(Instant::now() + CLOSING);
                        Next::Go
                    }
                    next => next,
                }
            }
            Woke::Upstream(read) => {
                last = Instant::now();
                from_chatgpt(&app, &account.id, read, &mut ends, &mut turn, &origin).await
            }
        };
        if let Next::Done(end) = next {
            break if closing.is_some() {
                End::ClientGone
            } else {
                end
            };
        }
    };
    // A turn cut short is recorded as it ended, so every turn counts once.
    if turn.started.is_some() {
        record(&app, &account.id, None, &mut turn, &origin, Some(end));
    }
}

/// Both sides' writers.
struct Ends {
    client: Writer<tokio::io::WriteHalf<Socket>>,
    upstream: Writer<tokio::io::WriteHalf<Socket>>,
}

/// A message from Codex, sent on up.
async fn from_codex(
    read: std::io::Result<Option<Message>>,
    ends: &mut Ends,
    turn: &mut Turn,
    moved: bool,
) -> Next {
    let message = match read {
        Ok(Some(message)) => message,
        Ok(None) | Err(_) => {
            let _ = ends.upstream.send(&Message::Close(None)).await;
            return Next::Done(End::ClientGone);
        }
    };
    let message = match message {
        Message::Text(text) => Message::Text(outgoing(text, turn, moved)),
        Message::Ping(data) => {
            let _ = ends.client.send(&Message::Pong(data)).await;
            return Next::Go;
        }
        Message::Pong(_) => return Next::Go,
        Message::Close(close) => {
            let _ = ends.upstream.send(&Message::Close(close)).await;
            return Next::Done(End::ClientGone);
        }
        binary => binary,
    };
    match ends.upstream.send(&message).await {
        Ok(()) => Next::Go,
        Err(_) => {
            let _ = ends
                .client
                .send(&Message::close(1011, "upstream closed"))
                .await;
            Next::Done(End::UpstreamError)
        }
    }
}

/// A client message on its way up: a new turn starts the clock, and on a
/// socket that moved accounts, state bound to the old account is dropped.
/// Only the type and model are read, in place; a conversation of
/// megabytes is parsed only when it must be edited.
fn outgoing(text: String, turn: &mut Turn, moved: bool) -> String {
    let bytes = text.as_bytes();
    let creates = sse::kind(bytes).map_or_else(
        || rawjson::find_str(bytes, &[Seg::Key("type")]).as_deref() == Some("response.create"),
        |kind| kind == b"response.create",
    );
    if !creates {
        return text;
    }
    *turn = Turn {
        started: Some(Instant::now()),
        model: rawjson::find_str(bytes, &[Seg::Key("model")]),
        first_byte: None,
    };
    if !moved {
        return text;
    }
    let Ok(mut request) = serde_json::from_str::<Value>(&text) else {
        return text;
    };
    let mut changed = request
        .get_mut("client_metadata")
        .and_then(Value::as_object_mut)
        .and_then(|m| m.remove("x-codex-turn-state"))
        .is_some();
    let mut bytes = serde_json::to_vec(&request).expect("values serialize");
    if let Some(stripped) = wire::strip_account_state(&bytes) {
        bytes = stripped;
        changed = true;
    }
    match changed {
        true => String::from_utf8(bytes).unwrap_or(text),
        false => text,
    }
}

/// A message from ChatGPT, sent on to Codex: rate limits read and shown
/// pooled, finished turns recorded, and a spent account's socket closed.
async fn from_chatgpt(
    app: &App,
    id: &str,
    read: std::io::Result<Option<Message>>,
    ends: &mut Ends,
    turn: &mut Turn,
    origin: &Origin,
) -> Next {
    let message = match read {
        Ok(Some(message)) => message,
        Ok(None) | Err(_) => {
            let _ = ends
                .client
                .send(&Message::close(1011, "upstream closed"))
                .await;
            return Next::Done(End::UpstreamError);
        }
    };
    let text = match message {
        Message::Text(text) => text,
        Message::Ping(data) => {
            let _ = ends.upstream.send(&Message::Pong(data)).await;
            return Next::Go;
        }
        Message::Pong(_) => return Next::Go,
        Message::Close(close) => {
            let _ = ends.client.send(&Message::Close(close)).await;
            return Next::Done(End::UpstreamError);
        }
        binary => return forward(ends, &binary).await,
    };
    turn.first_byte.get_or_insert_with(Instant::now);
    // Deltas, nearly every message, pass unparsed.
    let kind = sse::kind(text.as_bytes());
    let telling = match kind {
        Some(kind) => matches!(
            kind,
            b"codex.rate_limits"
                | b"response.completed"
                | b"response.incomplete"
                | b"response.done"
                | b"response.failed"
                | b"error"
        ),
        None => true,
    };
    let event = match telling
        .then(|| serde_json::from_str::<Value>(&text).ok())
        .flatten()
    {
        Some(event) => event,
        None => return forward(ends, &Message::Text(text)).await,
    };
    let now = Timestamp::now();
    match event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "codex.rate_limits" => {
            if let Some(limits) = limits::from_event(&event, now) {
                app.pool.observe(id, limits, now);
            }
            // Codex sees the pool, not this account.
            let windows = app.pool.pooled(ProviderId::Codex, now);
            if !windows.is_empty() {
                let mut pooled = event;
                limits::pool_event(&windows, &mut pooled);
                return forward(ends, &Message::Text(pooled.to_string())).await;
            }
        }
        "response.completed" | "response.incomplete" | "response.done" => {
            app.pool.record_success(id, now);
            record(app, id, Some(&event), turn, origin, None);
        }
        "response.failed" | "error" => {
            if let Some(refusal) = refusal(&event, now) {
                // Leave the turn unfinished: Codex retries it on a new
                // socket, which opens on another account.
                match refusal {
                    Refusal::Exhausted { until, model } => {
                        let until = until.unwrap_or(now + DEFAULT_BLOCK);
                        app.pool
                            .block(id, until, model.as_deref(), "usage limit reached");
                        log::info!("{id}: limited inside a websocket; closing it");
                    }
                    Refusal::Throttled { until } => {
                        app.pool
                            .throttle(id, until.unwrap_or(now + DEFAULT_THROTTLE));
                    }
                }
                *turn = Turn::default();
                let _ = ends.upstream.send(&Message::Close(None)).await;
                let _ = ends
                    .client
                    .send(&Message::close(1012, "the account is limited; reconnect"))
                    .await;
                return Next::Done(End::Complete);
            }
        }
        _ => {}
    }
    forward(ends, &Message::Text(text)).await
}

/// Sends an upstream message on to Codex.
async fn forward(ends: &mut Ends, message: &Message) -> Next {
    match ends.client.send(message).await {
        Ok(()) => Next::Go,
        Err(_) => {
            let _ = ends.upstream.send(&Message::Close(None)).await;
            Next::Done(End::ClientGone)
        }
    }
}

/// A failure event that is the account's rather than the request's.
fn refusal(event: &Value, now: Timestamp) -> Option<Refusal> {
    let error = event
        .pointer("/response/error")
        .or_else(|| event.get("error"))?;
    let code = ["code", "type"]
        .iter()
        .find_map(|k| error.get(*k).and_then(Value::as_str))
        .unwrap_or_default();
    match code {
        "usage_limit_reached"
        | "usage_limit_exceeded"
        | "usage_not_included"
        | "insufficient_quota" => {
            let body = serde_json::to_vec(&serde_json::json!({ "error": error })).ok()?;
            Some(limits::refusal(429, &HeaderMap::new(), &body, now))
        }
        "server_is_overloaded" | "slow_down" | "rate_limit_exceeded" => {
            Some(Refusal::Throttled { until: None })
        }
        _ => None,
    }
}

/// Records a turn in the ledger and the account's counters: finished
/// with `event`, or cut short as `end` says.
fn record(
    app: &App,
    id: &str,
    event: Option<&Value>,
    turn: &mut Turn,
    origin: &Origin,
    end: Option<End>,
) {
    let turn = std::mem::take(turn);
    let usage = event
        .and_then(|e| e.pointer("/response/usage"))
        .map(crate::wire::responses::events::usage)
        .unwrap_or(Usage {
            requests: 1,
            ..Usage::default()
        });
    app.pool.add_usage(id, &usage);
    let started = turn.started.unwrap_or_else(Instant::now);
    let millis = |at: Instant| at.duration_since(started).as_millis() as u64;
    let entry = Entry {
        at: Timestamp::now(),
        account: id.to_owned(),
        provider: ProviderId::Codex,
        model: turn.model,
        status: 200,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_read: usage.cache_read_tokens,
        cache_write: usage.cache_write_tokens,
        ms: millis(Instant::now()),
        first_byte_ms: turn.first_byte.map(millis),
        attempts: 1,
        agent: origin.agent.map(str::to_owned),
        session: origin.session.clone(),
        end,
    };
    app.record(&entry);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_routing_hint_names_the_model() {
        let mut headers = HeaderMap::new();
        assert_eq!(routing_model(&headers), None);
        headers.insert(
            "x-codex-routing-hint",
            HeaderValue::from_static("model=gpt-6-sol;tier=priority"),
        );
        assert_eq!(routing_model(&headers).as_deref(), Some("gpt-6-sol"));
    }

    #[test]
    fn spent_accounts_close_the_socket_and_request_errors_pass() {
        let now = Timestamp::from_second(1_000).unwrap();
        let spent = json!({"type": "error", "status": 429,
            "error": {"type": "usage_limit_reached", "resets_at": 5_000}});
        assert_eq!(
            refusal(&spent, now),
            Some(Refusal::Exhausted {
                until: Timestamp::from_second(5_000),
                model: None
            })
        );
        let busy = json!({"type": "response.failed", "response": {"error": {"code": "server_is_overloaded"}}});
        assert_eq!(
            refusal(&busy, now),
            Some(Refusal::Throttled { until: None })
        );
        let request = json!({"type": "response.failed", "response": {"error": {"code": "context_length_exceeded"}}});
        assert_eq!(refusal(&request, now), None);
    }

    #[test]
    fn moved_sockets_drop_old_account_state() {
        let mut turn = Turn::default();
        let create = json!({"type": "response.create", "model": "gpt-6-sol",
            "previous_response_id": "resp_1",
            "input": [{"type": "reasoning", "summary": [], "encrypted_content": "gAAA"}],
            "client_metadata": {"x-codex-turn-state": "sticky", "session_id": "s"}})
        .to_string();
        let kept = outgoing(create.clone(), &mut turn, false);
        assert_eq!(kept, create);
        assert_eq!(turn.model.as_deref(), Some("gpt-6-sol"));
        let moved: Value = serde_json::from_str(&outgoing(create, &mut turn, true)).unwrap();
        assert!(moved.get("previous_response_id").is_none());
        assert!(moved["input"][0].get("encrypted_content").is_none());
        assert!(moved["client_metadata"].get("x-codex-turn-state").is_none());
        assert_eq!(moved["client_metadata"]["session_id"], "s");
    }
}

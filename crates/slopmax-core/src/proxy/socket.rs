//! WebSockets for Codex. A socket from Codex is relayed to ChatGPT's own
//! WebSocket endpoint on one account, which keeps the conversation warm
//! upstream and starts answers sooner than HTTP streaming.
//!
//! A socket stays on the account it opened on. When that account turns out
//! to be spent mid-turn, the socket is closed: Codex retries on a new
//! socket with the whole conversation, and that one opens on an account
//! that can serve. Anything slopmax cannot relay is refused with 426, which
//! sends Codex back to HTTP streaming, where failover is finer-grained.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http::{HeaderMap, HeaderValue, StatusCode, header};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::io::BufReader;
use tokio::sync::mpsc;

use super::{App, Target, error};
use crate::account::Account;
use crate::agent;
use crate::config::ClientKey;
use crate::ledger::Entry;
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
use crate::wire::Dialect;
use crate::wire::Usage;

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
    tokio::spawn(async move {
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

/// Relays messages both ways until either side closes.
async fn relay(
    app: Arc<App>,
    account: Account,
    client: Socket,
    upstream: Socket,
    moved: bool,
    origin: Origin,
) {
    let (client_read, client_write) = tokio::io::split(client);
    let (upstream_read, upstream_write) = tokio::io::split(upstream);
    let (to_client, mut for_client) = mpsc::channel::<Message>(64);
    let (to_upstream, mut for_upstream) = mpsc::channel::<Message>(64);
    let client_writer = tokio::spawn(async move {
        let mut writer = Writer::server(client_write);
        while let Some(message) = for_client.recv().await {
            let last = matches!(message, Message::Close(_));
            if writer.send(&message).await.is_err() || last {
                break;
            }
        }
    });
    let upstream_writer = tokio::spawn(async move {
        let mut writer = Writer::client(upstream_write);
        while let Some(message) = for_upstream.recv().await {
            let last = matches!(message, Message::Close(_));
            if writer.send(&message).await.is_err() || last {
                break;
            }
        }
    });
    let turn = Arc::new(Mutex::new(Turn::default()));
    let mut from_client = tokio::spawn(from_client(
        Reader::new(BufReader::new(client_read)),
        to_upstream.clone(),
        to_client.clone(),
        Arc::clone(&turn),
        moved,
    ));
    let mut from_upstream = tokio::spawn(from_upstream(
        app,
        account,
        Reader::new(BufReader::new(upstream_read)),
        to_client,
        to_upstream,
        turn,
        origin,
    ));
    // Either side ending ends the relay; the writers flush what is queued,
    // closes included, once their senders are gone.
    tokio::select! {
        _ = &mut from_client => from_upstream.abort(),
        _ = &mut from_upstream => from_client.abort(),
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        let _ = client_writer.await;
        let _ = upstream_writer.await;
    })
    .await;
}

async fn from_client(
    mut reader: Reader<BufReader<tokio::io::ReadHalf<Socket>>>,
    to_upstream: mpsc::Sender<Message>,
    to_client: mpsc::Sender<Message>,
    turn: Arc<Mutex<Turn>>,
    moved: bool,
) {
    loop {
        let message = match reader.message().await {
            Ok(Some(message)) => message,
            Ok(None) | Err(_) => {
                let _ = to_upstream.send(Message::Close(None)).await;
                return;
            }
        };
        let message = match message {
            Message::Text(text) => Message::Text(outgoing(text, &turn, moved)),
            Message::Ping(data) => {
                let _ = to_client.send(Message::Pong(data)).await;
                continue;
            }
            Message::Pong(_) => continue,
            Message::Close(close) => {
                let _ = to_upstream.send(Message::Close(close)).await;
                return;
            }
            binary => binary,
        };
        if to_upstream.send(message).await.is_err() {
            return;
        }
    }
}

/// A client message on its way up: a new turn starts the clock, and on a
/// socket that moved accounts, state bound to the old account is dropped.
fn outgoing(text: String, turn: &Mutex<Turn>, moved: bool) -> String {
    let Ok(mut request) = serde_json::from_str::<Value>(&text) else {
        return text;
    };
    if request.get("type").and_then(Value::as_str) != Some("response.create") {
        return text;
    }
    *turn.lock().unwrap_or_else(|p| p.into_inner()) = Turn {
        started: Some(Instant::now()),
        model: request
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        first_byte: None,
    };
    if !moved {
        return text;
    }
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

async fn from_upstream(
    app: Arc<App>,
    account: Account,
    mut reader: Reader<BufReader<tokio::io::ReadHalf<Socket>>>,
    to_client: mpsc::Sender<Message>,
    to_upstream: mpsc::Sender<Message>,
    turn: Arc<Mutex<Turn>>,
    origin: Origin,
) {
    let id = account.id.clone();
    loop {
        let message = match reader.message().await {
            Ok(Some(message)) => message,
            Ok(None) | Err(_) => {
                let _ = to_client
                    .send(Message::close(1011, "upstream closed"))
                    .await;
                return;
            }
        };
        let text = match message {
            Message::Text(text) => text,
            Message::Ping(data) => {
                let _ = to_upstream.send(Message::Pong(data)).await;
                continue;
            }
            Message::Pong(_) => continue,
            Message::Close(close) => {
                let _ = to_client.send(Message::Close(close)).await;
                return;
            }
            binary => {
                let _ = to_client.send(binary).await;
                continue;
            }
        };
        let now = Timestamp::now();
        if let Ok(event) = serde_json::from_str::<Value>(&text) {
            turn.lock()
                .unwrap_or_else(|p| p.into_inner())
                .first_byte
                .get_or_insert_with(Instant::now);
            match event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "codex.rate_limits" => {
                    if let Some(limits) = limits::from_event(&event, now) {
                        app.pool.observe(&id, limits, now);
                    }
                    // Codex sees the pool, not this account.
                    let windows = app.pool.pooled(ProviderId::Codex, now);
                    if !windows.is_empty() {
                        let mut pooled = event.clone();
                        limits::pool_event(&windows, &mut pooled);
                        if to_client
                            .send(Message::Text(pooled.to_string()))
                            .await
                            .is_err()
                        {
                            return;
                        }
                        continue;
                    }
                }
                "response.completed" | "response.incomplete" | "response.done" => {
                    app.pool.record_success(&id, now);
                    record(&app, &id, &event, &turn, &origin);
                }
                "response.failed" | "error" => {
                    if let Some(refusal) = refusal(&event, now) {
                        // Leave the turn unfinished: Codex retries it on a
                        // new socket, which opens on another account.
                        match refusal {
                            Refusal::Exhausted { until, model } => {
                                let until = until.unwrap_or(now + DEFAULT_BLOCK);
                                app.pool
                                    .block(&id, until, model.as_deref(), "usage limit reached");
                                log::info!("{id}: limited inside a websocket; closing it");
                            }
                            Refusal::Throttled { until } => {
                                app.pool
                                    .throttle(&id, until.unwrap_or(now + DEFAULT_THROTTLE));
                            }
                        }
                        let _ = to_upstream.send(Message::Close(None)).await;
                        let _ = to_client
                            .send(Message::close(1012, "the account is limited; reconnect"))
                            .await;
                        return;
                    }
                }
                _ => {}
            }
        }
        if to_client.send(Message::Text(text)).await.is_err() {
            return;
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

/// Records a finished turn in the ledger and the account's counters.
fn record(app: &App, id: &str, event: &Value, turn: &Mutex<Turn>, origin: &Origin) {
    let turn = std::mem::take(&mut *turn.lock().unwrap_or_else(|p| p.into_inner()));
    let usage = event
        .pointer("/response/usage")
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
    };
    app.broadcast(&entry);
    app.ledger.record(entry);
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
        let turn = Mutex::new(Turn::default());
        let create = json!({"type": "response.create", "model": "gpt-6-sol",
            "previous_response_id": "resp_1",
            "input": [{"type": "reasoning", "summary": [], "encrypted_content": "gAAA"}],
            "client_metadata": {"x-codex-turn-state": "sticky", "session_id": "s"}})
        .to_string();
        let kept = outgoing(create.clone(), &turn, false);
        assert_eq!(kept, create);
        assert_eq!(turn.lock().unwrap().model.as_deref(), Some("gpt-6-sol"));
        let moved: Value = serde_json::from_str(&outgoing(create, &turn, true)).unwrap();
        assert!(moved.get("previous_response_id").is_none());
        assert!(moved["input"][0].get("encrypted_content").is_none());
        assert!(moved["client_metadata"].get("x-codex-turn-state").is_none());
        assert_eq!(moved["client_metadata"]["session_id"], "s");
    }
}

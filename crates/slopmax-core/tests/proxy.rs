//! End-to-end tests: agent → slopmax → mock provider.
//!
//! The mock decides how to answer from the bearer token, so each account in
//! the store can be made to succeed, hit its limit, or reject its token. It
//! also serves ChatGPT's reset-credit endpoints.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http::{HeaderMap, Method, StatusCode};
use serde_json::{Value, json};
use slopmax_core::account::{Account, Endpoint, Store, Tokens};
use slopmax_core::config::{Config, Strategy};
use slopmax_core::ledger;
use slopmax_core::limits::{Limits, Window};
use slopmax_core::net::body;
use slopmax_core::net::client::RequestBuilder;
use slopmax_core::net::server::{self, Request, Response};
use slopmax_core::net::{Client, Origins, ws};
use slopmax_core::paths::Home;
use slopmax_core::pool::State as PoolState;
use slopmax_core::provider::ProviderId;
use slopmax_core::provider::credits::Credit;
use slopmax_core::proxy::{self, App};
use slopmax_core::time::{SignedDuration, Timestamp};
use slopmax_core::wire::Dialect;
use tokio::net::TcpListener;

const KEY: &str = "sm-test-key";

#[derive(Debug, Clone)]
struct Seen {
    path: String,
    headers: HeaderMap,
    body: Bytes,
}

type Log = Arc<Mutex<Vec<Seen>>>;

/// Serves `handler` on a free local port and returns its base URL.
async fn serve<H, F>(handler: H) -> String
where
    H: Fn(Request) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(server::serve(listener, handler, std::future::pending()));
    format!("http://{addr}")
}

fn reply(
    status: StatusCode,
    headers: &[(&'static str, String)],
    body: impl Into<Bytes>,
) -> Response {
    let mut response = Response::new(body::full(body));
    *response.status_mut() = status;
    for (name, value) in headers {
        response.headers_mut().insert(*name, value.parse().unwrap());
    }
    response
}

fn reset_in(secs: i64) -> i64 {
    (Timestamp::now() + SignedDuration::from_secs(secs)).as_second()
}

/// Whether a reset credit has been redeemed so far.
fn redeemed(log: &Log) -> bool {
    log.lock()
        .unwrap()
        .iter()
        .any(|s| s.path.ends_with("/consume"))
}

/// The provider stand-in: records each request, then answers by route and
/// bearer token.
async fn mock(log: Log, mut request: Request) -> Response {
    if request.headers().contains_key("upgrade") {
        return mock_socket(log, &mut request);
    }
    // Other programs on the machine may probe any open port; only what
    // slopmax sends counts.
    if request.uri().path() == "/" {
        return reply(StatusCode::NOT_FOUND, &[], "");
    }
    let (parts, incoming) = request.into_parts();
    let body = body::read(incoming, usize::MAX).await.unwrap();
    log.lock().unwrap().push(Seen {
        path: parts.uri.to_string(),
        headers: parts.headers.clone(),
        body,
    });
    let headers = &parts.headers;
    match (parts.method, parts.uri.path()) {
        (Method::POST, "/v1/messages") => mock_claude(headers),
        (Method::POST, "/codex/responses") => mock_codex(&log, headers),
        (Method::GET, "/wham/rate-limit-reset-credits") => mock_credits(headers),
        (Method::GET, "/wham/usage") => {
            // A poll that takes a while, for callers that ask at once.
            if headers
                .get("authorization")
                .is_some_and(|v| v == "Bearer tok-slow-poll")
            {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let usage = json!({ "plan_type": "pro", "rate_limit": { "primary_window": {
                    "used_percent": 5, "limit_window_seconds": 18000, "reset_at": reset_in(3600)
                } } });
                return reply(StatusCode::OK, &[], usage.to_string());
            }
            let usage = json!({ "plan_type": "pro", "rate_limit": { "primary_window": {
                "used_percent": 5, "limit_window_seconds": 18000, "reset_at": reset_in(3600)
            } } });
            keyed(
                headers,
                "Bearer tok-ok",
                reply(StatusCode::OK, &[], usage.to_string()),
            )
        }
        (Method::POST, "/wham/rate-limit-reset-credits/consume") => {
            reply(StatusCode::OK, &[], json!({ "code": "reset" }).to_string())
        }
        (Method::GET, "/api/oauth/usage") => mock_claude_resets(headers),
        (Method::POST, path)
            if path.starts_with("/api/organizations/") && path.ends_with("/reset_rate_limits") =>
        {
            let reset = json!({ "result": "reset", "resets_left": 0, "cleared": ["five_hour", "seven_day"] });
            reply(StatusCode::OK, &[], reset.to_string())
        }
        (Method::POST, "/xai/v1/chat/completions") => {
            keyed(headers, "Bearer key-xai", chat_answer())
        }
        (Method::POST, "/local/v1/chat/completions") => chat_answer(),
        (Method::GET, "/xai/v1/models") => {
            let list =
                json!({"object": "list", "data": [{"id": "grok-4"}, {"id": "grok-code-fast-1"}]});
            keyed(
                headers,
                "Bearer key-xai",
                reply(StatusCode::OK, &[], list.to_string()),
            )
        }
        (Method::GET, "/codex/models") => {
            let catalog = json!({"models": [
                {"slug": "gpt-6-sol", "visibility": "list"},
                {"slug": "gpt-internal", "visibility": "hide"}
            ]});
            keyed(
                headers,
                "Bearer tok-ok",
                reply(StatusCode::OK, &[], catalog.to_string()),
            )
        }
        (Method::POST, "/openai/v1/responses") => {
            let answer = reply(
                StatusCode::OK,
                &[("content-type", "text/event-stream".to_owned())],
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}}\n\n",
            );
            keyed(headers, "Bearer key-openai", answer)
        }
        (Method::POST, "/kimi/v1/messages") => {
            let answer = reply(
                StatusCode::OK,
                &[],
                r#"{"type":"message","content":[],"usage":{"input_tokens":3,"output_tokens":1}}"#,
            );
            match headers.get("x-api-key") {
                Some(key) if key == "key-kimi" => answer,
                _ => reply(StatusCode::UNAUTHORIZED, &[], ""),
            }
        }
        _ => reply(StatusCode::NOT_FOUND, &[], ""),
    }
}

/// ChatGPT's WebSocket endpoint: answers each `response.create` by the
/// account's token, as `mock_codex` does over HTTP.
fn mock_socket(log: Log, request: &mut Request) -> Response {
    let headers = request.headers().clone();
    log.lock().unwrap().push(Seen {
        path: format!("ws {}", request.uri()),
        headers: headers.clone(),
        body: Bytes::new(),
    });
    let key = headers["sec-websocket-key"].to_str().unwrap().to_owned();
    let token = headers["authorization"].to_str().unwrap().to_owned();
    let upgrading = hyper::upgrade::on(request);
    tokio::spawn(async move {
        let io = hyper_util::rt::TokioIo::new(upgrading.await.unwrap());
        let (read, write) = tokio::io::split(io);
        let mut reader = ws::Reader::new(tokio::io::BufReader::new(read));
        let mut writer = ws::Writer::server(write);
        while let Ok(Some(message)) = reader.message().await {
            let ws::Message::Text(text) = message else {
                break;
            };
            log.lock().unwrap().push(Seen {
                path: "ws message".into(),
                headers: HeaderMap::new(),
                body: Bytes::from(text),
            });
            let events: Vec<Value> = match token.as_str() {
                // Starts an answer and never finishes it.
                "Bearer tok-slow" => {
                    vec![json!({"type": "response.created", "response": {"id": "r"}})]
                }
                "Bearer tok-limited" => vec![
                    json!({"type": "response.created", "response": {"id": "r"}}),
                    json!({"type": "error", "status": 429,
                        "error": {"type": "usage_limit_reached", "message": "limit", "resets_at": reset_in(5400)}}),
                ],
                _ => vec![
                    json!({"type": "response.created", "response": {"id": "r"}}),
                    json!({"type": "codex.rate_limits", "rate_limits": {"primary":
                        {"used_percent": 33, "window_minutes": 300, "reset_at": reset_in(3600)}}}),
                    json!({"type": "response.output_text.delta", "item_id": "m", "delta": "Hi"}),
                    json!({"type": "response.completed", "response": {"id": "r", "usage":
                        {"input_tokens": 50, "input_tokens_details": {"cached_tokens": 20},
                         "output_tokens": 4, "total_tokens": 54}}}),
                ],
            };
            for event in events {
                if writer
                    .send(&ws::Message::Text(event.to_string()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    });
    let mut response = reply(StatusCode::SWITCHING_PROTOCOLS, &[], Bytes::new());
    let out = response.headers_mut();
    out.insert("upgrade", "websocket".parse().unwrap());
    out.insert("connection", "Upgrade".parse().unwrap());
    out.insert(
        "sec-websocket-accept",
        ws::accept_key(&key).parse().unwrap(),
    );
    response
}

/// `answer` for requests carrying `authorization`, else a 401.
fn keyed(headers: &HeaderMap, authorization: &str, answer: Response) -> Response {
    match headers.get("authorization") {
        Some(value) if value == authorization => answer,
        _ => reply(StatusCode::UNAUTHORIZED, &[], ""),
    }
}

fn chat_answer() -> Response {
    reply(
        StatusCode::OK,
        &[("content-type", "application/json".to_owned())],
        json!({
            "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 3}
        })
        .to_string(),
    )
}

fn mock_claude(headers: &HeaderMap) -> Response {
    match headers["authorization"].to_str().unwrap() {
        "Bearer tok-limited" => reply(
            StatusCode::TOO_MANY_REQUESTS,
            &[
                ("anthropic-ratelimit-unified-status", "rejected".to_owned()),
                (
                    "anthropic-ratelimit-unified-5h-status",
                    "rejected".to_owned(),
                ),
                (
                    "anthropic-ratelimit-unified-5h-reset",
                    reset_in(3600).to_string(),
                ),
                (
                    "anthropic-ratelimit-unified-5h-utilization",
                    "1.0".to_owned(),
                ),
            ],
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}"#,
        ),
        "Bearer tok-ok" => reply(
            StatusCode::OK,
            &[
                ("content-type", "text/event-stream".to_owned()),
                (
                    "anthropic-ratelimit-unified-5h-utilization",
                    "0.25".to_owned(),
                ),
                (
                    "anthropic-ratelimit-unified-5h-reset",
                    reset_in(7200).to_string(),
                ),
            ],
            concat!(
                "event: message_start\n",
                r#"data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":1}}}"#,
                "\n\nevent: message_delta\n",
                r#"data: {"type":"message_delta","usage":{"output_tokens":25}}"#,
                "\n\n",
            ),
        ),
        "Bearer tok-fast" => reply(
            StatusCode::TOO_MANY_REQUESTS,
            &[("anthropic-ratelimit-unified-status", "allowed".to_owned())],
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}"#,
        ),
        _ => reply(
            StatusCode::UNAUTHORIZED,
            &[],
            r#"{"type":"error","error":{"type":"authentication_error"}}"#,
        ),
    }
}

fn mock_codex(log: &Log, headers: &HeaderMap) -> Response {
    let token = headers["authorization"].to_str().unwrap();
    // `tok-credit` is spent until a reset credit is redeemed.
    let spent = token == "Bearer tok-limited" || (token == "Bearer tok-credit" && !redeemed(log));
    match token {
        // Answers with reasoning, text, and a tool call.
        "Bearer tok-talk" => reply(
            StatusCode::OK,
            &[("content-type", "text/event-stream".to_owned())],
            concat!(
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"reasoning\",\"summary\":[],\"encrypted_content\":\"enc-1\"}}\n\n",
                "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"m1\",\"delta\":\"Hello\"}\n\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"id\":\"m1\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello\"}]}}\n\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"Bash\",\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"}}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"usage\":{\"input_tokens\":30,\"input_tokens_details\":{\"cached_tokens\":10},\"output_tokens\":5,\"total_tokens\":35}}}\n\n",
            ),
        ),
        // Spent, but only says so inside a 200 stream.
        "Bearer tok-quiet" => reply(
            StatusCode::OK,
            &[("content-type", "text/event-stream".to_owned())],
            concat!(
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n",
                "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\",\"message\":\"limit\"}}}\n\n",
            ),
        ),
        _ if spent => reply(
            StatusCode::TOO_MANY_REQUESTS,
            &[],
            json!({ "error": { "type": "usage_limit_reached", "message": "limit", "resets_at": reset_in(5400) } }).to_string(),
        ),
        // Fails with a passing server error every other request.
        "Bearer tok-flaky" if count(log, token) % 2 == 1 => reply(
            StatusCode::SERVICE_UNAVAILABLE,
            &[],
            r#"{"error":{"message":"upstream connect error"}}"#,
        ),
        "Bearer tok-down" => reply(
            StatusCode::BAD_GATEWAY,
            &[],
            r#"{"error":{"message":"bad gateway"}}"#,
        ),
        "Bearer tok-ok" | "Bearer tok-credit" | "Bearer tok-flaky" => reply(
            StatusCode::OK,
            &[
                ("content-type", "text/event-stream".to_owned()),
                ("x-codex-primary-used-percent", "40".to_owned()),
                ("x-codex-primary-window-minutes", "10080".to_owned()),
                ("x-codex-primary-reset-at", reset_in(86_400).to_string()),
            ],
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"usage\":{\"input_tokens\":100,\"input_tokens_details\":{\"cached_tokens\":60},\"output_tokens\":7}}}\n\n",
        ),
        _ => reply(StatusCode::UNAUTHORIZED, &[], ""),
    }
}

/// How many requests carrying `token` the mock has seen, this one included.
fn count(log: &Log, token: &str) -> usize {
    log.lock()
        .unwrap()
        .iter()
        .filter(|s| s.headers.get("authorization").is_some_and(|v| v == token))
        .count()
}

/// Claude's usage, with its limit resets: two grants for `tok-ok`, the one
/// expiring later named next, listed only to Claude Code, as Claude does.
fn mock_claude_resets(headers: &HeaderMap) -> Response {
    let at = |hours| (Timestamp::now() + SignedDuration::from_hours(hours)).to_string();
    let claude_code = headers
        .get("user-agent")
        .is_some_and(|agent| agent.to_str().unwrap().starts_with("claude-cli/"));
    let status = if !claude_code {
        json!({ "eligible": false, "ineligible_reason": "surface", "grants": [] })
    } else if headers["authorization"] == "Bearer tok-ok" {
        json!({
            "eligible": true,
            "grants": [
                { "id": "older", "resets_total": 1, "resets_left": 1, "ends_at": at(30) },
                { "id": "launch", "label": "Model launch: one usage-limit reset",
                  "resets_total": 1, "resets_left": 1, "starts_at": at(-24 * 15), "ends_at": at(24 * 15) },
            ],
            "next_grant_id": "launch",
        })
    } else {
        json!({ "eligible": false, "ineligible_reason": "no_grant" })
    };
    let usage =
        json!({ "five_hour": { "utilization": 25.0, "resets_at": at(2) }, "cedar_ember": status });
    reply(StatusCode::OK, &[], usage.to_string())
}

/// `tok-expiring` holds a credit that lapses within the hour; every other
/// account's credits last for days.
fn mock_credits(headers: &HeaderMap) -> Response {
    let expires = |hours| (Timestamp::now() + SignedDuration::from_hours(hours)).to_string();
    let mut credits =
        vec![json!({ "id": "credit-later", "status": "available", "expires_at": expires(48) })];
    if headers["authorization"] == "Bearer tok-expiring" {
        credits.push(json!({
            "id": "credit-soon", "status": "available",
            "granted_at": expires(-29 * 24), "expires_at": expires(1),
        }));
        credits
            .push(json!({ "id": "credit-spent", "status": "redeemed", "expires_at": expires(0) }));
    }
    reply(
        StatusCode::OK,
        &[],
        json!({ "credits": credits }).to_string(),
    )
}

struct Harness {
    proxy: String,
    /// The sandbox: accounts, and the usage ledger under `usage/`.
    dir: std::path::PathBuf,
    app: Arc<App>,
    log: Log,
    ids: Vec<String>,
    _dir: TempDir,
}

struct TempDir(std::path::PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn account(provider: ProviderId, name: &str, token: &str, added: i64) -> Account {
    let mut account = Account::new(
        provider,
        Tokens {
            access_token: token.into(),
            refresh_token: Some(format!("refresh-{name}")),
            expires_at: Some(Timestamp::now() + SignedDuration::from_hours(8)),
            ..Tokens::default()
        },
    );
    account.email = Some(format!("{name}@example.com"));
    account.org_id = Some(format!("org-{name}"));
    account.account_id = Some(format!("acct-{name}"));
    account.added_at = Timestamp::from_second(added).unwrap();
    account.assign_id();
    account
}

/// Accounts are tried in the order given (fill-first by age).
async fn harness(provider: ProviderId, tokens: &[&str]) -> Harness {
    harness_with(provider, tokens, |_| {}).await
}

async fn harness_with(
    provider: ProviderId,
    tokens: &[&str],
    configure: impl FnOnce(&mut Config),
) -> Harness {
    let accounts = |_: &str| {
        tokens
            .iter()
            .enumerate()
            .map(|(i, token)| {
                let name = format!("{}{i}", provider.as_str());
                account(provider, &name, token, 1000 + i as i64)
            })
            .collect()
    };
    harness_of(accounts, configure).await
}

/// A harness whose accounts `build` makes, given the mock's base URL (for
/// compatible endpoints).
async fn harness_of(
    build: impl FnOnce(&str) -> Vec<Account>,
    configure: impl FnOnce(&mut Config),
) -> Harness {
    let dir = std::env::temp_dir().join(format!(
        "slopmax-it-{}-{}",
        std::process::id(),
        slopmax_core::ids::token()
    ));
    let log: Log = Arc::default();
    let upstream_url = serve({
        let log = log.clone();
        move |request| mock(log.clone(), request)
    })
    .await;
    let store = Store::at(dir.join("accounts"));
    let mut ids = Vec::new();
    for account in build(&upstream_url) {
        let (saved, _) = store.upsert(account).unwrap();
        ids.push(saved.id);
    }

    let mut config = Config {
        api_key: KEY.into(),
        strategy: Strategy::FillFirst,
        refresh_tokens: false,
        ..Config::default()
    };
    configure(&mut config);
    let (xai, openai) = (
        format!("{upstream_url}/xai"),
        format!("{upstream_url}/openai"),
    );
    let origins = Origins::new([
        ("https://api.anthropic.com", upstream_url.as_str()),
        ("https://chatgpt.com/backend-api", upstream_url.as_str()),
        ("https://api.x.ai", xai.as_str()),
        ("https://api.openai.com", openai.as_str()),
    ]);
    let app = App::new(config, Home::at(&dir), PoolState::default(), origins);
    app.pool.sync(app.store.list().unwrap());
    let proxy = serve({
        let app = app.clone();
        move |request| proxy::handle(app.clone(), request)
    })
    .await;
    Harness {
        proxy,
        dir: dir.clone(),
        app,
        log,
        ids,
        _dir: TempDir(dir),
    }
}

fn client() -> Client {
    Client::builder().build()
}

const CLAUDE_BODY: &str = r#"{"model":"claude-opus-5-5","metadata":{"user_id":"{\"device_id\":\"client-device\",\"account_uuid\":\"\",\"session_id\":\"sess-1\"}"},"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.287.95e; cc_entrypoint=cli;"},{"type":"text","text":"You are Claude Code."}],"messages":[{"role":"user","content":"hi"}],"max_tokens":100,"stream":true}"#;

fn claude_request(h: &Harness) -> RequestBuilder {
    client()
        .post(format!("{}/v1/messages?beta=true", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header(
            "anthropic-beta",
            "claude-code-20250219,interleaved-thinking-2025-05-14",
        )
        .header("x-claude-code-session-id", "sess-1")
        .header("user-agent", "claude-cli/2.1.287 (external, cli)")
        .header("accept-encoding", "gzip, br")
        .header("content-type", "application/json")
        .body(CLAUDE_BODY)
}

fn codex_request(h: &Harness) -> RequestBuilder {
    client()
        .post(format!("{}/codex/responses", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("content-type", "application/json")
        .body(r#"{"model":"gpt-6-sol","input":[],"stream":true}"#)
}

/// Records a weekly window at `used` percent and two banked reset credits.
fn observe_usage(h: &Harness, id: &str, used: f64) {
    let now = Timestamp::now();
    let window = Window {
        span: "7d".into(),
        model: None,
        used,
        resets_at: Some(now + SignedDuration::from_hours(72)),
    };
    let limits = Limits {
        windows: vec![window],
        observed_at: Some(now),
        reset_credits: Some(2),
    };
    h.app.pool.observe(id, limits, now);
}

fn paths(h: &Harness) -> Vec<String> {
    h.log
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.path.clone())
        .collect()
}

async fn eventually(check: impl Fn() -> bool) {
    for _ in 0..50 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition not met");
}

#[tokio::test]
async fn claude_fails_over_and_forwards_the_request_unchanged() {
    let h = harness(ProviderId::Claude, &["tok-limited", "tok-ok"]).await;
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let text = response.text().await.unwrap();
    assert!(
        text.contains("message_delta"),
        "stream passed through: {text}"
    );

    let seen = h.log.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "limited account, then the next one");
    let served = &seen[1];
    assert_eq!(served.path, "/v1/messages?beta=true");
    // Only the credential changes: the account's token and the OAuth beta
    // flag it requires. Everything else arrives as Claude Code sent it.
    assert_eq!(served.headers["authorization"], "Bearer tok-ok");
    assert_eq!(
        served.headers["anthropic-beta"],
        "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20"
    );
    assert_eq!(
        served.headers["user-agent"],
        "claude-cli/2.1.287 (external, cli)"
    );
    assert_eq!(served.headers["accept-encoding"], "gzip, br");
    assert_eq!(served.headers["x-claude-code-session-id"], "sess-1");
    assert!(!served.headers.contains_key("x-client-request-id"));
    assert_eq!(served.body, CLAUDE_BODY.as_bytes(), "body is byte-for-byte");

    // The limited account is blocked until its reset; the other is in use.
    let limited = h.app.pool.state(&h.ids[0]);
    let until = limited.blocked_until.expect("blocked");
    assert!(until > Timestamp::now() + SignedDuration::from_mins(59));
    eventually(|| h.app.pool.state(&h.ids[1]).usage.requests == 1).await;
    let usage = h.app.pool.state(&h.ids[1]).usage;
    assert_eq!(
        (
            usage.input_tokens,
            usage.cache_read_tokens,
            usage.output_tokens
        ),
        (10, 90, 25)
    );
    let served_limits = h.app.pool.state(&h.ids[1]).limits;
    assert_eq!(served_limits.windows[0].used, 25.0);

    // The answered request is in the usage ledger.
    let since = Timestamp::now() - SignedDuration::from_mins(1);
    let mut entries = Vec::new();
    for _ in 0..50 {
        entries = ledger::read(&h.dir.join("usage"), since);
        if !entries.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.account, h.ids[1]);
    assert_eq!(entry.model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!((entry.input, entry.output, entry.cache_read), (10, 25, 90));
    assert_eq!(entry.attempts, 2);
    assert!(entry.first_byte_ms.is_some());
    assert_eq!(entry.agent.as_deref(), Some("claude"));
    assert_eq!(entry.session.as_deref(), Some("sess-1"));

    // The session is now pinned to the serving account; no retry on the
    // limited one.
    claude_request(&h)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let seen = h.log.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[2].headers["authorization"], "Bearer tok-ok");
}

#[tokio::test]
async fn every_account_spent_returns_the_agents_own_limit_error() {
    let h = harness(ProviderId::Claude, &["tok-limited", "tok-limited"]).await;
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 429);
    let retry_after: i64 = response.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((3500..=3600).contains(&retry_after), "{retry_after}");
    assert_eq!(
        response.headers()["anthropic-ratelimit-unified-status"],
        "rejected"
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["type"], "rate_limit_error");

    // Both are known to be blocked now, so the next request is answered
    // without touching the provider.
    let before = h.log.lock().unwrap().len();
    assert_eq!(claude_request(&h).send().await.unwrap().status(), 429);
    assert_eq!(h.log.lock().unwrap().len(), before);

    // The ledger counts both as failures: the first after trying both
    // accounts, the second without trying any.
    let mut entries = Vec::new();
    for _ in 0..50 {
        entries = ledger::read(&h.dir.join("usage"), Timestamp::UNIX_EPOCH);
        if entries.len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|e| e.status == 429 && e.tokens() == 0));
    assert!(entries.iter().all(|e| e.failed() && !e.answered()));
    assert_eq!(entries[0].attempts, 2);
    assert!(h.ids.contains(&entries[0].account));
    assert_eq!(entries[0].agent.as_deref(), Some("claude"));
    assert_eq!((entries[1].attempts, entries[1].account.as_str()), (0, ""));
}

#[tokio::test]
async fn codex_fails_over_with_workspace_and_version_headers() {
    let h = harness(ProviderId::Codex, &["tok-limited", "tok-ok"]).await;
    let response = client()
        .post(format!("{}/codex/responses", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("session-id", "codex-session")
        .header("user-agent", "codex_exec/0.159.3 (Linux; x86_64) unknown (codex_exec; 0.159.3)")
        .header("content-type", "application/json")
        .body(r#"{"model":"gpt-6-sol","input":[],"stream":true,"store":false,"prompt_cache_key":"codex-session"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.text().await.unwrap();

    let seen = h.log.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].path, "/codex/responses");
    assert_eq!(seen[1].headers["authorization"], "Bearer tok-ok");
    assert_eq!(seen[1].headers["chatgpt-account-id"], "acct-codex1");
    assert_eq!(seen[1].headers["version"], "0.159.3");
    assert_eq!(seen[1].headers["session-id"], "codex-session");

    let blocked = h.app.pool.state(&h.ids[0]).blocked_until.expect("blocked");
    assert!(blocked > Timestamp::now() + SignedDuration::from_mins(89));
    eventually(|| h.app.pool.state(&h.ids[1]).usage.requests == 1).await;
    let usage = h.app.pool.state(&h.ids[1]).usage;
    assert_eq!(
        (
            usage.input_tokens,
            usage.cache_read_tokens,
            usage.output_tokens
        ),
        (40, 60, 7)
    );
    assert_eq!(h.app.pool.state(&h.ids[1]).limits.windows[0].span, "7d");
}

#[tokio::test]
async fn codex_exhaustion_uses_usage_limit_shape() {
    let h = harness(ProviderId::Codex, &["tok-limited"]).await;
    let response = client()
        .post(format!("{}/v1/responses", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .body(r#"{"model":"gpt-6-sol","input":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["type"], "usage_limit_reached");
    assert!(body["error"]["resets_at"].as_i64().unwrap() > Timestamp::now().as_second());
}

#[tokio::test]
async fn rejects_requests_without_the_slopmax_key() {
    let h = harness(ProviderId::Claude, &["tok-ok"]).await;
    let response = client()
        .post(format!("{}/v1/messages", h.proxy))
        .header("x-api-key", "wrong")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert!(h.log.lock().unwrap().is_empty());

    // Health and Claude Code's connectivity check need no key.
    let client = client();
    assert_eq!(
        client
            .get(format!("{}/healthz", h.proxy))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .request(Method::HEAD, format!("{}/api/hello", h.proxy))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}

#[tokio::test]
async fn revoked_tokens_move_to_the_next_account() {
    let h = harness(ProviderId::Claude, &["tok-revoked", "tok-ok"]).await;
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let seen = h.log.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].headers["authorization"], "Bearer tok-ok");
    assert!(h.app.pool.state(&h.ids[0]).blocked_until.is_some());
}

#[tokio::test]
async fn spent_codex_pool_redeems_a_credit_when_allowed() {
    let h = harness_with(ProviderId::Codex, &["tok-credit"], |config| {
        config.redeem_when_exhausted = true;
    })
    .await;
    observe_usage(&h, &h.ids[0], 90.0);
    let response = codex_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 200);
    response.text().await.unwrap();

    assert_eq!(
        paths(&h),
        [
            "/codex/responses",
            "/wham/rate-limit-reset-credits/consume",
            "/codex/responses"
        ]
    );
    let consume = h.log.lock().unwrap()[1].clone();
    assert_eq!(consume.headers["authorization"], "Bearer tok-credit");
    assert_eq!(consume.headers["chatgpt-account-id"], "acct-codex0");
    let body: Value = serde_json::from_slice(&consume.body).unwrap();
    assert!(body["redeem_request_id"].is_string());

    let state = h.app.pool.state(&h.ids[0]);
    assert_eq!(state.blocked_until, None);
    assert_eq!(state.limits.reset_credits, Some(1));
}

#[tokio::test]
async fn spent_codex_pool_keeps_its_credits_by_default() {
    let h = harness(ProviderId::Codex, &["tok-credit"]).await;
    observe_usage(&h, &h.ids[0], 90.0);
    let response = codex_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 429);
    assert_eq!(paths(&h), ["/codex/responses"]);
    assert_eq!(h.app.pool.state(&h.ids[0]).limits.reset_credits, Some(2));
}

#[tokio::test]
async fn credits_about_to_expire_are_redeemed_on_used_accounts() {
    let h = harness(
        ProviderId::Codex,
        &["tok-expiring", "tok-later", "tok-idle"],
    )
    .await;
    for (id, used) in h.ids.iter().zip([30.0, 30.0, 0.0]) {
        observe_usage(&h, id, used);
    }
    slopmax_core::daemon::redeem_expiring(&h.app).await;

    let seen = h.log.lock().unwrap().clone();
    let token = |s: &Seen| s.headers["authorization"].to_str().unwrap().to_owned();
    let mut listed: Vec<String> = seen
        .iter()
        .filter(|s| s.path == "/wham/rate-limit-reset-credits")
        .map(token)
        .collect();
    listed.sort();
    assert_eq!(
        listed,
        ["Bearer tok-expiring", "Bearer tok-later"],
        "an account with nothing to reset is left alone"
    );
    let consumed: Vec<&Seen> = seen
        .iter()
        .filter(|s| s.path.ends_with("/consume"))
        .collect();
    assert_eq!(consumed.len(), 1);
    assert_eq!(token(consumed[0]), "Bearer tok-expiring");
    let body: Value = serde_json::from_slice(&consumed[0].body).unwrap();
    assert_eq!(body["credit_id"], "credit-soon");

    let reset = h.app.pool.state(&h.ids[0]).limits;
    assert_eq!(reset.reset_credits, Some(1));
    assert_eq!(reset.windows[0].used, 0.0);
    assert_eq!(h.app.pool.state(&h.ids[1]).limits.reset_credits, Some(2));
}

#[tokio::test]
async fn claude_limit_resets_are_listed_and_spent_as_claude_code() {
    const ORG: &str = "0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4";
    const AGENT: &str = "claude-cli/2.1.287 (external, cli)";
    let h = harness_of(
        |_| {
            let mut account = account(ProviderId::Claude, "claude0", "tok-ok", 1000);
            account.org_id = Some(ORG.into());
            account.assign_id();
            vec![account]
        },
        |_| {},
    )
    .await;
    let listings = |h: &Harness| -> Vec<Seen> {
        h.log
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.path.starts_with("/api/oauth/usage"))
            .cloned()
            .collect()
    };

    // Claude answers Claude Code alone, so nothing is asked before slopmax
    // has seen it.
    slopmax_core::daemon::list_credits(&h.app, false).await;
    assert!(listings(&h).is_empty());
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(h.app.pool.agent(ProviderId::Claude).as_deref(), Some(AGENT));
    let (saved, _) = h.app.pool.snapshot(Timestamp::now());
    assert_eq!(saved.agents[&ProviderId::Claude], AGENT);

    // Listed with the usage, as Claude Code lists them: the next grant first.
    slopmax_core::daemon::list_credits(&h.app, false).await;
    let listed = listings(&h);
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].path,
        "/api/oauth/usage?cedar_ember=1&skip_spend=1"
    );
    assert_eq!(listed[0].headers["user-agent"], AGENT);
    assert_eq!(listed[0].headers["anthropic-beta"], "oauth-2025-04-20");
    let now = Timestamp::now();
    let state = h.app.pool.state(&h.ids[0]);
    let credits: Vec<&Credit> = state.unexpired_credits(now).collect();
    let ids: Vec<&str> = credits.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["launch", "older"]);
    assert_eq!(
        credits[0].title.as_deref(),
        Some("Model launch: one usage-limit reset")
    );
    // Not again within the hour.
    slopmax_core::daemon::list_credits(&h.app, false).await;
    assert_eq!(listings(&h).len(), 1);

    // Redeeming without naming one spends the grant Claude names next.
    let reply: Value = client()
        .post(format!("{}/slopmax/accounts/{}/redeem", h.proxy, h.ids[0]))
        .header("authorization", format!("Bearer {KEY}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "reset");
    let claim = h.log.lock().unwrap().last().cloned().unwrap();
    assert_eq!(
        claim.path,
        format!("/api/organizations/{ORG}/reset_rate_limits")
    );
    assert_eq!(claim.headers["user-agent"], AGENT);
    assert_eq!(claim.headers["authorization"], "Bearer tok-ok");
    let body: Value = serde_json::from_slice(&claim.body).unwrap();
    assert_eq!(body["program"], "cedar_ember");
    assert_eq!(body["grant_id"], "launch");
    assert!(body["request_id"].is_string());
    let left: Vec<String> = h
        .app
        .pool
        .state(&h.ids[0])
        .unexpired_credits(Timestamp::now())
        .map(|c| c.id.clone())
        .collect();
    assert_eq!(left, ["older"]);
}

#[tokio::test]
async fn credits_are_listed_kept_and_redeemed_soonest_first() {
    let h = harness(ProviderId::Codex, &["tok-expiring", "tok-ok"]).await;
    observe_usage(&h, &h.ids[0], 30.0);
    let listings = |h: &Harness| {
        paths(h)
            .iter()
            .filter(|p| *p == "/wham/rate-limit-reset-credits")
            .count()
    };

    // Each credit with its dates, soonest to expire first; an account
    // whose usage counts none is not asked.
    slopmax_core::daemon::list_credits(&h.app, false).await;
    assert_eq!(listings(&h), 1);
    let now = Timestamp::now();
    let state = h.app.pool.state(&h.ids[0]);
    let listed: Vec<&Credit> = state.unexpired_credits(now).collect();
    assert_eq!(listed[0].id, "credit-soon");
    assert_eq!(listed[1].id, "credit-later");
    assert!(listed[0].granted_at.is_some_and(|at| at < now));
    // Not again until the list is due.
    slopmax_core::daemon::list_credits(&h.app, false).await;
    assert_eq!(listings(&h), 1);

    // Redeeming without naming a credit spends the soonest to expire.
    let reply: Value = client()
        .post(format!("{}/slopmax/accounts/{}/redeem", h.proxy, h.ids[0]))
        .header("authorization", format!("Bearer {KEY}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "reset");
    let sent = h.log.lock().unwrap().last().cloned().unwrap();
    let sent: Value = serde_json::from_slice(&sent.body).unwrap();
    assert_eq!(sent["credit_id"], "credit-soon");
    let account = reply["report"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == h.ids[0].as_str())
        .unwrap()
        .clone();
    let left = account["state"]["credits"]["credits"].as_array().unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0]["id"], "credit-later");
}

#[tokio::test]
async fn websockets_off_or_for_other_models_send_codex_to_http() {
    let h = harness_with(ProviderId::Codex, &["tok-ok"], |config| {
        config.websockets = false
    })
    .await;
    let (status, _) = open_socket(&h, "gpt-6-sol").await;
    assert_eq!(status, 426);
    assert!(h.log.lock().unwrap().is_empty());

    let h = harness_of(|_| vec![key(ProviderId::Xai, "key-xai")], |_| {}).await;
    let (status, _) = open_socket(&h, "grok-4").await;
    assert_eq!(status, 426, "translated models stream over HTTP");
}

/// A WebSocket handshake to the proxy, as Codex sends it. Returns the
/// status and, after a 101, the socket.
async fn open_socket(
    h: &Harness,
    model: &str,
) -> (
    u16,
    Option<(
        ws::Reader<tokio::io::BufReader<tokio::io::ReadHalf<tokio::net::TcpStream>>>,
        ws::Writer<tokio::io::WriteHalf<tokio::net::TcpStream>>,
    )>,
) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    let address = h.proxy.strip_prefix("http://").unwrap();
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let handshake = format!(
        "GET /codex/responses HTTP/1.1\r\nhost: {address}\r\nupgrade: websocket\r\n\
         connection: Upgrade\r\nsec-websocket-version: 13\r\n\
         sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nauthorization: Bearer {KEY}\r\n\
         user-agent: codex_exec/0.159.3 (Linux; x86_64)\r\nsession-id: ws-session\r\n\
         x-codex-routing-hint: model={model}\r\n\r\n"
    );
    stream.write_all(handshake.as_bytes()).await.unwrap();
    let (read, write) = tokio::io::split(stream);
    let mut read = tokio::io::BufReader::new(read);
    let mut status_line = String::new();
    read.read_line(&mut status_line).await.unwrap();
    let status: u16 = status_line.split(' ').nth(1).unwrap().parse().unwrap();
    let mut accept = None;
    loop {
        let mut line = String::new();
        read.read_line(&mut line).await.unwrap();
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line
            .to_ascii_lowercase()
            .strip_prefix("sec-websocket-accept:")
        {
            accept = Some(value.trim().to_owned());
        }
    }
    if status != 101 {
        return (status, None);
    }
    assert_eq!(
        accept.as_deref(),
        Some(
            ws::accept_key("dGhlIHNhbXBsZSBub25jZQ==")
                .to_ascii_lowercase()
                .as_str()
        )
    );
    (
        status,
        Some((ws::Reader::new(read), ws::Writer::client(write))),
    )
}

#[tokio::test]
async fn codex_websockets_are_relayed_to_chatgpt() {
    let h = harness(ProviderId::Codex, &["tok-ok"]).await;
    let (status, socket) = open_socket(&h, "gpt-6-sol").await;
    assert_eq!(status, 101);
    let (mut reader, mut writer) = socket.unwrap();
    let create =
        json!({"type": "response.create", "model": "gpt-6-sol", "input": [], "stream": true});
    writer
        .send(&ws::Message::Text(create.to_string()))
        .await
        .unwrap();
    let mut types = Vec::new();
    while let Some(ws::Message::Text(text)) = reader.message().await.unwrap() {
        let event: Value = serde_json::from_str(&text).unwrap();
        types.push(event["type"].as_str().unwrap().to_owned());
        if event["type"] == "response.completed" {
            break;
        }
    }
    assert_eq!(
        types,
        [
            "response.created",
            "codex.rate_limits",
            "response.output_text.delta",
            "response.completed"
        ]
    );
    let upstream = h.log.lock().unwrap()[0].clone();
    assert_eq!(upstream.path, "ws /codex/responses");
    assert_eq!(upstream.headers["authorization"], "Bearer tok-ok");
    assert_eq!(
        upstream.headers["openai-beta"],
        "responses_websockets=2026-02-06"
    );
    assert_eq!(upstream.headers["chatgpt-account-id"], "acct-codex0");
    assert_ne!(
        upstream.headers["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==",
        "the upstream handshake has its own key"
    );
    // The rate-limit event updated the account's windows, and the turn
    // reached the ledger.
    let id = h.ids[0].clone();
    eventually(|| {
        ledger::read(&h.dir.join("usage"), Timestamp::UNIX_EPOCH)
            .iter()
            .any(|e| e.account == id && e.input == 30 && e.cache_read == 20 && e.output == 4)
    })
    .await;
    let state = h.app.pool.state(&h.ids[0]);
    assert_eq!(state.limits.windows[0].used, 33.0);
}

#[tokio::test]
async fn a_stop_closes_open_sockets_and_records_the_turn_it_cut() {
    let h = harness(ProviderId::Codex, &["tok-slow"]).await;
    let (_, socket) = open_socket(&h, "gpt-6-sol").await;
    let (mut reader, mut writer) = socket.unwrap();
    let create = json!({"type": "response.create", "model": "gpt-6-sol", "input": []});
    writer
        .send(&ws::Message::Text(create.to_string()))
        .await
        .unwrap();
    let Some(ws::Message::Text(created)) = reader.message().await.unwrap() else {
        panic!("the answer started");
    };
    assert!(created.contains("response.created"));
    h.app.stop.cancel();
    let closed = tokio::time::timeout(Duration::from_secs(5), reader.message())
        .await
        .expect("closed at once")
        .unwrap();
    assert_eq!(
        closed,
        Some(ws::Message::Close(Some((
            1001,
            "slopmax is stopping".into()
        ))))
    );
    // Recorded just after the close went out.
    let usage = h.dir.join("usage");
    eventually(|| !ledger::read(&usage, Timestamp::UNIX_EPOCH).is_empty()).await;
    let entries = ledger::read(&usage, Timestamp::UNIX_EPOCH);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].end, Some(ledger::End::Cut));
    assert_eq!(entries[0].model.as_deref(), Some("gpt-6-sol"));
    assert!(entries[0].failed());
}

#[tokio::test]
async fn spent_accounts_close_the_socket_so_codex_reconnects_elsewhere() {
    let h = harness(ProviderId::Codex, &["tok-limited", "tok-ok"]).await;
    let create =
        json!({"type": "response.create", "model": "gpt-6-sol", "input": [], "stream": true})
            .to_string();

    let (_, socket) = open_socket(&h, "gpt-6-sol").await;
    let (mut reader, mut writer) = socket.unwrap();
    writer
        .send(&ws::Message::Text(create.clone()))
        .await
        .unwrap();
    let mut closed = None;
    while let Some(message) = reader.message().await.unwrap() {
        if let ws::Message::Close(close) = message {
            closed = close;
            break;
        }
    }
    assert_eq!(closed.map(|(code, _)| code), Some(1012));
    assert!(h.app.pool.state(&h.ids[0]).is_blocked(Timestamp::now()));

    // Codex's retry opens a new socket, which lands on the other account.
    let (_, socket) = open_socket(&h, "gpt-6-sol").await;
    let (mut reader, mut writer) = socket.unwrap();
    writer.send(&ws::Message::Text(create)).await.unwrap();
    let mut completed = false;
    while let Some(ws::Message::Text(text)) = reader.message().await.unwrap() {
        if text.contains("response.completed") {
            completed = true;
            break;
        }
    }
    assert!(completed);
    let tokens: Vec<String> = h
        .log
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.path.starts_with("ws /"))
        .map(|s| s.headers["authorization"].to_str().unwrap().to_owned())
        .collect();
    assert_eq!(tokens, ["Bearer tok-limited", "Bearer tok-ok"]);
}

#[tokio::test]
async fn fast_mode_refusals_reach_claude_code_without_benching_accounts() {
    let h = harness(ProviderId::Claude, &["tok-fast", "tok-ok"]).await;
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 429);
    let body: Value = response.json().await.unwrap();
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("fast mode")
    );
    assert_eq!(h.log.lock().unwrap().len(), 1, "no other account is tried");
    let state = h.app.pool.state(&h.ids[0]);
    assert_eq!(state.blocked_until, None);
    assert_eq!(state.throttled_until, None);
}

#[tokio::test]
async fn codex_streams_that_open_spent_move_to_the_next_account() {
    let h = harness(ProviderId::Codex, &["tok-quiet", "tok-ok"]).await;
    let response = codex_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let text = response.text().await.unwrap();
    assert!(
        text.contains("response.completed"),
        "served by the next account: {text}"
    );
    assert!(
        !text.contains("usage_limit_reached"),
        "the agent never saw the refusal"
    );
    assert!(h.app.pool.state(&h.ids[0]).blocked_until.is_some());

    // With every account spent that way, Codex gets its own usage-limit error.
    let h = harness(ProviderId::Codex, &["tok-quiet"]).await;
    let response = codex_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 429);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["type"], "usage_limit_reached");
}

#[tokio::test]
async fn claude_accounts_serve_claude_code_only() {
    let h = harness(ProviderId::Claude, &["tok-ok"]).await;
    let response = client()
        .post(format!("{}/v1/messages", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("user-agent", "OpenAI/Python 2.4.0")
        .header("content-type", "application/json")
        .body(CLAUDE_BODY)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let body: Value = response.json().await.unwrap();
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.contains("Claude Code only"), "{message}");
    assert!(message.contains("OpenAI/Python"), "{message}");
    assert!(
        h.log.lock().unwrap().is_empty(),
        "nothing reached Anthropic"
    );
}

/// An API-key account.
fn key(provider: ProviderId, key: &str) -> Account {
    Account::new(
        provider,
        Tokens {
            access_token: key.into(),
            ..Tokens::default()
        },
    )
}

/// A compatible endpoint under the mock at `base/<name>`.
fn endpoint(base: &str, name: &str, dialect: Dialect, models: &[&str], api_key: &str) -> Account {
    let mut account = key(ProviderId::Compat, api_key);
    account.endpoint = Some(Endpoint {
        base_url: match dialect {
            Dialect::Messages => format!("{base}/{name}"),
            _ => format!("{base}/{name}/v1"),
        },
        dialect,
        models: models.iter().map(|m| m.to_string()).collect(),
    });
    account.assign_id();
    account
}

fn chat_request(h: &Harness, model: &str) -> RequestBuilder {
    client()
        .post(format!("{}/v1/chat/completions", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("user-agent", "OpenAI/Python 2.4.0")
        .header("content-type", "application/json")
        .body(format!(
            r#"{{"model":"{model}","messages":[{{"role":"user","content":"hi"}}]}}"#
        ))
}

#[tokio::test]
async fn chat_clients_reach_keys_and_endpoints_by_model() {
    let h = harness_of(
        |base| {
            vec![
                account(ProviderId::Codex, "chatgpt", "tok-ok", 1000),
                key(ProviderId::Xai, "key-xai"),
                endpoint(base, "local", Dialect::Chat, &["qwen3-*"], ""),
            ]
        },
        |_| {},
    )
    .await;

    let response = chat_request(&h, "grok-4").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let seen = h.log.lock().unwrap().last().cloned().unwrap();
    assert_eq!(seen.path, "/xai/v1/chat/completions");
    assert_eq!(seen.headers["authorization"], "Bearer key-xai");
    assert_eq!(seen.headers["user-agent"], "OpenAI/Python 2.4.0");
    assert!(
        std::str::from_utf8(&seen.body)
            .unwrap()
            .contains(r#""model":"grok-4""#)
    );

    let response = chat_request(&h, "qwen3-coder").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let seen = h.log.lock().unwrap().last().cloned().unwrap();
    assert_eq!(seen.path, "/local/v1/chat/completions");
    assert!(
        !seen.headers.contains_key("authorization"),
        "no key, no credential"
    );

    // ChatGPT accounts speak Responses, so a Chat request for a GPT model
    // is translated for them, and the answer back.
    let response = chat_request(&h, "gpt-6-sol").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let seen = h.log.lock().unwrap().last().cloned().unwrap();
    assert_eq!(seen.path, "/codex/responses");
    let sent: Value = serde_json::from_slice(&seen.body).unwrap();
    assert_eq!(sent["input"][0]["content"][0]["text"], "hi");
    assert_eq!(sent["store"], false);
    let agent = seen.headers["user-agent"].to_str().unwrap();
    assert!(agent.starts_with("slopmax/"), "{agent}");
    assert_eq!(seen.headers["authorization"], "Bearer tok-ok");
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["object"], "chat.completion");
    assert_eq!(body["model"], "gpt-6-sol");
    assert_eq!(body["usage"]["prompt_tokens"], 100);

    let response = chat_request(&h, "nope").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = response.json().await.unwrap();
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.contains("nope"), "{message}");

    let xai = h.ids[1].clone();
    eventually(|| {
        ledger::read(&h.dir.join("usage"), Timestamp::UNIX_EPOCH)
            .iter()
            .any(|e| e.account == xai && e.input == 12 && e.output == 3)
    })
    .await;
}

#[tokio::test]
async fn keys_serve_subscription_models_only_as_paid_overflow() {
    let accounts = |_: &str| {
        vec![
            account(ProviderId::Codex, "chatgpt", "tok-limited", 1000),
            key(ProviderId::OpenAI, "key-openai"),
        ]
    };
    let h = harness_of(accounts, |_| {}).await;
    let response = codex_request(&h).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(paths(&h).iter().all(|p| !p.starts_with("/openai/")));

    // Asking for the key by name opts in for one request.
    let response = client()
        .post(format!("{}/codex/responses", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .body(r#"{"model":"openai/gpt-6-sol","input":[],"stream":true}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let seen = h.log.lock().unwrap().last().cloned().unwrap();
    assert_eq!(seen.path, "/openai/v1/responses");
    assert_eq!(seen.headers["authorization"], "Bearer key-openai");
    assert_eq!(
        std::str::from_utf8(&seen.body).unwrap(),
        r#"{"model":"gpt-6-sol","input":[],"stream":true}"#
    );

    let h = harness_of(accounts, |config| config.paid_overflow = true).await;
    let response = codex_request(&h).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(paths(&h), ["/codex/responses", "/openai/v1/responses"]);
}

#[tokio::test]
async fn claude_code_may_use_other_vendors_messages_endpoints() {
    let h = harness_of(
        |base| {
            vec![
                account(ProviderId::Claude, "max", "tok-ok", 1000),
                endpoint(base, "kimi", Dialect::Messages, &["kimi-*"], "key-kimi"),
            ]
        },
        |_| {},
    )
    .await;
    let response = claude_request(&h)
        .body(CLAUDE_BODY.replace("claude-opus-5-5", "kimi-k2"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let seen = h.log.lock().unwrap().last().cloned().unwrap();
    assert_eq!(seen.path, "/kimi/v1/messages?beta=true");
    assert_eq!(seen.headers["x-api-key"], "key-kimi");
    assert!(!seen.headers.contains_key("authorization"));
    // Claude models still go to the Claude account.
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(paths(&h).last().unwrap(), "/v1/messages?beta=true");
}

#[tokio::test]
async fn claude_code_runs_gpt_models_on_chatgpt_accounts() {
    let h = harness_of(
        |_| {
            vec![
                account(ProviderId::Claude, "max", "tok-ok", 1000),
                account(ProviderId::Codex, "chatgpt", "tok-talk", 1001),
            ]
        },
        |_| {},
    )
    .await;
    let turn = |messages: &str| {
        let body = format!(
            r#"{{"model":"gpt-6-sol","max_tokens":1000,"stream":true,"system":"You are Claude Code.","messages":{messages},"tools":[{{"name":"Bash","description":"Run","input_schema":{{"type":"object"}}}}]}}"#
        );
        claude_request(&h).body(body)
    };
    let response = turn(r#"[{"role":"user","content":"list files"}]"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let stream = response.text().await.unwrap();
    for expected in [
        r#""model":"gpt-6-sol""#,
        r#""text":"Hello""#,
        r#""type":"tool_use","id":"call_1","name":"Bash""#,
        r#""partial_json":"{\"command\":\"ls\"}""#,
        r#""stop_reason":"tool_use""#,
        "message_stop",
    ] {
        assert!(stream.contains(expected), "missing {expected} in {stream}");
    }
    assert!(
        !stream.contains("enc-1"),
        "opaque reasoning stays with slopmax"
    );
    let seen = h.log.lock().unwrap().last().cloned().unwrap();
    assert_eq!(seen.path, "/codex/responses");
    let sent: Value = serde_json::from_slice(&seen.body).unwrap();
    assert_eq!(sent["instructions"], "You are Claude Code.");
    // The Claude Code session keys ChatGPT's prompt cache.
    assert_eq!(sent["prompt_cache_key"], "sess-1");

    // The next turn carries the call's result; the reasoning that led to
    // the call goes back to the account that issued it.
    let response = turn(
        r#"[{"role":"user","content":"list files"},
            {"role":"assistant","content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"call_1","name":"Bash","input":{"command":"ls"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"a.rs"}]}]"#,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let seen = h.log.lock().unwrap().last().cloned().unwrap();
    let sent: Value = serde_json::from_slice(&seen.body).unwrap();
    let types: Vec<&str> = sent["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        [
            "message",
            "message",
            "reasoning",
            "function_call",
            "function_call_output"
        ]
    );
    assert_eq!(sent["input"][2]["encrypted_content"], "enc-1");
    assert_eq!(sent["input"][4]["output"], "a.rs");

    // Usage lands in the ledger under the ChatGPT account and GPT model.
    let codex = h.ids[1].clone();
    eventually(|| {
        ledger::read(&h.dir.join("usage"), Timestamp::UNIX_EPOCH)
            .iter()
            .any(|e| e.account == codex && e.model.as_deref() == Some("gpt-6-sol") && e.input == 20)
    })
    .await;

    // Claude's own models still go to the Claude account, untranslated.
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(paths(&h).last().unwrap(), "/v1/messages?beta=true");
}

#[tokio::test]
async fn translated_failures_reach_the_client_in_its_format() {
    let h = harness_of(
        |_| vec![account(ProviderId::Codex, "chatgpt", "tok-limited", 1000)],
        |_| {},
    )
    .await;
    // Every ChatGPT account is spent: Claude Code hears its own limit error.
    let body = CLAUDE_BODY.replace("claude-opus-5-5", "gpt-6-sol");
    let response = claude_request(&h).body(body).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response.headers()["anthropic-ratelimit-unified-status"],
        "rejected"
    );
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["type"], "error");
    assert_eq!(error["error"]["type"], "rate_limit_error");

    // Counting tokens for a GPT model is estimated locally.
    let response = client()
        .post(format!("{}/v1/messages/count_tokens", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("user-agent", "claude-cli/2.1.287 (external, cli)")
        .body(r#"{"model":"gpt-6-sol","messages":[{"role":"user","content":"hello there"}]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let count: Value = response.json().await.unwrap();
    assert!(count["input_tokens"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn openai_clients_list_every_model_they_can_use() {
    let h = harness_of(
        |base| {
            vec![
                account(ProviderId::Claude, "max", "tok-ok", 1000),
                account(ProviderId::Codex, "chatgpt", "tok-ok", 1001),
                key(ProviderId::Xai, "key-xai"),
                endpoint(base, "local", Dialect::Chat, &["qwen3-*", "llama4"], ""),
            ]
        },
        |config| {
            config
                .aliases
                .insert("fast".into(), "gpt-6-sol-mini".into());
        },
    )
    .await;
    let list = || {
        client()
            .get(format!("{}/v1/models", h.proxy))
            .header("authorization", format!("Bearer {KEY}"))
    };
    let response = list().send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    let ids: Vec<&str> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        ["fast", "gpt-6-sol", "grok-4", "grok-code-fast-1", "llama4"]
    );
    assert_eq!(body["data"][1]["owned_by"], "codex");
    assert!(
        paths(&h)
            .iter()
            .any(|p| p.starts_with("/codex/models?client_version="))
    );

    // Lists are reused for a while.
    let before = paths(&h).len();
    list().send().await.unwrap();
    assert_eq!(paths(&h).len(), before);

    // Claude Code still gets Anthropic's own list.
    client()
        .get(format!("{}/v1/models?limit=1000", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("anthropic-version", "2023-06-01")
        .header("user-agent", "claude-cli/2.1.287 (external, cli)")
        .send()
        .await
        .unwrap();
    assert_eq!(paths(&h).last().unwrap(), "/v1/models?limit=1000");
}

#[tokio::test]
async fn the_dashboard_api_reports_acts_and_streams() {
    use http_body_util::BodyExt;

    let h = harness(ProviderId::Codex, &["tok-ok", "tok-ok"]).await;
    let admin = |method: Method, path: &str| {
        client()
            .request(method, format!("{}{path}", h.proxy))
            .header("authorization", format!("Bearer {KEY}"))
    };

    // The page itself is public and inert; the data behind it is not.
    let page = client()
        .get(format!("{}/slopmax/", h.proxy))
        .header("accept-encoding", "gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert!(
        page.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .starts_with("default-src 'none'")
    );
    let anonymous = client()
        .get(format!("{}/slopmax/status", h.proxy))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);

    let account = |report: &Value, id: &str| {
        report["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == id)
            .cloned()
            .unwrap()
    };
    let (first, second) = (h.ids[0].clone(), h.ids[1].clone());
    let act =
        |id: &str, action: &str| admin(Method::POST, &format!("/slopmax/accounts/{id}/{action}"));
    let report: Value = act(&first, "disable")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(account(&report, &first)["disabled"], true);
    let report: Value = act(&first, "enable")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(account(&report, &first)["disabled"], false);
    let report: Value = act(&first, "priority?value=3")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(account(&report, &first)["priority"], 3);
    let report: Value = act(&second, "use")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(account(&report, &second)["pinned"], true);
    // Pins are the daemon's state, saved with the rest of it, not a file
    // of their own.
    assert!(!h.dir.join("pins.toml").exists());
    let report: Value = admin(Method::POST, "/slopmax/use/auto")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(account(&report, &second)["pinned"], false);
    let missing = act("codex-nope", "disable").send().await.unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let report: Value = act(&first, "label?value=work%20laptop")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(account(&report, &first)["name"], "work laptop");
    let report: Value = act(&first, "label?value=")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(account(&report, &first)["name"], "work laptop");

    // Removing an account takes its pin with it, as `slopmax remove` does.
    act(&second, "use").send().await.unwrap();
    let report: Value = act(&second, "remove")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let ids: Vec<&Value> = report["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| &a["id"])
        .collect();
    assert_eq!(ids, [&Value::from(first.clone())]);
    // Its pin went with it: pinning nothing else leaves nothing pinned.
    let report: Value = admin(Method::GET, "/slopmax/status")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        report["pools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["next"]["reason"] != "pinned"),
        "{report}"
    );

    // A change the CLI or app makes on disk shows as soon as the proxy syncs.
    Store::at(h.dir.join("accounts"))
        .update(&first, |a| a.priority = 7)
        .unwrap();
    let report: Value = admin(Method::POST, "/slopmax/sync")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(account(&report, &first)["priority"], 7);

    // The live feed sees each answered request.
    let feed = admin(Method::GET, "/slopmax/events").send().await.unwrap();
    assert_eq!(feed.headers()["content-type"], "text/event-stream");
    let mut feed = feed.into_body();
    let first_frame = feed.frame().await.unwrap().unwrap().into_data().unwrap();
    assert!(first_frame.starts_with(b": connected"));
    let response = codex_request(&h).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.bytes().await.unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let chunk = feed.frame().await.unwrap().unwrap().into_data().unwrap();
            if let Some(data) = chunk.strip_prefix(b"data: ") {
                break serde_json::from_slice::<Value>(data.trim_ascii()).unwrap();
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(event["model"], "gpt-6-sol");
    assert_eq!(event["input"], 40);

    eventually(|| ledger::read(&h.dir.join("usage"), Timestamp::UNIX_EPOCH).len() == 1).await;
    let usage: Value = admin(Method::GET, "/slopmax/usage?range=today&by=model")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(usage["rows"]["gpt-6-sol"]["requests"], 1);
    assert_eq!(usage["total"]["output"], 7);
}

#[tokio::test]
async fn client_keys_are_held_to_their_models() {
    use slopmax_core::config::ClientKey;

    let h = harness_with(ProviderId::Codex, &["tok-ok"], |config| {
        config.keys.push(ClientKey {
            name: "laptop".into(),
            key: "sm-laptop".into(),
            models: vec!["gpt-6-*".into()],
        });
        // An alias that leads outside what the key may use.
        config
            .aliases
            .insert("gpt-6-cheap".into(), "gpt-5-mini".into());
    })
    .await;
    let aliased = client()
        .post(format!("{}/codex/responses", h.proxy))
        .header("authorization", "Bearer sm-laptop")
        .body(r#"{"model":"gpt-6-cheap","input":[],"stream":true}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(
        aliased.status(),
        StatusCode::FORBIDDEN,
        "routed past the key"
    );
    let with = |model: &str| {
        client()
            .post(format!("{}/codex/responses", h.proxy))
            .header("authorization", "Bearer sm-laptop")
            .body(format!(r#"{{"model":"{model}","input":[],"stream":true}}"#))
    };
    assert_eq!(
        with("gpt-6-sol").send().await.unwrap().status(),
        StatusCode::OK
    );
    let refused = with("gpt-5-mini").send().await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let body: Value = refused.json().await.unwrap();
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("laptop")
    );
    // Naming the model twice can't slip another past the check.
    let twice = client()
        .post(format!("{}/codex/responses", h.proxy))
        .header("authorization", "Bearer sm-laptop")
        .body(r#"{"model":"gpt-6-sol","model":"gpt-5-mini","input":[],"stream":true}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(twice.status(), StatusCode::FORBIDDEN);
    // Listing the models is fine: it spends nothing.
    let listed = client()
        .get(format!("{}/codex/models?client_version=0.165.0", h.proxy))
        .header("authorization", "Bearer sm-laptop")
        .send()
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    // A body slopmax cannot read could name any model, so it is refused.
    let packed = client()
        .post(format!("{}/codex/responses", h.proxy))
        .header("authorization", "Bearer sm-laptop")
        .header("content-encoding", "zstd")
        .body("(compressed)")
        .send()
        .await
        .unwrap();
    assert_eq!(packed.status(), StatusCode::FORBIDDEN);
    // A socket would carry requests for any model: Codex is sent to HTTP,
    // where each is checked.
    let socket = client()
        .get(format!("{}/codex/responses", h.proxy))
        .header("authorization", "Bearer sm-laptop")
        .header("upgrade", "websocket")
        .header("connection", "Upgrade")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("x-codex-routing-hint", "model=gpt-6-sol")
        .send()
        .await
        .unwrap();
    assert_eq!(socket.status(), StatusCode::UPGRADE_REQUIRED);
    assert!(!paths(&h).iter().any(|p| p.starts_with("ws ")));
    // Client keys never reach slopmax's own API.
    let status = client()
        .get(format!("{}/slopmax/status", h.proxy))
        .header("authorization", "Bearer sm-laptop")
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn idle_chatgpt_windows_are_warmed_once() {
    let h = harness(ProviderId::Codex, &["tok-ok"]).await;
    // Warmups use the model Codex last asked for; there is none yet.
    slopmax_core::proxy::warm::idle_accounts(&h.app).await;
    assert!(paths(&h).is_empty());

    let response = codex_request(&h).send().await.unwrap();
    response.bytes().await.unwrap();
    let now = Timestamp::now();
    let reset = Window {
        span: "5h".into(),
        model: None,
        used: 64.0,
        resets_at: Some(now - SignedDuration::from_mins(1)),
    };
    let limits = Limits {
        windows: vec![reset],
        observed_at: Some(now),
        reset_credits: None,
    };
    h.app.pool.observe(&h.ids[0], limits, now);

    slopmax_core::proxy::warm::idle_accounts(&h.app).await;
    let warmups: Vec<Value> = h
        .log
        .lock()
        .unwrap()
        .iter()
        .skip(1)
        .map(|s| serde_json::from_slice(&s.body).unwrap())
        .collect();
    assert_eq!(warmups.len(), 1);
    assert_eq!(warmups[0]["model"], "gpt-6-sol");
    assert_eq!(warmups[0]["instructions"], "Reply with OK.");
    // Once per window.
    slopmax_core::proxy::warm::idle_accounts(&h.app).await;
    assert_eq!(paths(&h).len(), 2);
}

/// Records a reading for `id`: `used` percent of a `span` window.
fn observe(h: &Harness, id: &str, span: &str, used: f64) {
    let now = Timestamp::now();
    let limits = Limits {
        windows: vec![Window {
            span: span.into(),
            model: None,
            used,
            resets_at: Some(now + SignedDuration::from_hours(2)),
        }],
        observed_at: Some(now),
        reset_credits: None,
    };
    h.app.pool.observe(id, limits, now);
}

#[tokio::test]
async fn agents_see_the_pool_not_the_serving_account() {
    // Codex: the serving account reports 40% of its week; the other has
    // used 10%, so the pool has used 25%.
    let h = harness(ProviderId::Codex, &["tok-ok", "tok-ok"]).await;
    observe(&h, &h.ids[1], "7d", 10.0);
    let response = codex_request(&h).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-codex-primary-used-percent"], "25.0");
    assert_eq!(
        response.headers()["x-codex-primary-window-minutes"],
        "10080"
    );

    // Claude: 25% here and 75% on the other account read as 50%.
    let h = harness(ProviderId::Claude, &["tok-ok", "tok-ok"]).await;
    observe(&h, &h.ids[1], "5h", 75.0);
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers();
    assert_eq!(
        headers["anthropic-ratelimit-unified-5h-utilization"],
        "0.50"
    );
    assert_eq!(headers["anthropic-ratelimit-unified-status"], "allowed");
    assert!(!headers.contains_key("anthropic-ratelimit-unified-representative-claim"));
}

#[tokio::test]
async fn codex_sockets_report_the_pool_too() {
    let h = harness(ProviderId::Codex, &["tok-ok", "tok-ok"]).await;
    observe(&h, &h.ids[1], "5h", 0.0);
    let (_, socket) = open_socket(&h, "gpt-6-sol").await;
    let (mut reader, mut writer) = socket.unwrap();
    let create =
        json!({"type": "response.create", "model": "gpt-6-sol", "input": [], "stream": true});
    writer
        .send(&ws::Message::Text(create.to_string()))
        .await
        .unwrap();
    let mut seen = None;
    while let Some(ws::Message::Text(text)) = reader.message().await.unwrap() {
        let event: Value = serde_json::from_str(&text).unwrap();
        if event["type"] == "codex.rate_limits" {
            seen = Some(event);
        }
        if text.contains("response.completed") {
            break;
        }
    }
    // The serving account sent 33% of its 5-hour window; the other is idle.
    let event = seen.unwrap();
    assert_eq!(event["rate_limits"]["primary"]["used_percent"], 16.5);
    assert_eq!(event["rate_limits"]["primary"]["window_minutes"], 300);
    assert_eq!(event["rate_limits"]["limit_reached"], false);
}

/// One `api-call` as T3 Code sends it to a CLIProxyAPI hub: the status the
/// provider answered with, and its body.
async fn api_call(
    h: &Harness,
    auth_index: &str,
    method: &str,
    url: &str,
    data: Option<Value>,
) -> (u64, Value) {
    let mut call = json!({
        "auth_index": auth_index,
        "method": method,
        "url": url,
        "header": { "Authorization": "Bearer $TOKEN$" },
    });
    if let Some(data) = data {
        call["data"] = json!(data.to_string());
    }
    let response = client()
        .post(format!("{}/v0/management/api-call", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .json(&call)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let reply: Value = response.json().await.unwrap();
    let body = serde_json::from_str(reply["body"].as_str().unwrap()).unwrap();
    (reply["status_code"].as_u64().unwrap(), body)
}

#[tokio::test]
async fn hub_clients_read_usage_and_redeem_credits_without_a_relay() {
    const CLAUDE_USAGE: &str = "https://api.anthropic.com/api/oauth/usage";
    const CODEX_USAGE: &str = "https://chatgpt.com/backend-api/wham/usage";
    const CREDITS: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
    const CONSUME: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

    let h = harness_of(
        |_| {
            vec![
                account(ProviderId::Claude, "claude0", "tok-ok", 1000),
                account(ProviderId::Codex, "codex0", "tok-ok", 1001),
            ]
        },
        |_| {},
    )
    .await;
    let (claude, codex) = (h.ids[0].as_str(), h.ids[1].as_str());
    let management = |path: &str| {
        client()
            .request(Method::POST, format!("{}/v0/management/{path}", h.proxy))
            .header("authorization", format!("Bearer {KEY}"))
    };

    // The management key is slopmax's own, as a bearer token or in
    // CLIProxyAPI's header.
    let files = |name: &str, value: String| {
        client()
            .get(format!("{}/v0/management/auth-files", h.proxy))
            .header(name, value)
            .send()
    };
    let wrong = files("authorization", "Bearer wrong".into()).await.unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    let other = files("x-management-key", KEY.into()).await.unwrap();
    assert_eq!(other.status(), StatusCode::OK);
    let listed: Value = files("authorization", format!("Bearer {KEY}"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let file = |id: &str| {
        listed["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["auth_index"] == id)
            .cloned()
            .unwrap()
    };
    assert_eq!(file(claude)["provider"], "claude");
    assert_eq!(file(claude)["email"], "claude0@example.com");
    assert_eq!(file(codex)["provider"], "codex");
    assert_eq!(file(codex)["disabled"], false);
    assert_eq!(file(codex)["id_token"]["chatgpt_account_id"], "acct-codex0");
    // T3 rejects a null where it reads a string, so unknowns are left out.
    assert!(file(codex)["id_token"].get("chatgpt_plan_type").is_none());

    // Usage comes from slopmax's own readings, so there is none before one.
    let (status, _) = api_call(&h, claude, "GET", CLAUDE_USAGE, None).await;
    assert_eq!(status, 503);
    let now = Timestamp::now();
    let resets = now + SignedDuration::from_hours(2);
    let window = |span: &str, model: Option<&str>, used| Window {
        span: span.into(),
        model: model.map(Into::into),
        used,
        resets_at: Some(resets),
    };
    let limits = Limits {
        windows: vec![window("5h", None, 30.0), window("7d", Some("Fable"), 58.0)],
        observed_at: Some(now),
        reset_credits: None,
    };
    h.app.pool.observe(claude, limits, now);
    let (status, usage) = api_call(&h, claude, "GET", CLAUDE_USAGE, None).await;
    assert_eq!(status, 200);
    assert_eq!(usage["five_hour"]["utilization"], 30.0);
    assert_eq!(usage["five_hour"]["resets_at"], resets.to_string());
    assert_eq!(usage["seven_day"], Value::Null);
    assert_eq!(usage["limits"][0]["kind"], "weekly_scoped");
    assert_eq!(usage["limits"][0]["percent"], 58.0);
    assert_eq!(
        usage["limits"][0]["scope"]["model"]["display_name"],
        "Fable"
    );

    observe(&h, codex, "5h", 40.0);
    let (status, usage) = api_call(&h, codex, "GET", CODEX_USAGE, None).await;
    assert_eq!(status, 200);
    let primary = &usage["rate_limit"]["primary_window"];
    assert_eq!(primary["used_percent"], 40.0);
    assert_eq!(primary["limit_window_seconds"], 18_000);
    assert!(primary["reset_at"].is_i64());
    assert_eq!(usage["rate_limit"]["secondary_window"], Value::Null);
    assert!(paths(&h).is_empty(), "usage reads stay inside slopmax");

    // Reset credits are listed by ChatGPT, then reused for a few minutes,
    // since tools ask on every refresh.
    let (status, list) = api_call(&h, codex, "GET", CREDITS, None).await;
    assert_eq!(status, 200);
    let credit = &list["credits"][0];
    assert_eq!(credit["id"], "credit-later");
    assert_eq!(credit["status"], "available");
    assert_eq!(credit["reset_type"], "codex_rate_limits");
    assert!(credit["expires_at"].is_string());
    api_call(&h, codex, "GET", CREDITS, None).await;
    assert_eq!(paths(&h), ["/wham/rate-limit-reset-credits"]);

    let data = json!({ "redeem_request_id": "0b1c2d3e-0000-5000-8000-000000000000", "credit_id": "credit-later" });
    let (status, consumed) = api_call(&h, codex, "POST", CONSUME, Some(data)).await;
    assert_eq!(status, 200);
    assert_eq!(consumed["code"], "reset");
    let sent = h.log.lock().unwrap().last().cloned().unwrap();
    assert_eq!(sent.path, "/wham/rate-limit-reset-credits/consume");
    let sent: Value = serde_json::from_slice(&sent.body).unwrap();
    assert_eq!(sent["credit_id"], "credit-later");

    // reset-quota lifts slopmax's blocks and reads the usage again.
    let later = Timestamp::now() + SignedDuration::from_hours(1);
    h.app.pool.block(codex, later, None, "spent");
    let reply: Value = management("reset-quota")
        .json(&json!({ "auth_index": codex }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reply["status"], "ok");
    assert_eq!(reply["auth_index"], codex);
    assert!(h.app.pool.state(codex).blocked_until.is_none());
    eventually(|| {
        let state = h.app.pool.state(codex);
        state.limits.windows.iter().any(|w| w.used == 5.0)
    })
    .await;

    // Nothing else goes out with an account's token.
    for (index, url) in [
        (codex, "https://example.com/collect"),
        (codex, CLAUDE_USAGE),
        (claude, CODEX_USAGE),
        (claude, "https://api.anthropic.com/v1/messages"),
    ] {
        let call = json!({ "auth_index": index, "method": "GET", "url": url,
                           "header": { "Authorization": "Bearer $TOKEN$" } });
        let refused = management("api-call").json(&call).send().await.unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN, "{url}");
    }
    let call = json!({ "auth_index": "codex-nope", "method": "GET", "url": CODEX_USAGE });
    let unknown = management("api-call").json(&call).send().await.unwrap();
    assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
    assert!(
        paths(&h).iter().all(|p| p.starts_with("/wham/")),
        "{:?}",
        paths(&h)
    );

    // slopmax's own status carries the same pool view in one call.
    let report: Value = client()
        .get(format!("{}/slopmax/status", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pool = |provider: &str| {
        report["pools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["provider"] == provider)
            .cloned()
            .unwrap()
    };
    assert_eq!(pool("claude")["accounts"], 1);
    assert_eq!(pool("claude")["windows"][0]["span"], "5h");
    assert_eq!(pool("claude")["windows"][0]["used"], 30.0);
    assert_eq!(pool("codex")["accounts"], 1);
}

/// A Codex request in `session`, with whatever else `extra` adds.
fn codex_in(h: &Harness, session: &str) -> RequestBuilder {
    client()
        .post(format!("{}/codex/responses", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("session-id", session)
        .header("user-agent", "codex_exec/0.159.3 (Linux; x86_64)")
        .header("content-type", "application/json")
        .body(r#"{"model":"gpt-6-sol","input":[],"stream":true}"#)
}

/// The Codex requests the mock has seen, leaving out what slopmax asks
/// for itself in the background.
fn responses(h: &Harness) -> Vec<Seen> {
    h.log
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.path == "/codex/responses")
        .cloned()
        .collect()
}

/// Sends `request` and returns the workspace of the account that answered.
async fn served_by(h: &Harness, request: RequestBuilder) -> String {
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), 200);
    response.text().await.unwrap();
    let seen = responses(h);
    let last = seen.last().unwrap();
    last.headers["chatgpt-account-id"]
        .to_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn sessions_keep_their_account_so_the_prompt_cache_stays_warm() {
    let h = harness_with(ProviderId::Codex, &["tok-ok", "tok-ok", "tok-ok"], |c| {
        c.strategy = Strategy::RoundRobin;
    })
    .await;
    // New sessions take turns; each then keeps its account.
    let a = served_by(&h, codex_in(&h, "a")).await;
    let b = served_by(&h, codex_in(&h, "b")).await;
    let c = served_by(&h, codex_in(&h, "c")).await;
    assert_eq!(
        [&*a, &*b, &*c],
        ["acct-codex0", "acct-codex1", "acct-codex2"]
    );
    for _ in 0..3 {
        assert_eq!(served_by(&h, codex_in(&h, "b")).await, "acct-codex1");
        assert_eq!(served_by(&h, codex_in(&h, "a")).await, "acct-codex0");
    }
    // A fourth session goes to the account handed a request longest ago.
    assert_eq!(served_by(&h, codex_in(&h, "d")).await, "acct-codex2");

    // Once its account is limited the session moves, and it stays on its
    // new account after the old one recovers, rather than lose its cache
    // a second time.
    h.app.pool.block(
        &h.ids[1],
        Timestamp::now() + SignedDuration::from_mins(5),
        None,
        "usage limit reached",
    );
    let moved = served_by(&h, codex_in(&h, "b")).await;
    assert_ne!(moved, "acct-codex1");
    h.app.pool.clear_blocks(&h.ids[1]);
    for _ in 0..3 {
        assert_eq!(served_by(&h, codex_in(&h, "b")).await, moved);
    }
}

#[tokio::test]
async fn affinity_can_be_turned_off_for_the_proxy_or_one_request() {
    let h = harness_with(ProviderId::Codex, &["tok-ok", "tok-ok"], |c| {
        c.strategy = Strategy::RoundRobin;
        c.session_affinity = false;
    })
    .await;
    // Off in the config: one session's requests take turns.
    let turns: Vec<String> = futures_in_order(&h, 4, || codex_in(&h, "s")).await;
    assert_eq!(
        turns,
        ["acct-codex0", "acct-codex1", "acct-codex0", "acct-codex1"]
    );
    // A request may ask to keep its session's account anyway.
    let sticky = || codex_in(&h, "s").header("x-slopmax-affinity", "on");
    let first = served_by(&h, sticky()).await;
    assert_eq!(served_by(&h, sticky()).await, first);
    assert_eq!(served_by(&h, sticky()).await, first);

    // On in the config, a request may still opt out.
    h.app.set_config(Config {
        session_affinity: true,
        ..(*h.app.config()).clone()
    });
    let kept = served_by(&h, codex_in(&h, "t")).await;
    assert_eq!(served_by(&h, codex_in(&h, "t")).await, kept);
    let loose = || codex_in(&h, "t").header("x-slopmax-affinity", "off");
    let spread = [served_by(&h, loose()).await, served_by(&h, loose()).await];
    assert_ne!(spread[0], spread[1], "placed afresh each time: {spread:?}");

    // slopmax's own headers never reach the provider.
    let seen = responses(&h);
    assert!(
        seen.iter()
            .all(|s| !s.headers.contains_key("x-slopmax-affinity"))
    );
}

/// `n` requests made one after another, and who served each.
async fn futures_in_order(
    h: &Harness,
    n: usize,
    request: impl Fn() -> RequestBuilder,
) -> Vec<String> {
    let mut served = Vec::new();
    for _ in 0..n {
        served.push(served_by(h, request()).await);
    }
    served
}

#[tokio::test]
async fn moving_without_affinity_still_drops_another_accounts_state() {
    let h = harness_with(ProviderId::Codex, &["tok-ok", "tok-ok"], |c| {
        c.strategy = Strategy::RoundRobin;
        c.session_affinity = false;
    })
    .await;
    let body = r#"{"model":"gpt-6-sol","previous_response_id":"resp-1","input":[],"stream":true}"#;
    let request = || codex_in(&h, "s").body(body);
    served_by(&h, request()).await;
    served_by(&h, request()).await;
    let seen = responses(&h);
    // The first request had no account before it, so went as sent; the
    // second landed on another account, so lost what the first minted.
    assert!(String::from_utf8_lossy(&seen[0].body).contains("previous_response_id"));
    assert!(!String::from_utf8_lossy(&seen[1].body).contains("previous_response_id"));
}

#[tokio::test]
async fn passing_server_errors_are_retried_once_on_the_same_account() {
    let h = harness(ProviderId::Codex, &["tok-flaky", "tok-ok"]).await;
    // The first try fails with a 503; the second, on the same account,
    // answers. The session's account never changes.
    assert_eq!(served_by(&h, codex_in(&h, "s")).await, "acct-codex0");
    let tokens: Vec<String> = responses(&h)
        .iter()
        .map(|s| s.headers["authorization"].to_str().unwrap().to_owned())
        .collect();
    assert_eq!(tokens, ["Bearer tok-flaky", "Bearer tok-flaky"]);
    assert!(h.app.pool.state(&h.ids[0]).blocked_until.is_none());

    // An error that persists moves the request to the next account,
    // which is not set aside for it.
    let h = harness(ProviderId::Codex, &["tok-down", "tok-ok"]).await;
    assert_eq!(served_by(&h, codex_in(&h, "s")).await, "acct-codex1");
    assert_eq!(
        responses(&h).len(),
        3,
        "twice on the first, once on the next"
    );
    assert!(!h.app.pool.state(&h.ids[0]).is_blocked(Timestamp::now()));
    assert!(h.app.pool.state(&h.ids[0]).throttled_until.is_none());

    // When every account answers so, the client gets the error.
    let h = harness(ProviderId::Codex, &["tok-down", "tok-down"]).await;
    let response = codex_in(&h, "s").send().await.unwrap();
    assert_eq!(response.status(), 502);
    assert!(response.text().await.unwrap().contains("bad gateway"));
    assert_eq!(responses(&h).len(), 4);
}

async fn admin(h: &Harness, method: Method, path: &str, form: &str) -> (StatusCode, Value) {
    let url = format!("{}/slopmax/{path}", h.proxy);
    let request = match method {
        Method::GET => client().get(url),
        _ => client()
            .post(url)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form.to_owned()),
    };
    let response = request
        .header("authorization", format!("Bearer {KEY}"))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let text = response.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

#[tokio::test]
async fn settings_change_through_the_api_and_apply_at_once() {
    let h = harness(ProviderId::Codex, &["tok-ok", "tok-ok"]).await;
    let file = h.dir.join("config.toml");
    std::fs::write(
        &file,
        "# mine\napi_key = \"sm-test-key\"\nrefresh_tokens = false\nstrategy = \"fill-first\" # keep\n",
    )
    .unwrap();

    let (status, settings) = admin(&h, Method::GET, "settings", "").await;
    assert_eq!(status, 200);
    assert_eq!(settings["strategy"], "fill-first");
    assert_eq!(settings["session_affinity"], true);
    let ids: Vec<&str> = settings["strategies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        ["reset-first", "fill-first", "least-used", "round-robin"]
    );

    let (status, settings) = admin(
        &h,
        Method::POST,
        "settings",
        "strategy=round-robin&session_affinity=false&redeem_when_exhausted=true",
    )
    .await;
    assert_eq!(status, 200, "{settings}");
    assert_eq!(settings["strategy"], "round-robin");
    assert_eq!(settings["session_affinity"], false);
    // Applied to the next request, without a restart.
    let routing = h.app.pool.routing();
    assert_eq!(routing.strategy, Strategy::RoundRobin);
    assert!(!routing.affinity);
    assert!(h.app.config().redeem_when_exhausted);
    let first = served_by(&h, codex_in(&h, "s")).await;
    assert_ne!(served_by(&h, codex_in(&h, "s")).await, first);
    // Written to config.toml, comments kept.
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("# mine\n"), "{text}");
    assert!(text.contains("strategy = \"round-robin\" # keep"), "{text}");
    assert!(text.contains("session_affinity = false"), "{text}");

    // Nonsense is refused and changes nothing.
    for bad in [
        "strategy=fastest",
        "session_affinity=maybe",
        "listen=0.0.0.0:1",
        "session_ttl_mins=-5",
        "",
    ] {
        let (status, _) = admin(&h, Method::POST, "settings", bad).await;
        assert_eq!(status, 400, "{bad}");
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    assert_eq!(h.app.pool.routing().strategy, Strategy::RoundRobin);

    let (status, settings) = admin(&h, Method::POST, "settings?session_ttl_mins=15", "").await;
    assert_eq!(
        (status, settings["session_ttl_mins"].as_u64()),
        (StatusCode::OK, Some(15))
    );
    assert_eq!(
        h.app.pool.routing().session_ttl,
        SignedDuration::from_mins(15)
    );
}

#[tokio::test]
async fn a_changed_config_file_applies_without_a_restart() {
    let h = harness(ProviderId::Codex, &["tok-ok"]).await;
    let file = h.dir.join("config.toml");
    std::fs::write(
        &file,
        "api_key = \"sm-other\"\nrefresh_tokens = false\nstrategy = \"least-used\"\nsession_affinity = false\nlisten = \"0.0.0.0:1\"\n",
    )
    .unwrap();
    h.app.reload_config();
    let config = h.app.config();
    assert_eq!(config.strategy, Strategy::LeastUsed);
    assert!(!h.app.pool.routing().affinity);
    assert_eq!(config.api_key, "sm-other", "a new key applies too");
    assert_ne!(config.listen.port(), 1, "the address is bound at start");

    // A broken file leaves the last good config in place.
    std::fs::write(&file, "strategy = \"warp-speed\"\n").unwrap();
    h.app.reload_config();
    assert_eq!(h.app.config().strategy, Strategy::LeastUsed);
}

#[tokio::test]
async fn the_history_api_charts_what_went_through() {
    let h = harness(ProviderId::Codex, &["tok-limited", "tok-ok"]).await;
    served_by(&h, codex_in(&h, "s")).await;
    served_by(&h, codex_in(&h, "s")).await;
    // Both answers reach the ledger before it is read.
    let since = Timestamp::now() - SignedDuration::from_mins(1);
    eventually(|| ledger::read(&h.dir.join("usage"), since).len() == 2).await;

    let (status, history) = admin(&h, Method::GET, "history?range=today", "").await;
    assert_eq!(status, 200);
    assert_eq!(history["range"], "today");
    assert_eq!(history["total"]["requests"], 2);
    assert_eq!(history["rescued"], 1, "the first answer needed failover");
    // An hour each, from midnight to now.
    assert!(!history["buckets"].as_array().unwrap().is_empty());
    let accounts = history["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0]["name"], "codex1@example.com");
    assert_eq!(accounts[0]["totals"]["requests"], 2);
    // GPT-6 Sol has a list price: 2 answers of 40 fresh, 60 cached, 7 out.
    let cost = history["total"]["cost"].as_f64().unwrap();
    let expected = 2.0 * (40.0 * 2.0 + 60.0 * 0.2 + 7.0 * 10.0) / 1e6;
    assert!((cost - expected).abs() < 1e-9, "{cost} vs {expected}");

    let (status, _) = admin(&h, Method::GET, "history?range=forever", "").await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn history_is_kept_by_the_hour_after_the_first_read() {
    let h = harness(ProviderId::Codex, &["tok-ok"]).await;
    served_by(&h, codex_in(&h, "s")).await;
    let since = Timestamp::now() - SignedDuration::from_mins(1);
    eventually(|| ledger::read(&h.dir.join("usage"), since).len() == 1).await;
    let (_, history) = admin(&h, Method::GET, "history?range=today", "").await;
    assert_eq!(history["total"]["requests"], 1);
    assert!(h.app.hours.is_ready());

    // From now on the files are not read: what settles is counted as it
    // does, so the history holds it even with the ledger gone.
    std::fs::remove_dir_all(h.dir.join("usage")).unwrap();
    served_by(&h, codex_in(&h, "t")).await;
    let (_, history) = admin(&h, Method::GET, "history?range=today", "").await;
    assert_eq!(history["total"]["requests"], 2);
    assert_eq!(history["sessions"], 2);
    let (_, week) = admin(&h, Method::GET, "history?range=7d", "").await;
    assert_eq!(week["total"]["requests"], 2);
}

#[tokio::test]
async fn history_says_what_resets_left_on_the_table() {
    let h = harness(ProviderId::Codex, &["tok-ok"]).await;
    let ended = Timestamp::now() - SignedDuration::from_hours(1);
    let record = |span: &str, used: f64| slopmax_core::waste::Record {
        ended_at: ended,
        account: h.ids[0].clone(),
        provider: ProviderId::Codex,
        plan: Some("pro".into()),
        span: span.into(),
        model: None,
        used,
    };
    let file = h.dir.join("windows.jsonl");
    slopmax_core::waste::append(&file, &[record("7d", 25.0), record("5h", 0.0)]).unwrap();

    let (status, history) = admin(&h, Method::GET, "history?range=7d", "").await;
    assert_eq!(status, 200);
    let left = &history["left"];
    assert_eq!(left["windows"], 1, "the weeks alone");
    assert_eq!(left["unused"], 75.0);
    // ChatGPT Pro at $200 a month: three quarters of a week's share.
    let dollars = left["dollars"].as_f64().unwrap();
    assert!(
        (dollars - 200.0 * 12.0 / 52.0 * 0.75).abs() < 1e-6,
        "{dollars}"
    );
    assert_eq!(left["accounts"][0]["name"], "codex0@example.com");
}

#[tokio::test]
async fn the_api_does_what_the_cli_does_for_keys_endpoints_and_the_doctor() {
    let mut base = String::new();
    let h = harness_of(
        |url| {
            base = url.to_owned();
            vec![account(ProviderId::Codex, "codex0", "tok-ok", 1000)]
        },
        |_| {},
    )
    .await;
    std::fs::write(
        h.dir.join("config.toml"),
        format!("api_key = \"{KEY}\"\nrefresh_tokens = false\n"),
    )
    .unwrap();

    // A key for another machine, held to some models: shown once, then
    // listed by name, and it works at once.
    let (status, made) = admin(&h, Method::POST, "keys", "name=laptop&models=gpt-6-*").await;
    assert_eq!(status, 200, "{made}");
    let key = made["key"].as_str().unwrap().to_owned();
    assert!(key.starts_with("sm-"));
    let (_, listed) = admin(&h, Method::GET, "keys", "").await;
    assert_eq!(listed["keys"][0]["name"], "laptop");
    assert_eq!(listed["keys"][0]["models"][0], "gpt-6-*");
    assert!(listed.get("key").is_none() && listed["keys"][0].get("key").is_none());
    let used = client()
        .post(format!("{}/codex/responses", h.proxy))
        .header("authorization", format!("Bearer {key}"))
        .body(r#"{"model":"gpt-6-sol","input":[],"stream":true}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(used.status(), StatusCode::OK);
    let (status, _) = admin(&h, Method::POST, "keys", "name=laptop").await;
    assert_eq!(status, 400, "names are unique");
    let (status, listed) = admin(&h, Method::POST, "keys/laptop/remove", "").await;
    assert_eq!(status, 200);
    assert!(listed["keys"].as_array().unwrap().is_empty());
    let (status, _) = admin(&h, Method::POST, "keys/laptop/remove", "").await;
    assert_eq!(status, 404);
    // A name with spaces or slashes is revoked by its encoded name.
    let (status, _) = admin(&h, Method::POST, "keys", "name=work%20laptop%2F2").await;
    assert_eq!(status, 200);
    let (status, _) = admin(&h, Method::POST, "keys/work%20laptop%2F2/remove", "").await;
    assert_eq!(status, 200);

    // A compatible endpoint, as `slopmax login compat --url` adds it.
    let form = format!("provider=compat&url={base}/local/v1&models=qwen3-*&label=box");
    let (status, report) = admin(&h, Method::POST, "accounts", &form).await;
    assert_eq!(status, 200, "{report}");
    let added = report["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["provider"] == "compat")
        .expect("listed");
    assert_eq!(added["name"], "box");
    let answered = chat_request(&h, "qwen3-coder").send().await.unwrap();
    assert_eq!(answered.status(), StatusCode::OK);
    // Subscriptions sign in with a browser, not through the API.
    let (status, refused) = admin(&h, Method::POST, "accounts", "provider=claude").await;
    assert_eq!(status, 400);
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("browser")
    );
    let (status, _) = admin(&h, Method::POST, "accounts", "provider=compat").await;
    assert_eq!(status, 400, "an endpoint needs its url");

    // An imported account can be made to refresh here.
    h.app
        .store
        .update(&h.ids[0], |a| {
            a.link = Some(slopmax_core::account::Link {
                tool: "CLIProxyAPI".into(),
                path: h.dir.join("elsewhere.json"),
            })
        })
        .unwrap();
    let path = format!("accounts/{}/own", h.ids[0]);
    let (status, _) = admin(&h, Method::POST, &path, "").await;
    assert_eq!(status, 200);
    assert!(h.app.store.get(&h.ids[0]).unwrap().unwrap().link.is_none());

    // The doctor's findings, as `slopmax doctor` prints them.
    let (status, sections) = admin(&h, Method::GET, "doctor", "").await;
    assert_eq!(status, 200);
    let titles: Vec<&str> = sections
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["title"].as_str().unwrap())
        .collect();
    assert!(titles.contains(&"Accounts"), "{titles:?}");
    assert!(sections[0]["findings"][0]["level"].is_string());
}

#[tokio::test]
async fn the_web_ui_is_served_compressed_cached_and_locked_down() {
    let h = harness(ProviderId::Claude, &["tok-ok"]).await;
    let get = |path: &str, etag: Option<&str>| {
        let mut request = client()
            .get(format!("{}{path}", h.proxy))
            .header("accept-encoding", "gzip");
        if let Some(etag) = etag {
            request = request.header("if-none-match", etag);
        }
        request.send()
    };
    // The page needs no key: it carries none of the data.
    let page = get("/slopmax/", None).await.unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert!(
        page.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    let csp = page.headers()["content-security-policy"].to_str().unwrap();
    assert!(csp.contains("default-src 'none'") && csp.contains("frame-ancestors 'none'"));
    assert_eq!(page.headers()["x-content-type-options"], "nosniff");
    if page.headers().get("content-encoding").is_some() {
        // Built with the UI: sent gzip, and a reload costs a 304.
        assert_eq!(page.headers()["content-encoding"], "gzip");
        assert_eq!(page.headers()["cache-control"], "no-cache");
        let etag = page.headers()["etag"].to_str().unwrap().to_owned();
        let again = get("/slopmax/", Some(&etag)).await.unwrap();
        assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
        let plain = client()
            .get(format!("{}/slopmax/", h.proxy))
            .header("accept-encoding", "identity")
            .send()
            .await
            .unwrap();
        assert_eq!(plain.status(), StatusCode::NOT_ACCEPTABLE);
    }
    // The old dashboard's address, and the bare prefix, lead to the page.
    for old in ["/slopmax", "/slopmax/dashboard"] {
        let moved = get(old, None).await.unwrap();
        assert_eq!(moved.status(), StatusCode::PERMANENT_REDIRECT, "{old}");
        assert_eq!(moved.headers()["location"], "/slopmax/");
    }
    // The endpoints beside it still need the key.
    assert_eq!(
        get("/slopmax/status", None).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn callers_refreshing_at_once_share_one_poll() {
    let h = harness(ProviderId::Codex, &["tok-slow-poll"]).await;
    let refresh = || {
        client()
            .post(format!("{}/slopmax/api/refresh", h.proxy))
            .header("authorization", format!("Bearer {KEY}"))
            .send()
    };
    let (a, b, c) = tokio::join!(refresh(), refresh(), refresh());
    for answer in [a, b, c] {
        assert_eq!(answer.unwrap().status(), StatusCode::OK);
    }
    let polls = h
        .log
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.path.starts_with("/wham/usage"))
        .count();
    assert_eq!(polls, 1);
}

#[tokio::test]
async fn the_client_crate_drives_the_daemon_and_follows_its_events() {
    use slopmax_client::api::events::Event;
    use slopmax_client::api::ledger::HistoryRange;
    use slopmax_client::api::requests::{AccountPatch, MakeKey};
    use slopmax_client::api::settings::LivePatch;
    let h = harness(ProviderId::Claude, &["tok-a", "tok-b"]).await;
    // As `slopmax init` leaves it; settings and keys are written into it.
    std::fs::write(
        h.dir.join("config.toml"),
        format!("api_key = \"{KEY}\"\nrefresh_tokens = false\n"),
    )
    .unwrap();
    let client = slopmax_client::Client::new(h.proxy.clone(), KEY);
    assert!(client.health().await.is_some());

    let mut events = client.events().await.unwrap();
    let Some(Ok(Event::Hello { .. })) = events.next().await else {
        panic!("the stream opens with Hello");
    };
    let Some(Ok(Event::Status { report })) = events.next().await else {
        panic!("then the report");
    };
    assert_eq!(report.accounts.len(), 2);

    let second = h.ids[1].clone();
    let report = client.pin(&second).await.unwrap();
    assert!(report.accounts.iter().any(|a| a.id == second && a.pinned));
    let patch = AccountPatch {
        label: Some(Some("work".into())),
        priority: Some(3),
        ..AccountPatch::default()
    };
    let report = client.update_account(&second, &patch).await.unwrap();
    let account = report.accounts.iter().find(|a| a.id == second).unwrap();
    assert_eq!((account.name.as_str(), account.priority), ("work", 3));
    let report = client.unpin_all().await.unwrap();
    assert!(report.accounts.iter().all(|a| !a.pinned));

    // A change made through the API is pushed to whoever follows.
    let pushed = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.next().await {
            if let Ok(Event::Status { report }) = event
                && report.accounts.iter().any(|a| a.name == "work")
            {
                return true;
            }
        }
        false
    })
    .await;
    assert_eq!(pushed, Ok(true));

    let patch = LivePatch {
        session_minutes: Some(45),
        ..LivePatch::default()
    };
    let view = client.change_settings(&patch).await.unwrap();
    assert_eq!(view.settings.live.session_minutes, 45);
    let made = client
        .make_key(&MakeKey {
            name: "laptop".into(),
            models: Vec::new(),
        })
        .await
        .unwrap();
    assert!(made.key.starts_with("sm-"), "{}", made.key);
    let keys = client.remove_key("laptop").await.unwrap();
    assert!(keys.iter().all(|k| k.name != "laptop"));
    let history = client.history(HistoryRange::Today).await.unwrap();
    assert_eq!(history.total.requests, 0);

    // The daemon's own refusals come back typed.
    let missing = client.pin("claude-nope").await.unwrap_err();
    assert!(
        matches!(
            missing,
            slopmax_client::Error::Api(slopmax_client::api::ApiError::NotFound { .. })
        ),
        "{missing:?}"
    );
    let wrong = slopmax_client::Client::new(h.proxy.clone(), "sm-wrong");
    assert!(matches!(
        wrong.status().await.unwrap_err(),
        slopmax_client::Error::Api(slopmax_client::api::ApiError::Unauthorized { .. })
    ));
}

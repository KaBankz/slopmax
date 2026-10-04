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
use slopmax::account::{Account, Endpoint, Store, Tokens};
use slopmax::config::{Config, Strategy};
use slopmax::ledger;
use slopmax::limits::{Limits, Window};
use slopmax::net::body;
use slopmax::net::client::RequestBuilder;
use slopmax::net::server::{self, Request, Response};
use slopmax::net::{Client, Origins, ws};
use slopmax::paths::Home;
use slopmax::pool::State as PoolState;
use slopmax::provider::ProviderId;
use slopmax::proxy::{self, App};
use slopmax::time::{SignedDuration, Timestamp};
use slopmax::wire::Dialect;
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
        "Bearer tok-ok" | "Bearer tok-credit" => reply(
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

/// `tok-expiring` holds a credit that lapses within the hour; every other
/// account's credits last for days.
fn mock_credits(headers: &HeaderMap) -> Response {
    let expires = |hours| (Timestamp::now() + SignedDuration::from_hours(hours)).to_string();
    let mut credits =
        vec![json!({ "id": "credit-later", "status": "available", "expires_at": expires(48) })];
    if headers["authorization"] == "Bearer tok-expiring" {
        credits
            .push(json!({ "id": "credit-soon", "status": "available", "expires_at": expires(1) }));
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
        slopmax::ids::token()
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
    app.pool.sync(app.store.list().unwrap(), Default::default());
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
    slopmax::daemon::redeem_expiring(&h.app).await;

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
        .get(format!("{}/slopmax/dashboard", h.proxy))
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
    // Pins live in this proxy's own home, not the user's.
    assert!(h.dir.join("pins.json").exists());
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
    use slopmax::config::ClientKey;

    let h = harness_with(ProviderId::Codex, &["tok-ok"], |config| {
        config.keys.push(ClientKey {
            name: "laptop".into(),
            key: "sm-laptop".into(),
            models: vec!["gpt-6-*".into()],
        });
    })
    .await;
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
    slopmax::proxy::warm::idle_accounts(&h.app).await;
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

    slopmax::proxy::warm::idle_accounts(&h.app).await;
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
    slopmax::proxy::warm::idle_accounts(&h.app).await;
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

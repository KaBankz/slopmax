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
use slopmax::account::{Account, Store, Tokens};
use slopmax::config::{Config, Strategy};
use slopmax::limits::{Limits, Window};
use slopmax::net::body;
use slopmax::net::client::RequestBuilder;
use slopmax::net::server::{self, Request, Response};
use slopmax::net::{Client, Origins};
use slopmax::pool::State as PoolState;
use slopmax::provider::ProviderId;
use slopmax::proxy::{self, App};
use slopmax::time::{SignedDuration, Timestamp};
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
async fn mock(log: Log, request: Request) -> Response {
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
        (Method::POST, "/wham/rate-limit-reset-credits/consume") => {
            reply(StatusCode::OK, &[], json!({ "code": "reset" }).to_string())
        }
        _ => reply(StatusCode::NOT_FOUND, &[], ""),
    }
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
    let dir = std::env::temp_dir().join(format!(
        "slopmax-it-{}-{}",
        std::process::id(),
        slopmax::ids::token()
    ));
    let store = Store::at(dir.join("accounts"));
    let mut ids = Vec::new();
    for (i, token) in tokens.iter().enumerate() {
        let name = format!("{}{i}", provider.as_str());
        let (saved, _) = store
            .upsert(account(provider, &name, token, 1000 + i as i64))
            .unwrap();
        ids.push(saved.id);
    }

    let log: Log = Arc::default();
    let upstream_url = serve({
        let log = log.clone();
        move |request| mock(log.clone(), request)
    })
    .await;

    let mut config = Config {
        api_key: KEY.into(),
        strategy: Strategy::FillFirst,
        refresh_tokens: false,
        ..Config::default()
    };
    configure(&mut config);
    let origins = Origins::new([
        ("https://api.anthropic.com", upstream_url.as_str()),
        ("https://chatgpt.com/backend-api", upstream_url.as_str()),
    ]);
    let app = App::new(config, store, PoolState::default(), origins);
    app.pool.sync(app.store.list().unwrap(), Default::default());
    let proxy = serve({
        let app = app.clone();
        move |request| proxy::handle(app.clone(), request)
    })
    .await;
    Harness {
        proxy,
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
async fn websocket_handshakes_are_refused_so_codex_uses_http() {
    let h = harness(ProviderId::Codex, &["tok-ok"]).await;
    let response = client()
        .get(format!("{}/v1/responses", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 426);
    assert!(h.log.lock().unwrap().is_empty());
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
